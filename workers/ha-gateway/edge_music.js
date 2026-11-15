const MUSIC_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

export const MUSIC_CATEGORIES = [
  { id: "all", label: "🏠 Tümü & Sana Özel", query: "türkçe pop rap hit 2025" },
  { id: "trending", label: "🔥 Trend & Top 50", query: "Semicenk Lvbel C5 Blok3 Mabel Matiz Dedublüman" },
  { id: "tr_pop", label: "🇹🇷 Türkçe Pop", query: "Simge Edis Gülşen Hande Yener Tarkan Hadise" },
  { id: "tr_rap", label: "🎤 Türkçe Rap & Drill", query: "Lvbel C5 Blok3 Uzi Motive Ceza Sagopa Kajmer Ati242" },
  { id: "slow", label: "💔 Slow & Akustik", query: "Semicenk Emir Can İğrek Dedublüman Sezen Aksu Yalın" },
  { id: "arabesk", label: "🎻 Arabesk & Damar", query: "Müslüm Gürses Bergen İbrahim Tatlıses Ebru Gündeş Azer Bülbül" },
  { id: "tr_rock", label: "🎸 Anadolu & Türkçe Rock", query: "Duman Mor ve Ötesi maNga Barış Manço Cem Karaca Şebnem Ferah" },
  { id: "nostalji", label: "🕰️ 90'lar & 2000'ler", query: "Tarkan Sezen Aksu Sertab Erener Kenan Doğulu Teoman Levent Yüksel" },
  { id: "global_pop", label: "🌍 Yabancı Hit & Pop", query: "The Weeknd Billie Eilish Taylor Swift Dua Lipa Bruno Mars Lady Gaga" },
  { id: "phonk", label: "⚡ Phonk & Remix", query: "Kordhell Interworld DVRST Eternxlkz Phonk" },
  { id: "global_rock", label: "🎸 Yabancı Rock & Efsaneler", query: "Queen Linkin Park Nirvana Metallica Arctic Monkeys Coldplay" },
];

const CATEGORY_SEEDS = {
  trending: ["Semicenk", "Mabel Matiz"],
  tr_pop: ["Simge", "Edis"],
  tr_rap: ["Blok3", "Ceza"],
  slow: ["Dedublüman", "Sezen Aksu"],
  arabesk: ["Müslüm Gürses", "Bergen"],
  tr_rock: ["Duman", "Mor ve Ötesi"],
  nostalji: ["Tarkan", "Teoman"],
  global_pop: ["The Weeknd", "Billie Eilish"],
  phonk: ["Kordhell", "DVRST"],
  global_rock: ["Queen", "Linkin Park"],
};

const _musicCache = new Map();

function musicJson(obj, status = 200, maxAge = 120) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${maxAge}, s-maxage=${maxAge * 4}, stale-while-revalidate=1800`,
      "X-Watchlivo-Origin": "cf-autonomous-edge",
    },
  });
}

function trackKey(artist, title) {
  const norm = (s) => String(s || "").toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, "").replace(/[^a-z0-9ğüşöçıİĞÜŞÖÇ]+/gi, "");
  return `${norm(artist)}::${norm(title)}`;
}

async function fetchJsonSafe(u, ms = 3800) {
  try {
    const r = await fetch(u, { headers: { "User-Agent": MUSIC_UA, Accept: "application/json" }, signal: AbortSignal.timeout(ms) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function searchItunes(term, limit = 12) {
  const q = String(term || "").trim();
  if (!q) return [];
  const data = await fetchJsonSafe(`https://itunes.apple.com/search?${new URLSearchParams({ term: q, country: "TR", media: "music", entity: "song", limit: String(limit) })}`);
  const out = [];
  for (const it of data?.results || []) {
    const title = String(it.trackName || "").trim();
    const artist = String(it.artistName || "").trim();
    const prev = String(it.previewUrl || "").trim();
    if (!title || !artist || !prev) continue;
    const poster = (it.artworkUrl100 || "").replace("100x100bb", "600x600bb") || "/static/watchlivo-poster.svg";
    out.push({
      id: `trk_${it.trackId || out.length}`, trackId: String(it.trackId || ""),
      title: `${artist} — ${title}`, songTitle: title, artist, album: it.collectionName || "",
      year: String(it.releaseDate || "2025").slice(0, 4), genre: it.primaryGenreName || "Müzik",
      sourcePlatform: "Apple Music", sourceBadge: "🍎 Apple Music",
      duration: Math.max(30, Math.floor((it.trackTimeMillis || 200000) / 1000)),
      poster, backdrop: poster, thumbnail: poster, audioPreviewUrl: prev, isMusic: true, mediaType: "music",
    });
  }
  return out;
}

