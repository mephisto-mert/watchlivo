import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

import {
  buildEdgeAudioTracks,
  applyMasterAudioPreference,
  adaptMasterM3u8Variants,
  handleEdgeHlsManifest,
  handleEdgeStreamProxy,
  handleEdgeSubtitle,
  isCorruptOrForeignSubtitleText,
  formatStreamSubTracks,
  signProxySig,
} from "../workers/ha-gateway/edge_streams.js";

import {
  detectM3u8AudioLangs,
  extractDiziyouNet,
  resolveTurkishCatalogStream,
} from "../workers/ha-gateway/edge_extractors.js";

import { handleAutonomousEdge } from "../workers/ha-gateway/edge_autonomous.js";
import { SubtitleDubController, parseVtt } from "../static/js/players/subtitles.js";

const TEST_ENV = {
  PROXY_SECRET: "test-v231-signing-secret-key-987654",
};

function createMockKv() {
  const store = new Map();
  return {
    async get(k, type) {
      if (!store.has(k)) return null;
      const v = store.get(k);
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(k, v) {
      store.set(k, typeof v === "string" ? v : JSON.stringify(v));
    },
    async delete(k) {
      store.delete(k);
    },
  };
}

test("v231: detectM3u8AudioLangs and buildEdgeAudioTracks cover Dual, Split-Server (Odyssey), and Turkish-native titles", () => {
  const gotMaster = [
    "#EXTM3U",
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Turkish",LANGUAGE="tr",DEFAULT=YES,AUTOSELECT=YES,URI="aud_tr.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="aud_en.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-lo",NAME="Turkish",LANGUAGE="tr",DEFAULT=YES,AUTOSELECT=YES,URI="aud_tr_lo.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-lo",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="aud_en_lo.m3u8"',
  ].join("\n");
  const det = detectM3u8AudioLangs(gotMaster);
  assert.equal(det.hasTr, true);
  assert.equal(det.hasOrig, true);
  assert.deepEqual(det.langs, ["tr", "en"]);

  // Single Dual server -> tr-dub (?aud=tr) + orig (?aud=orig)
  const dualTracks = buildEdgeAudioTracks(
    [{ id: "srv-1", label: "📡 DiziLife · Türkçe Dublaj + Orijinal (1080p HLS)", url: "/api/rave/stream?sid=abc&ext=.m3u8", audioLangs: ["tr", "en"] }],
    "/api/rave/stream?sid=abc&ext=.m3u8",
    "en"
  );
  assert.equal(dualTracks.length, 2);
  assert.equal(dualTracks[0].id, "tr-dub");
  assert.ok(dualTracks[0].url.includes("aud=tr"));
  assert.equal(dualTracks[1].id, "orig");
  assert.ok(dualTracks[1].url.includes("aud=orig"));

  // Split servers (SinemaCC EN-only + Webteizle TR-dub) -> both tracks exposed with distinct URLs
  const splitTracks = buildEdgeAudioTracks(
    [
      { id: "srv-1", label: "📡 SinemaCC · Orijinal / Altyazılı (1080p HLS)", url: "/api/rave/stream?sid=sc1&ext=.m3u8", audioLangs: ["orig"] },
      { id: "srv-2", label: "📡 Webteizle · Türkçe Dublaj · FileMoon", url: "/api/rave/stream?sid=wt1&ext=.m3u8", audioLangs: ["tr"] },
    ],
    "/api/rave/stream?sid=sc1&ext=.m3u8",
    "en"
  );
  assert.equal(splitTracks.length, 2);
  assert.equal(splitTracks[0].id, "tr-dub");
  assert.ok(splitTracks[0].url.includes("sid=wt1"));
  assert.equal(splitTracks[1].id, "orig");
  assert.ok(splitTracks[1].url.includes("sid=sc1"));

  // Native Turkish title -> tr-orig without bogus orig duplicate
  const trNativeTracks = buildEdgeAudioTracks(
    [{ id: "srv-1", label: "📡 SinemaCC · Türkçe (1080p HLS)", url: "/api/rave/stream?sid=tr1&ext=.m3u8", audioLangs: ["tr"] }],
    "/api/rave/stream?sid=tr1&ext=.m3u8",
    "tr"
  );
  assert.equal(trNativeTracks.length, 1);
  assert.equal(trNativeTracks[0].id, "tr-orig");
});

test("v231: applyMasterAudioPreference rewrites DEFAULT=YES per GROUP-ID and adaptMasterM3u8Variants prunes orphan GoT audio group", () => {
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:4",
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Turkish",LANGUAGE="tr",DEFAULT=NO,AUTOSELECT=YES,URI="/a_tr.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="/a_en.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-lo",NAME="Turkish",LANGUAGE="tr",DEFAULT=NO,AUTOSELECT=YES,URI="/al_tr.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-lo",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="/al_en.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=3500000,RESOLUTION=1920x1080,AUDIO="audio"',
    "/v1080.m3u8",
    '#EXT-X-STREAM-INF:BANDWIDTH=850000,RESOLUTION=854x480,AUDIO="audio-lo"',
    "/v480.m3u8",
  ];

  const trOut = applyMasterAudioPreference(lines, "tr");
  assert.ok(trOut.find((l) => l.includes('GROUP-ID="audio"') && l.includes('LANGUAGE="tr"')).includes("DEFAULT=YES"));
  assert.ok(trOut.find((l) => l.includes('GROUP-ID="audio"') && l.includes('LANGUAGE="en"')).includes("DEFAULT=NO"));
  assert.ok(trOut.find((l) => l.includes('GROUP-ID="audio-lo"') && l.includes('LANGUAGE="tr"')).includes("DEFAULT=YES"));

  const origOut = applyMasterAudioPreference(lines, "orig");
  assert.ok(origOut.find((l) => l.includes('GROUP-ID="audio"') && l.includes('LANGUAGE="en"')).includes("DEFAULT=YES"));
  assert.ok(origOut.find((l) => l.includes('GROUP-ID="audio"') && l.includes('LANGUAGE="tr"')).includes("DEFAULT=NO"));
  assert.ok(origOut.find((l) => l.includes('GROUP-ID="audio-lo"') && l.includes('LANGUAGE="en"')).includes("DEFAULT=YES"));

  // Deterministic default when audParam is empty and all renditions had DEFAULT=NO
  const defOut = applyMasterAudioPreference(lines, "");
  const audioGroupDefaults = defOut.filter((l) => l.includes('GROUP-ID="audio"') && l.includes("DEFAULT=YES"));
  assert.equal(audioGroupDefaults.length, 1);

  // Under maxHeight=480, orphan GROUP-ID="audio" is pruned while GROUP-ID="audio-lo" is preserved
  const adapted = adaptMasterM3u8Variants(origOut, { maxHeight: 480, lowStart: true });
  const adLines = String(adapted?.body || "").split("\n");
  assert.equal(adLines.some((l) => l.includes('GROUP-ID="audio"')), false);
  assert.equal(adLines.some((l) => l.includes('GROUP-ID="audio-lo"')), true);
  assert.equal(adLines.some((l) => l.includes("/v480.m3u8")), true);
  assert.equal(adLines.some((l) => l.includes("/v1080.m3u8")), false);
});

