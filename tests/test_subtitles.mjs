import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeSubLang,
  formatSubLabel,
  detectSubtitleTextLang,
  decodeSubtitleBytes,
  formatStreamSubTracks,
  handleEdgeSubtitle,
} from "../workers/ha-gateway/edge_streams.js";
import { handleAutonomousEdge } from "../workers/ha-gateway/edge_autonomous.js";

test("subtitle lang normalization & human-readable labels handle ISO-639-2 codes and Turkish filename overrides", () => {
  assert.equal(normalizeSubLang("tur"), "tr");
  assert.equal(normalizeSubLang("eng"), "en");
  assert.equal(normalizeSubLang("pob"), "pt");
  assert.equal(normalizeSubLang("fre"), "fr");
  assert.equal(normalizeSubLang("ger"), "de");
  assert.equal(normalizeSubLang("eng", "Resident.Evil.Turkish.1080p.srt"), "tr");
  assert.equal(normalizeSubLang("", "Türkçe", "https://cdn.example/sub_turkish/turkish.vtt"), "tr");
  assert.equal(formatSubLabel("tr"), "🇹🇷 Türkçe");
  assert.equal(formatSubLabel("eng", "BluRay"), "🇬🇧 İngilizce (BluRay)");
  assert.equal(formatSubLabel("pob"), "🇵🇹 Portekizce");
});

test("decodeSubtitleBytes prevents UTF-8 Turkish mojibake while still decoding genuine Windows-1254 SRT", () => {
  // 1. Valid UTF-8 Turkish with 1 stray invalid byte (0xFF) must stay UTF-8, NOT become "Aman TanrÄ±m"
  const utf8Good = Buffer.from("WEBVTT\n\n00:01.000 --> 00:03.000\nAman Tanrım, yağmur yağıyor. Şehir çok güzel!\n", "utf8");
  const withBadByte = Buffer.concat([utf8Good, Buffer.from([0xff, 0x0a])]);
  const decodedUtf8 = decodeSubtitleBytes(withBadByte);
  assert.ok(decodedUtf8.includes("Aman Tanrım"), `Expected clean Turkish UTF-8, got: ${decodedUtf8}`);
  assert.ok(!decodedUtf8.includes("Ä±") && !decodedUtf8.includes("ÄŸ"), `Mojibake leaked: ${decodedUtf8}`);

  // 2. Genuine Windows-1254 Turkish bytes (0xFD='ı', 0xF0='ğ', 0xFE='ş', 0xE7='ç', 0xF6='ö', 0xFC='ü')
  const win1254Bytes = Buffer.from([
    ...Buffer.from("1\n00:00:01,000 --> 00:00:03,000\n"),
    0x41, 0x6d, 0x61, 0x6e, 0x20, 0x54, 0x61, 0x6e, 0x72, 0xfd, 0x6d, 0x20, // Aman Tanrım
    0x79, 0x61, 0xf0, 0x6d, 0x75, 0x72, 0x20, 0xfe, 0x65, 0x68, 0x69, 0x72, // yağmur şehir
    0x0a,
  ]);
  const decodedWin = decodeSubtitleBytes(win1254Bytes);
  assert.ok(decodedWin.includes("Aman Tanrım"), `Expected decoded Win-1254 Turkish, got: ${decodedWin}`);
  assert.ok(decodedWin.includes("yağmur şehir"), `Expected decoded Win-1254 yağmur şehir, got: ${decodedWin}`);
});

test("detectSubtitleTextLang accurately distinguishes Turkish vs English and stays silent on other languages", () => {
  const trSample = `WEBVTT

00:01.000 --> 00:04.000
Benim adım Alice. Umbrella Şirketi için çalışıyordum.

00:05.000 --> 00:09.000
Ama bu sadece başlangıçtı, burada hiç kimse güvende değil. Şimdi gitmemiz gerekiyor, lütfen beni dinle!`;
  const enSample = `WEBVTT

00:01.000 --> 00:04.000
My name is Alice. I worked for the Umbrella Corporation, the largest commercial entity in the world.

00:05.000 --> 00:09.000
But this was just the beginning, nobody is safe here and we have to get out right now with them.`;
  const esSample = `WEBVTT

00:01.000 --> 00:04.000
Mi nombre es Alice. Trabajaba para la Corporación Umbrella, pero todo cambió aquí ahora mismo.`;

  assert.equal(detectSubtitleTextLang(trSample), "tr");
  assert.equal(detectSubtitleTextLang(enSample), "en");
  assert.equal(detectSubtitleTextLang(esSample), "");
});