async function searchDeezer(term, limit = 10) {
  const q = String(term || "").trim();
  if (!q) return [];
  const data = await fetchJsonSafe(`https://api.deezer.com/search?${new URLSearchParams({ q, limit: String(limit) })}`);
  const out = [];
  for (const it of data?.data || []) {
    const title = String(it.title_short || it.title || "").trim();
    const artist = String(it.artist?.name || "").trim();
    if (!title || !artist) continue;
    const alb = it.album || {};
    const poster = alb.cover_xl || alb.cover_big || alb.cover_medium || "/static/watchlivo-poster.svg";
    out.push({
      id: `dz_${it.id}`, trackId: String(it.id || ""),
      title: `${artist} — ${title}`, songTitle: title, artist, album: alb.title || "Deezer Hi-Fi",
      year: "2025", genre: "Deezer Hi-Fi", sourcePlatform: "Deezer", sourceBadge: "🟣 Deezer Hi-Fi",
      duration: Math.max(30, Number(it.duration || 200)),
      poster, backdrop: poster, thumbnail: poster, audioPreviewUrl: String(it.preview || ""), isMusic: true, mediaType: "music",
    });
  }
  return out;
}

function dedupeTracks(lists, seen = new Set()) {
  const out = [];
  for (const list of lists) {
    for (const it of list || []) {
      const k = trackKey(it.artist, it.songTitle || it.title);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(it);
    }
  }
  return out;
}

export function parseLrcToVtt(lrc) {
  const cues = [];
  for (const rawLine of String(lrc || "").split(/\r?\n/)) {
    const m = rawLine.match(/^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]\s*(.+)$/);
    if (!m) continue;
    const ms = Number(m[1]) * 60000 + Number(m[2]) * 1000 + Number((m[3] || "0").padEnd(3, "0").slice(0, 3));
    const text = m[4].trim();
    if (text) cues.push({ ms, text });
  }
  if (!cues.length) return "WEBVTT\n\n";
  const fmt = (ms) => {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const f = ms % 1000;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(f).padStart(3, "0")}`;
  };
  const body = cues.map((c, i) => `${fmt(c.ms)} --> ${fmt(cues[i + 1] ? Math.min(cues[i + 1].ms, c.ms + 7000) : c.ms + 5000)}\n${c.text}`).join("\n\n");
  return `WEBVTT\n\n${body}\n`;
}

function plainLyricsToVtt(plain) {
  const lines = String(plain || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return "WEBVTT\n\n";
  const fmt = (sec) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.000`;
  };
  const body = lines.map((line, i) => `${fmt(i * 4)} --> ${fmt((i + 1) * 4)}\n${line}`).join("\n\n");
  return `WEBVTT\n\n${body}\n`;
}

async function resolveYoutubeVideoId(q) {
  try {
    const r = await fetch(`https://www.youtube.com/results?${new URLSearchParams({ search_query: q })}`, {
      headers: { "User-Agent": MUSIC_UA, "Accept-Language": "tr-TR,tr;q=0.9" },
      signal: AbortSignal.timeout(2600),
    });
    if (!r.ok) return "";
    const html = await r.text();
    const m = html.match(/"videoId":"([\w-]{11})"/);
    return m ? m[1] : "";
  } catch { return ""; }
}