test("v231: handleEdgeHlsManifest applies ?aud=, rewrites direct .vtt subtitle URIs, drops invalid MEDIA lines, and proxy allows AES-128 .key", async () => {
  const origFetch = globalThis.fetch;
  try {
    const masterUrl = "https://cdn.example.com/got/master.m3u8";
    const keyUrl = "https://cdn.example.com/got/enc.key";
    globalThis.fetch = async (input) => {
      const u = typeof input === "string" ? input : input.url;
      if (u === masterUrl) {
        return new Response(
          [
            "#EXTM3U",
            '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Türkçe",LANGUAGE="tr",DEFAULT=YES,AUTOSELECT=YES,URI="tr.m3u8"',
            '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="en.m3u8"',
            '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Turkish",LANGUAGE="tr",URI="https://cdn.example.com/got/tr.vtt"',
            '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Bad",LANGUAGE="xx",URI="http://127.0.0.1/ssrf.vtt"',
            '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO="aud"',
            "720.m3u8",
          ].join("\n"),
          { status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl" } }
        );
      }
      if (u === keyUrl) {
        return new Response(new Uint8Array(16).fill(0x42), {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }
      return new Response("Not Found", { status: 404 });
    };

    const sigMaster = await signProxySig(masterUrl, "", TEST_ENV);
    const resOrig = await handleEdgeHlsManifest(
      new URL(`https://watchlivo.online/api/rave/stream?url=${encodeURIComponent(masterUrl)}&sig=${sigMaster}&aud=orig`),
      TEST_ENV
    );
    assert.equal(resOrig.status, 200);
    const txtOrig = await resOrig.text();
    assert.ok(txtOrig.includes('LANGUAGE="en",DEFAULT=YES'));
    assert.ok(txtOrig.includes('LANGUAGE="tr",DEFAULT=NO'));
    assert.ok(txtOrig.includes("/api/rave/subtitle.vtt?url="), "Direct .vtt subtitle should route through subtitle.vtt");
    assert.equal(txtOrig.includes("#blocked"), false, "Blocked #EXT-X-MEDIA must be dropped cleanly");

    // AES-128 key delivered as text/plain must pass through handleEdgeStreamProxy with 200
    const sigKey = await signProxySig(keyUrl, "", TEST_ENV);
    const reqKey = new Request(`https://watchlivo.online/api/rave/stream-proxy?url=${encodeURIComponent(keyUrl)}&sig=${sigKey}`);
    const resKey = await handleEdgeStreamProxy(reqKey, new URL(reqKey.url), TEST_ENV);
    assert.equal(resKey.status, 200);
    const keyBuf = new Uint8Array(await resKey.arrayBuffer());
    assert.equal(keyBuf.byteLength, 16);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("v231: extractDiziyouNet parses sub_tr_<hash>.vtt & dual M3U8, and resolveTurkishCatalogStream merges Webteizle TR Dub onto SinemaCC EN-only movie", async () => {
  const dnMaster = [
    "#EXTM3U",
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Turkish",LANGUAGE="tr",DEFAULT=YES,URI="t.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en",DEFAULT=NO,URI="e.m3u8"',
    "#EXT-X-STREAM-INF:BANDWIDTH=1500000\n720.m3u8",
  ].join("\n");

  const mockDnFetch = async (target) => {
    if (target.includes("diziyou.net/bolum/house-of-the-dragon-1-sezon-1-bolum/")) {
      return { resp: new Response(`<title>House of the Dragon 1. Sezon 1. Bölüm</title><iframe src="https://ksdpictures.site/embed/hotd1"></iframe>`, { status: 200 }) };
    }
    if (target === "https://ksdpictures.site/embed/hotd1") {
      return {
        resp: new Response(
          `var hls="https://ksdpictures.site/hls/hotd1/master.m3u8"; var s1="https://ksdpictures.site/subs/sub_tr_a1b2c3.vtt"; var s2="https://ksdpictures.site/subs/sub_en_d4e5f6.vtt";`,
          { status: 200 }
        ),
      };
    }
    if (target === "https://ksdpictures.site/hls/hotd1/master.m3u8") {
      return { resp: new Response(dnMaster, { status: 200 }) };
    }
    return { resp: new Response("Not Found", { status: 404 }) };
  };

  const dnRes = await extractDiziyouNet(
    { title: "House of the Dragon", displayTitle: "House of the Dragon", originalTitle: "House of the Dragon", s: 1, e: 1 },
    mockDnFetch
  );
  assert.ok(dnRes);
  assert.equal(dnRes.subs.length, 2);
  assert.ok(dnRes.subs.some((s) => s.lang === "tr" && s.url.includes("sub_tr_a1b2c3.vtt")));
  assert.ok(dnRes.subs.some((s) => s.lang === "en" && s.url.includes("sub_en_d4e5f6.vtt")));
  assert.deepEqual(dnRes.streams[0].audioLangs, ["tr", "en"]);

  // Odyssey case: direct SinemaCC returns EN-only; resolveTurkishCatalogStream MUST NOT short-circuit and MUST merge Webteizle dil=0 TR Dub
  let sawWebteizleDil0 = false;
  const mockOdysseyFetch = async (target, hdrsOrOpts) => {
    if (target === "https://sinemacc.com/film/odyssey-2026/") {
      const encPlayer = Buffer.from("https://player.filmizle.in/video/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6?lng=orig", "utf8").toString("base64");
      return {
        resp: new Response(
          `<title>The Odyssey (2026)</title><script>var p="${encPlayer}";</script>`,
          { status: 200 }
        ),
      };
    }
    if (target.includes("player.filmizle.in/player/index.php?data=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6")) {
      return { resp: new Response(JSON.stringify({ securedLink: "https://cdn.filmizle.in/odyssey/en_master.m3u8" }), { status: 200 }) };
    }
    if (target.includes("player.filmizle.in/video/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6")) {
      return { resp: new Response(`<html></html>`, { status: 200 }) };
    }
    if (target === "https://cdn.filmizle.in/odyssey/en_master.m3u8") {
      return {
        resp: new Response(
          '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="e.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nv.m3u8\n',
          { status: 200 }
        ),
      };
    }
    if (target.includes("webteizle.info/ajax/arama.asp")) {
      return {
        resp: new Response(
          JSON.stringify({ status: "success", results: { filmler: { results: [{ title: "The Odyssey (2026)", url: "/hakkinda/the-odyssey-2026" }] } } }),
          { status: 200 }
        ),
      };
    }
    if (target === "https://webteizle.info/hakkinda/the-odyssey-2026") {
      return {
        resp: new Response(
          `<a href="/izle/dublaj/the-odyssey-2026">Dublaj</a><a href="/izle/altyazi/the-odyssey-2026">Altyazı</a>`,
          { status: 200 }
        ),
      };
    }
    if (target === "https://webteizle.info/izle/dublaj/the-odyssey-2026") {
      // Deliberately put data-dil="1" BEFORE data-dil="0" to test the exact bug fix!
      return {
        resp: new Response(`<button data-id="777" data-dil="1">Alt</button><button data-id="777" data-dil="0">Dub</button>`, { status: 200 }),
      };
    }
    if (target === "https://webteizle.info/izle/altyazi/the-odyssey-2026") {
      return {
        resp: new Response(`<button data-id="777" data-dil="1" class="active">Alt</button>`, { status: 200 }),
      };
    }
    if (target === "https://webteizle.info/ajax/dataAlternatif3.asp") {
      return { resp: new Response(JSON.stringify({ data: [{ baslik: "VidMoly", id: "901" }] }), { status: 200 }) };
    }
    if (target === "https://webteizle.info/ajax/dataEmbed.asp") {
      return { resp: new Response(`<iframe src="https://vidmoly.biz/embed-odysseydub.html"></iframe>`, { status: 200 }) };
    }
    if (target === "https://vidmoly.biz/embed-odysseydub.html") {
      return { resp: new Response(`<script>file:"https://cdn.sprintcdn.test/odyssey_tr/master.m3u8"</script>`, { status: 200 }) };
    }
    if (target === "https://cdn.sprintcdn.test/odyssey_tr/master.m3u8") {
      return { resp: new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1500000\n720.m3u8\n", { status: 200 }) };
    }
    return { resp: new Response("Not Found", { status: 404 }) };
  };

  // Intercept global fetch used by postWebteizleForm & SinemaCC POST
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input, init) => {
      const u = typeof input === "string" ? input : input.url;
      if (u === "https://webteizle.info/ajax/dataAlternatif3.asp") {
        const bodyStr = String(init?.body || "");
        if (bodyStr.includes("dil=0")) {
          sawWebteizleDil0 = true;
          return new Response(JSON.stringify({ data: [{ baslik: "VidMoly", id: "901" }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      const r = await mockOdysseyFetch(u, init);
      return r.resp;
    };

    const resolved = await resolveTurkishCatalogStream({
      title: "The Odyssey",
      displayTitle: "The Odyssey",
      originalTitle: "The Odyssey",
      sourceUrl: "https://sinemacc.com/film/odyssey-2026/",
      year: "2026",
      mtype: "movie",
      s: 1,
      e: 1,
      fetchPublicFn: mockOdysseyFetch,
    });
    assert.equal(sawWebteizleDil0, true, "Webteizle /izle/dublaj/ must send dil=0 even when HTML lists data-dil=1 first");
    assert.ok(resolved?.streams?.length >= 2);
    assert.ok(resolved.streams.some((s) => s.audioLangs?.includes("tr") && s.url.includes("odyssey_tr")));
    assert.ok(resolved.streams.some((s) => s.audioLangs?.includes("en") && s.url.includes("en_master")));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("v231: /api/rave/subtitles uses OpenSubtitles REST->subs5 bridge, rejects Tamil mojibake, demotes trailer stubs, and handleEdgeSubtitle ungzips", async () => {
  // 1. Corrupt Tamil / replacement char detector
  assert.equal(isCorruptOrForeignSubtitleText("WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n¾¢È¿ÎÉÁ\n00:00:04.000 --> 00:00:06.000\n¾¢È¿ÎÉÁ"), true);
  assert.equal(isCorruptOrForeignSubtitleText("WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nWinter is coming and the night is dark."), false);

  // 2. formatStreamSubTracks drops dead subs.rapidvid.org
  const formatted = formatStreamSubTracks([
    { lang: "tr", url: "https://subs.rapidvid.org/dead.vtt", source: "rapidvid" },
    { lang: "tr", url: "https://ksdpictures.site/sub_tr_live.vtt", source: "diziyou_net" },
  ]);
  assert.equal(formatted.length, 1);
  assert.ok(formatted[0].url.includes("ksdpictures.site"));

  // 3. handleEdgeSubtitle transparently decompresses gzipped SRT
  const origFetch = globalThis.fetch;
  try {
    const sampleSrt = "1\n00:00:01,000 --> 00:00:03,000\nMerhaba dünya, kış geliyor!\n";
    const gzBytes = zlib.gzipSync(Buffer.from(sampleSrt, "utf8"));
    const makeFullSrt = (n, line) =>
      Array.from({ length: n }, (_, i) => `${i + 1}\n00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")},000 --> 00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String((i % 60) + 1).padStart(2, "0")},500\n${line}`).join("\n\n");
    const trailerTrSrt = makeFullSrt(20, "Çok yakında sinemalarda bir fragman.");
    const fullTrSrt = makeFullSrt(120, "Bu gerçekten çok güzel bir sahne değil mi ama neden böyle oldu?");
    const tamilMojibakeSrt = makeFullSrt(60, "¾¢È¿ÎÉÁ ¾¢È¿ÎÉÁ");
    const fullEnSrt = makeFullSrt(120, "The quick brown fox jumps over the lazy dog and this is definitely English.");

    globalThis.fetch = async (input) => {
      const u = typeof input === "string" ? input : input.url;
      if (u === "https://dl.opensubtitles.org/en/download/src-api/vrf-1/filead/12345.gz") {
        return new Response(gzBytes, { status: 200, headers: { "Content-Type": "application/x-gzip" } });
      }
      if (u.includes("api.themoviedb.org/3/movie/603/external_ids")) {
        return new Response(JSON.stringify({ imdb_id: "tt0133093" }), { status: 200 });
      }
      if (u.includes("opensubtitles-v3.strem.io/subtitles/movie/tt0133093.json")) {
        // Stremio returns 1 trailer TR + 1 corrupt Tamil EN -> should trigger REST bridge!
        return new Response(
          JSON.stringify({
            subtitles: [
              { id: "tr-trailer", lang: "tur", url: "https://subs5.strem.io/sub/trailer_tr.srt" },
              { id: "en-corrupt", lang: "eng", url: "https://subs5.strem.io/sub/corrupt_en.srt" },
            ],
          }),
          { status: 200 }
        );
      }
      if (u.includes("rest.opensubtitles.org/search/imdbid-133093")) {
        return new Response(
          JSON.stringify(
            u.includes("sublanguageid-tur")
              ? [{ IDSubtitleFile: "99001", ISO639: "tr", SubLanguageID: "tur", SubFileName: "The.Matrix.1999.1080p.BluRay.srt", SubDownloadsCnt: "50000" }]
              : [{ IDSubtitleFile: "99002", ISO639: "en", SubLanguageID: "eng", SubFileName: "The.Matrix.1999.1080p.BluRay.srt", SubDownloadsCnt: "90000" }]
          ),
          { status: 200 }
        );
      }
      if (u.includes("trailer_tr.srt")) return new Response(trailerTrSrt, { status: 200 });
      if (u.includes("corrupt_en.srt")) return new Response(tamilMojibakeSrt, { status: 200 });
      if (u.includes("/file/99001")) return new Response(fullTrSrt, { status: 200 });
      if (u.includes("/file/99002")) return new Response(fullEnSrt, { status: 200 });
      return new Response("Not Found", { status: 404 });
    };

    const subResp = await handleEdgeSubtitle(
      new URL("https://watchlivo.online/api/rave/subtitle.vtt?url=" + encodeURIComponent("https://dl.opensubtitles.org/en/download/src-api/vrf-1/filead/12345.gz")),
      TEST_ENV
    );
    assert.equal(subResp.status, 200);
    const vttOut = await subResp.text();
    assert.ok(vttOut.includes("WEBVTT") && vttOut.includes("Merhaba dünya, kış geliyor!"));

    // Test /api/rave/subtitles with prefixed tmdb-movie-603
    const env = { ...TEST_ENV, WATCHLIVO_KV: createMockKv() };
    const reqUrl = new URL("https://watchlivo.online/api/rave/subtitles?tmdbId=tmdb-movie-603&mediaType=movie&title=The+Matrix");
    const listResp = await handleAutonomousEdge(new Request(reqUrl.toString()), reqUrl, "/api/rave/subtitles", env);
    assert.equal(listResp.status, 200);
    const listData = await listResp.json();
    const trTracks = listData.subtitleTracks.filter((t) => t.lang === "tr");
    const enTracks = listData.subtitleTracks.filter((t) => t.lang === "en");
    assert.ok(trTracks.length >= 1, "Must find full TR subtitle via OpenSubtitles REST -> subs5 bridge");
    assert.ok(decodeURIComponent(trTracks[0].url).includes("/file/99001"), "Full 120-cue TR must outrank 20-cue trailer stub");
    assert.ok(enTracks.length >= 1, "Must find clean EN subtitle via bridge");
    assert.equal(enTracks.some((t) => decodeURIComponent(t.url).includes("corrupt_en")), false, "Corrupt Tamil mojibake EN must be dropped");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("v231: SubtitleDubController auto-falls back from dead stream-tr to working os-tr and deduplicates GoT multi-group HLS audio tracks", async () => {
  const adapter = {
    currentUrl: "/api/rave/stream?sid=got&ext=.m3u8",
    video: null,
    hls: {
      currentLevel: 0,
      levels: [{ audioGroupId: "audio" }, { audioGroupId: "audio-lo" }],
      audioTracks: [
        { id: 0, groupId: "audio", lang: "tr", name: "Türkçe", default: true },
        { id: 1, groupId: "audio", lang: "en", name: "English", default: false },
        { id: 2, groupId: "audio-lo", lang: "tr", name: "Turkish", default: true },
        { id: 3, groupId: "audio-lo", lang: "en", name: "İngilizce", default: false },
      ],
      audioTrack: 0,
    },
    events: {
      onSubtitleCue() {},
      onTracksChanged() {},
    },
    getTime() { return 10; },
    getDuration() { return 3600; },
    async switchStreamSource() {},
  };

  const ctrl = new SubtitleDubController(adapter);
  ctrl.media = { title: "Game of Thrones", origLang: "en", duration: 3600 };
  ctrl.audioTracks = [
    { id: "tr-dub", lang: "tr", audioLang: "tr", label: "🇹🇷 Türkçe (Stüdyo Dublaj)", mode: "stream", url: "/api/rave/stream?sid=got&aud=tr&ext=.m3u8" },
    { id: "orig", lang: "orig", audioLang: "en", label: "🇬🇧 İngilizce (Orijinal Ses)", mode: "stream", url: "/api/rave/stream?sid=got&aud=orig&ext=.m3u8" },
  ];

  // 1. GoT multi-group HLS dedup: 4 HLS tracks across 2 groups -> strictly 2 clean tracks (1 TR + 1 EN), no duplicate İngilizce/English!
  ctrl.mergeHlsAudioTracks(adapter.hls.audioTracks);
  assert.equal(ctrl.audioTracks.length, 2, `Expected 2 deduped audio tracks, got ${JSON.stringify(ctrl.audioTracks)}`);
  assert.equal(ctrl.audioTracks.filter((t) => t.audioLang === "tr").length, 1);
  assert.equal(ctrl.audioTracks.filter((t) => t.audioLang === "en").length, 1);
  assert.equal(ctrl.audioTracks.find((t) => t.audioLang === "tr").hlsIndex, 0);
  assert.equal(ctrl.audioTracks.find((t) => t.audioLang === "en").hlsIndex, 1);

  // 2. P0 smoking gun: stream-tr returns 502 / 0 cues -> setSubtitleTrack('stream-tr', true) MUST fall back to os-tr!
  const goodVtt = "WEBVTT\n\n" + Array.from({ length: 65 }, (_, i) =>
    `${String(Math.floor((i * 40) / 3600)).padStart(2, "0")}:${String(Math.floor(((i * 40) % 3600) / 60)).padStart(2, "0")}:${String((i * 40) % 60).padStart(2, "0")}.000 --> ${String(Math.floor((i * 40 + 3) / 3600)).padStart(2, "0")}:${String(Math.floor(((i * 40 + 3) % 3600) / 60)).padStart(2, "0")}:${String((i * 40 + 3) % 60).padStart(2, "0")}.000\nKış geliyor, duvarın ötesinde tehlike var, bunu gerçekten herkes biliyor.`
  ).join("\n\n");

  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (u) => {
      const s = String(u || "");
      if (s.includes("dead-stream-sub")) return new Response("Bad Gateway", { status: 502 });
      if (s.includes("good-os-sub")) return new Response(goodVtt, { status: 200 });
      return new Response("Not Found", { status: 404 });
    };
    ctrl.subtitleTracks = [
      { id: "stream-tr", lang: "tr", label: "🇹🇷 Türkçe (Yayın Altyazısı)", url: "/api/rave/subtitle.vtt?url=https%3A%2F%2Fdead-stream-sub.test%2F1.vtt", source: "diziyou_net" },
      { id: "os-tr-1", lang: "tr", label: "🇹🇷 Türkçe (OpenSubtitles)", url: "/api/rave/subtitle.vtt?url=https%3A%2F%2Fgood-os-sub.test%2F1.srt", source: "opensubtitles" },
    ];
    const picked = await ctrl.setSubtitleTrack("stream-tr", true);
    assert.ok(picked);
    assert.equal(picked.id, "os-tr-1", "Must auto-fallback from dead stream-tr to working os-tr-1");
    assert.equal(ctrl.selectedSubId, "os-tr-1");
    assert.equal(ctrl.subCues.length, 65);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("v232 sync: source-matched stream sub ordering, overlapping cue fast-path accuracy, X-TIMESTAMP-MAP, PAL/wrong-episode filter & duration auto-selection", async () => {
  // 1. formatStreamSubTracks puts primarySource (diziyou_net) ahead of dl_embed (House of the Dragon S1E1 fix!)
  const orderedSubs = formatStreamSubTracks([
    { lang: "tr", url: "https://cdn.dl.test/hotd_tr.vtt", source: "dl_embed" },
    { lang: "tr", url: "https://ksdpictures.site/sub_tr_hotd.vtt", source: "diziyou_net" },
    { lang: "en", url: "https://cdn.dl.test/hotd_en.vtt", source: "dl_embed" },
    { lang: "en", url: "https://ksdpictures.site/sub_en_hotd.vtt", source: "diziyou_net" },
  ], "diziyou_net");
  assert.equal(orderedSubs[0].source, "diziyou_net");
  assert.equal(orderedSubs[0].id, "stream-tr");
  assert.equal(orderedSubs[2].source, "diziyou_net");
  assert.equal(orderedSubs[2].id, "stream-en");

  // 2. parseVtt handles X-TIMESTAMP-MAP non-zero LOCAL offset and strips betting/IPTV spam cues
  const tsVtt = [
    "WEBVTT",
    "X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:10.000",
    "",
    "00:00:12.000 --> 00:00:15.000",
    "1000 TL Para yatırma bonusu hemen kazan!",
    "",
    "00:00:20.000 --> 00:00:24.000",
    "Birinci replik",
    "",
    "00:00:21.500 --> 00:00:25.000",
    "İkinci replik",
  ].join("\n");
  const parsed = parseVtt(tsVtt);
  assert.equal(parsed.length, 2, "Betting spam cue must be stripped");
  assert.equal(parsed[0].start, 10.0, "LOCAL:10s must shift cue from 20s to 10s");
  assert.equal(parsed[1].start, 11.5);

  // 3. Overlapping-cue fast-path bug fix: Cue 2 at 11.5s MUST NOT be delayed until Cue 1 ends at 14.0s!
  const emitted = [];
  const adapter = {
    currentUrl: "/api/rave/stream?sid=srv_dn&ext=.m3u8",
    video: null,
    hls: null,
    events: {
      onSubtitleCue(txt) { emitted.push(txt); },
      onTracksChanged() {},
    },
    getTime() { return 0; },
    getDuration() { return 8178; },
    async switchStreamSource() {},
  };
  const ctrl = new SubtitleDubController(adapter);
  ctrl.media = {
    tmdbId: "603",
    title: "The Matrix",
    servers: [
      { id: "srv-1", source: "diziyou_net", label: "DiziyouNet", url: "/api/rave/stream?sid=srv_dn&ext=.m3u8" },
      { id: "srv-2", source: "dl_embed", label: "Dizilife", url: "/api/rave/stream?sid=srv_dl&ext=.m3u8" },
    ],
  };
  ctrl.selectedSubId = "stream-tr";
  ctrl.subCues = parsed;

  ctrl.onTimeUpdate(10.5);
  assert.equal(ctrl.activeCueText, "Birinci replik");
  // Without our nextStart boundary fix, 11.6 would hit the [10, 14) fast-path and SKIP "İkinci replik"!
  ctrl.onTimeUpdate(11.6);
  assert.equal(ctrl.activeCueText, "Birinci replik\nİkinci replik");
  // At 14.1, Cue 1 ended at 14.0 so ONLY Cue 2 should remain visible!
  ctrl.onTimeUpdate(14.1);
  assert.equal(ctrl.activeCueText, "İkinci replik");
  // At 15.1, both ended!
  ctrl.onTimeUpdate(15.1);
  assert.equal(ctrl.activeCueText, "");

  // 4. Per-track _syncStorageKey isolates offset prefs across tracks
  assert.notEqual(
    ctrl._syncStorageKey(ctrl.media, "stream-tr"),
    ctrl._syncStorageKey(ctrl.media, "os-tr-1")
  );

  // 5. /api/rave/subtitles rejects wrong TV episode (S5E3 on S3E5) and demotes 25fps PAL + betting ad below clean 23.976fps
  const makeEpisodeSrt = (n, durSec, firstText) => {
    const step = durSec / n;
    const fmt = (sec) => {
      const h = String(Math.floor(sec / 3600)).padStart(2, "0");
      const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
      const s = String(Math.floor(sec % 60)).padStart(2, "0");
      return `${h}:${m}:${s},000`;
    };
    return Array.from({ length: n }, (_, i) => {
      const st = 100 + Math.floor(i * step);
      const en = st + 2;
      const line = i === 0 ? firstText : "Bu gerçekten çok önemli bir sahne değil mi ama herkes neden burada?";
      return `${i + 1}\n${fmt(st)} --> ${fmt(en)}\n${line}`;
    }).join("\n\n");
  };
  const wrongEpSrt = makeEpisodeSrt(60, 3300, "Game of Thrones, 5. Sezon, 3. Bolum");
  const palSpamSrt = makeEpisodeSrt(60, 3050, "1000 TL Para yatırma bonusu hemen al!");
  const good23976Srt = makeEpisodeSrt(60, 3330, "Game of Thrones, 3. Sezon, 5. Bölüm");

  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input) => {
      const u = typeof input === "string" ? input : input.url;
      if (u.includes("api.themoviedb.org/3/tv/1399/external_ids")) {
        return new Response(JSON.stringify({ imdb_id: "tt0944947" }), { status: 200 });
      }
      if (u.includes("opensubtitles-v3.strem.io/subtitles/series/tt0944947:3:5.json")) {
        return new Response(JSON.stringify({
          subtitles: [
            { id: "tr-wrong", lang: "tur", fpsMilli: 23976, subtitleFileName: "GoT.S03E05.BluRay.srt", url: "https://subs5.strem.io/sub/wrong_ep.srt" },
            { id: "tr-pal", lang: "tur", fpsMilli: 25000, subtitleFileName: "GoT.S03E05.25fps.BluRay.srt", url: "https://subs5.strem.io/sub/pal_spam.srt" },
            { id: "tr-good", lang: "tur", fpsMilli: 23976, subtitleFileName: "GoT.S03E05.WEB-DL.srt", url: "https://subs5.strem.io/sub/good_s3e5.srt" },
            { id: "en-good", lang: "eng", fpsMilli: 23976, subtitleFileName: "GoT.S03E05.WEB-DL.en.srt", url: "https://subs5.strem.io/sub/good_en.srt" },
          ],
        }), { status: 200 });
      }
      if (u.includes("wrong_ep.srt")) return new Response(wrongEpSrt, { status: 200 });
      if (u.includes("pal_spam.srt")) return new Response(palSpamSrt, { status: 200 });
      if (u.includes("good_s3e5.srt")) return new Response(good23976Srt, { status: 200 });
      if (u.includes("good_en.srt")) return new Response(makeEpisodeSrt(60, 3330, "The quick brown fox jumps over the lazy dog in Westeros."), { status: 200 });
      return new Response("Not Found", { status: 404 });
    };
    const env = { ...TEST_ENV, WATCHLIVO_KV: createMockKv() };
    const reqUrl = new URL("https://watchlivo.online/api/rave/subtitles?tmdbId=1399&mediaType=tv&season=3&episode=5&duration=3443");
    const resp = await handleAutonomousEdge(new Request(reqUrl.toString()), reqUrl, "/api/rave/subtitles", env);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    const trList = data.subtitleTracks.filter((t) => t.lang === "tr");
    assert.equal(trList.some((t) => decodeURIComponent(t.url).includes("wrong_ep.srt")), false, "S5E3 uploaded under S3E5 must be dropped");
    assert.ok(decodeURIComponent(trList[0].url).includes("good_s3e5.srt"), "Clean 23.976fps S3E5 must outrank 25fps PAL + betting spam");
    assert.ok(trList[0].spanSec > 3200, "Must expose spanSec metadata");
  } finally {
    globalThis.fetch = origFetch;
  }
});