test("handleEdgeSubtitle rejects non-subtitle error strings with 502 and emits X-Watchlivo-Sub-Lang header", async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (u) => {
      const s = String(u);
      if (s.includes("bad.example")) {
        return new Response("Invalid or unsafe link", { status: 200, headers: { "Content-Type": "text/plain" } });
      }
      return new Response(
        "1\n00:00:01,000 --> 00:00:04,000\nBenim adım Alice. Umbrella Şirketi için çalışıyordum.\n\n2\n00:00:05,000 --> 00:00:09,000\nAma bu sadece başlangıçtı, burada hiç kimse güvende değil, şimdi gitmemiz gerekiyor, lütfen beni dinle!\n",
        { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    };

    const badResp = await handleEdgeSubtitle(new URL("https://watchlivo.online/api/rave/subtitle.vtt?url=https%3A%2F%2Fbad.example%2Fx.jpg"), {});
    assert.equal(badResp.status, 502, "Non-subtitle plain text must return 502, not 200 OK WEBVTT");

    const okResp = await handleEdgeSubtitle(new URL("https://watchlivo.online/api/rave/subtitle.vtt?url=https%3A%2F%2Fgood.example%2Ftr.srt"), {});
    assert.equal(okResp.status, 200);
    assert.equal(okResp.headers.get("X-Watchlivo-Sub-Lang"), "tr");
    const body = await okResp.text();
    assert.ok(body.startsWith("WEBVTT"));
    assert.ok(body.includes("00:00:01.000 --> 00:00:04.000"));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("/api/rave/subtitles scans past index 20, surfaces TR, caps duplicates, ranks BluRay > TS, and reclassifies mislabeled eng->tr", async () => {
  const origFetch = globalThis.fetch;
  try {
    const trBody = "1\n00:00:01,000 --> 00:00:04,000\nBenim adım Alice. Umbrella Şirketi için çalışıyordum.\n\n2\n00:00:05,000 --> 00:00:09,000\nAma bu sadece başlangıçtı, burada hiç kimse güvende değil, şimdi gitmemiz gerekiyor, lütfen beni dinle!\n";
    const enBody = "1\n00:00:01,000 --> 00:00:04,000\nMy name is Alice. I worked for the Umbrella Corporation, the largest commercial entity in the world.\n\n2\n00:00:05,000 --> 00:00:09,000\nBut this was just the beginning, nobody is safe here and we have to get out right now with them.\n";

    // Build 60-item OpenSubtitles list: 15 pob + 15 eng (one mislabeled Turkish!) + 25 other + 5 tur at indices 55-59!
    const mockSubs = [];
    for (let i = 0; i < 15; i++) {
      mockSubs.push({ id: `p${i}`, lang: "pob", url: `https://subs5.strem.io/pob_${i}.srt`, releaseFormat: "WEB" });
    }
    // Index 15: mislabeled "eng" whose content is ACTUALLY Turkish!
    mockSubs.push({ id: "e_mislabeled", lang: "eng", url: "https://subs5.strem.io/eng_actually_tr.srt", releaseFormat: "BluRay", fpsMilli: 23976 });
    for (let i = 0; i < 12; i++) {
      mockSubs.push({ id: `e${i}`, lang: "eng", url: `https://subs5.strem.io/eng_${i}.srt`, releaseFormat: i === 5 ? "BluRay" : "Telesync", fpsMilli: i === 5 ? 23976 : 25000 });
    }
    mockSubs.push({ id: "de1", lang: "ger", url: "https://subs5.strem.io/ger_1.srt", releaseFormat: "BluRay" });
    mockSubs.push({ id: "fr1", lang: "fre", url: "https://subs5.strem.io/fre_1.srt", releaseFormat: "WEB" });
    // Put Turkish tracks AFTER index 25 (would have been dropped by old .slice(0, 20)!)
    mockSubs.push({ id: "tr_ts", lang: "tur", url: "https://subs5.strem.io/tur_ts.srt", releaseFormat: "Telesync", fpsMilli: 25000 });
    mockSubs.push({ id: "tr_bluray", lang: "tur", url: "https://subs5.strem.io/tur_bluray.srt", releaseFormat: "BluRay", fpsMilli: 23976 });
    mockSubs.push({ id: "tr_dead", lang: "tur", url: "https://subs5.strem.io/tur_dead.srt", releaseFormat: "WEB", fpsMilli: 23976 });

    globalThis.fetch = async (u) => {
      const s = String(u);
      if (s.includes("opensubtitles-v3.strem.io")) {
        return new Response(JSON.stringify({ subtitles: mockSubs }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (s.includes("tur_dead.srt")) return new Response("Not found", { status: 404 });
      if (s.includes("eng_actually_tr.srt") || s.includes("tur_")) return new Response(trBody, { status: 200 });
      return new Response(enBody, { status: 200 });
    };

    const reqUrl = new URL("https://watchlivo.online/api/rave/subtitles?tmdbId=71679&imdbId=tt1855325&mediaType=movie");
    const req = new Request(reqUrl);
    const resp = await handleAutonomousEdge(req, reqUrl, "/api/rave/subtitles", {});
    assert.equal(resp.status, 200);
    const data = await resp.json();
    const tracks = data.subtitleTracks || [];

    const trTracks = tracks.filter((t) => t.lang === "tr");
    const enTracks = tracks.filter((t) => t.lang === "en");
    const ptTracks = tracks.filter((t) => t.lang === "pt");

    // 1. Turkish tracks past index 20 MUST be found, dead track dropped, mislabeled eng->tr reclassified!
    assert.ok(trTracks.length >= 2 && trTracks.length <= 4, `Expected 2-4 TR tracks, got ${trTracks.length}: ${JSON.stringify(tracks)}`);
    assert.ok(!tracks.some((t) => t.url.includes("tur_dead.srt")), "Dead 404 track should be dropped");
    assert.ok(trTracks.some((t) => t.url.includes("eng_actually_tr.srt")), "Mislabeled eng->tr track MUST be reclassified to tr");
    assert.ok(trTracks[0].url.includes("tur_bluray.srt") || trTracks[0].url.includes("eng_actually_tr.srt"), "BluRay track must rank above Telesync");

    // 2. English capped cleanly (<=3) instead of 13 raw 'eng' rows, and Portuguese capped at 1 instead of 15 raw 'pob'!
    assert.ok(enTracks.length <= 3, `Expected <=3 EN tracks, got ${enTracks.length}`);
    assert.equal(ptTracks.length, 1, `Expected 1 PT track, got ${ptTracks.length}`);

    // 3. No raw ugly ISO codes like 'eng' or 'pob' in labels, and TR sorted first!
    assert.equal(tracks[0].lang, "tr");
    for (const t of tracks) {
      assert.ok(!/^(?:eng|pob|tur|fre|ger)$/i.test(t.label), `Raw ISO code label leaked: ${t.label}`);
    }
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("formatStreamSubTracks deduplicates URLs, sorts tr before en, preserves source, and numbers cleanly", () => {
  const res = formatStreamSubTracks([
    { lang: "eng", url: "https://cdn.example/en.vtt", source: "dl_embed" },
    { lang: "tur", url: "https://cdn.example/tr1.vtt", source: "sinemacc" },
    { lang: "tr", url: "https://cdn.example/tr1.vtt", source: "sinemacc" }, // duplicate URL
    { lang: "tr", url: "https://cdn.example/tr2.vtt", source: "dl_embed" },
  ]);
  assert.equal(res.length, 3);
  assert.equal(res[0].lang, "tr");
  assert.equal(res[1].lang, "tr");
  assert.equal(res[2].lang, "en");
  assert.equal(res[0].source, "sinemacc");
  assert.equal(res[0].synced, true);
  assert.notEqual(res[0].label, res[1].label);
  assert.ok(res[2].label.includes("İngilizce"));
});