export async function handleEdgeMusicRoute(request, url, safePath) {
  if (safePath === "/api/rave/music-catalog") {
    const category = (url.searchParams.get("category") || "all").trim().toLowerCase();
    const q = (url.searchParams.get("q") || "").trim().slice(0, 120);
    const ckey = `${category}|${q.toLowerCase()}`;
    const hit = _musicCache.get(ckey);
    if (hit && Date.now() - hit.ts < 600_000) return musicJson(hit.data);

    let payload;
    if (q) {
      const [itRes, dzRes] = await Promise.allSettled([searchItunes(q, 16), searchDeezer(q, 10)]);
      const items = dedupeTracks([itRes.status === "fulfilled" ? itRes.value : [], dzRes.status === "fulfilled" ? dzRes.value : []]);
      payload = {
        provider: "music", category, categories: MUSIC_CATEGORIES, items: items.slice(0, 28), similarItems: items.slice(4, 14),
        shelves: items.length ? [{ id: "search", title: `🔍 '${q}' — Apple Music · Deezer Sonuçları`, items: items.slice(0, 24) }] : [],
      };
    } else {
      const targetIds = (category === "all" || !category) ? ["trending", "tr_pop", "tr_rap", "slow", "global_pop"] : [category];
      const targets = MUSIC_CATEGORIES.filter((c) => targetIds.includes(c.id));
      const catObjs = targets.length ? targets : [MUSIC_CATEGORIES[1]];
      const results = await Promise.all(catObjs.map(async (c) => {
        const seeds = CATEGORY_SEEDS[c.id] || [c.query];
        const [a, b] = await Promise.allSettled([searchItunes(seeds[0], 10), searchDeezer(seeds[1] || seeds[0], 8)]);
        return { cat: c, tracks: dedupeTracks([a.status === "fulfilled" ? a.value : [], b.status === "fulfilled" ? b.value : []]).map((t) => ({ ...t, categoryId: c.id, categoryLabel: c.label })) };
      }));
      const seenAll = new Set();
      const shelves = [];
      const items = [];
      for (const { cat, tracks } of results) {
        const unique = dedupeTracks([tracks], seenAll);
        if (!unique.length) continue;
        shelves.push({ id: cat.id, title: `${cat.label} · ${unique.length} Parça`, items: unique.slice(0, 16) });
        items.push(...unique.slice(0, 16));
      }
      if (!items.length) {
        const seedFallback = [
          { id: "fb_m1", title: "Semicenk — Pişman Değilim", songTitle: "Pişman Değilim", artist: "Semicenk", videoId: "R2qJ1yQqf9g", sourcePlatform: "Watchlivo", sourceBadge: "🎵 Popüler", duration: 195, poster: "/static/watchlivo-poster.svg", backdrop: "/static/watchlivo-poster.svg", thumbnail: "/static/watchlivo-poster.svg", isMusic: true, mediaType: "music" },
          { id: "fb_m2", title: "Mabel Matiz — Fan", songTitle: "Fan", artist: "Mabel Matiz", videoId: "dQ5r7zT4m2k", sourcePlatform: "Watchlivo", sourceBadge: "🎵 Popüler", duration: 215, poster: "/static/watchlivo-poster.svg", backdrop: "/static/watchlivo-poster.svg", thumbnail: "/static/watchlivo-poster.svg", isMusic: true, mediaType: "music" },
          { id: "fb_m3", title: "Duman — Senden Daha Güzel", songTitle: "Senden Daha Güzel", artist: "Duman", videoId: "fU2tS1b0p2A", sourcePlatform: "Watchlivo", sourceBadge: "🎸 Rock", duration: 220, poster: "/static/watchlivo-poster.svg", backdrop: "/static/watchlivo-poster.svg", thumbnail: "/static/watchlivo-poster.svg", isMusic: true, mediaType: "music" },
        ];
        shelves.push({ id: "trending", title: "🔥 Trend & Seçkin Parçalar · 3 Parça", items: seedFallback });
        items.push(...seedFallback);
      }
      payload = { provider: "music", category: category || "all", categories: MUSIC_CATEGORIES, items: items.slice(0, 48), similarItems: [], shelves };
    }
    if (payload.items.length) _musicCache.set(ckey, { ts: Date.now(), data: payload });
    return musicJson(payload);
  }

  if (safePath === "/api/rave/music-similar") {
    const artist = (url.searchParams.get("artist") || "").trim().slice(0, 80);
    const title = (url.searchParams.get("title") || "").trim().slice(0, 100);
    const q = `${artist} ${title}`.trim() || "Semicenk";
    const [a, b] = await Promise.allSettled([searchItunes(q, 10), searchDeezer(q, 8)]);
    const items = dedupeTracks([a.status === "fulfilled" ? a.value : [], b.status === "fulfilled" ? b.value : []]).slice(0, 14);
    return musicJson({ artist, title, items });
  }

  if (safePath === "/api/rave/music-lyrics.vtt") {
    const artist = (url.searchParams.get("artist") || "").trim().slice(0, 80);
    const title = (url.searchParams.get("title") || "").trim().slice(0, 100);
    let vtt = "WEBVTT\n\n";
    if (artist || title) {
      const lr = await fetchJsonSafe(`https://lrclib.net/api/get?${new URLSearchParams({ artist_name: artist, track_name: title })}`, 3000);
      if (lr?.syncedLyrics) vtt = parseLrcToVtt(lr.syncedLyrics);
      else if (lr?.plainLyrics) vtt = plainLyricsToVtt(lr.plainLyrics);
    }
    return new Response(vtt, { status: 200, headers: { "Content-Type": "text/vtt; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600, s-maxage=86400" } });
  }

  if (safePath === "/api/rave/music-resolve") {
    const artist = (url.searchParams.get("artist") || "").trim().slice(0, 80);
    const songTitle = (url.searchParams.get("title") || url.searchParams.get("songTitle") || url.searchParams.get("q") || "").trim().slice(0, 120);
    const vidParam = (url.searchParams.get("videoId") || "").trim();
    const prev = (url.searchParams.get("audioPreviewUrl") || "").trim();
    const mv = (url.searchParams.get("mvUrl") || "").trim();
    const rawUrl = (url.searchParams.get("url") || "").trim();
    const poster = (url.searchParams.get("poster") || "").trim() || "/static/watchlivo-poster.svg";
    const mode = (url.searchParams.get("mode") || "video").trim().toLowerCase();
    const cleanQ = `${artist} ${songTitle}`.trim();
    let vid = /^[\w-]{11}$/.test(vidParam) ? vidParam : "";
    if (!vid && cleanQ) {
      if (mode !== "audio") vid = await resolveYoutubeVideoId(`${cleanQ} official video`);
      else if (!prev) vid = await resolveYoutubeVideoId(`${cleanQ} official audio`);
    }
    const dispTitle = artist && songTitle ? `${artist} — ${songTitle}` : (songTitle || artist || "Müzik");
    const lyricsUrl = `/api/rave/music-lyrics.vtt?${new URLSearchParams({ artist, title: songTitle })}`;
    if (vid) {
      return musicJson({
        provider: "youtube", streamType: "youtube", catalogProvider: "music", isMusic: true, mediaType: "music",
        musicMode: mode, videoId: vid, clipVideoId: vid, url: `https://www.youtube.com/watch?v=${vid}`,
        title: `🎵 ${dispTitle}`, artist, songTitle, poster, duration: 210, lyricsUrl, audioPreviewUrl: prev,
      }, 200, 60);
    }
    const directUrl = mv || prev || rawUrl;
    return musicJson({
      provider: directUrl ? "direct" : "youtube", streamType: directUrl ? "mp4" : "youtube", catalogProvider: "music",
      isMusic: true, isPreview: Boolean(directUrl), mediaType: "music", musicMode: mode, url: directUrl,
      title: `🎵 ${dispTitle}`, artist, songTitle, poster, duration: directUrl ? 30 : 210, lyricsUrl,
    }, 200, 60);
  }
  return null;
}
