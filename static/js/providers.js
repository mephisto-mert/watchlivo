// Provider registry — Rave providerList parity with authentic full-color brand SVGs on dark obsidian surfaces.
const svgRaw = (body, vb = '0 0 140 44') =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" fill="none">${body}</svg>`)}`;

export const LOGOS = {
  netflix: svgRaw(
    '<defs><linearGradient id="nf" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ff1f2d"/><stop offset="100%" stop-color="#b1060f"/></linearGradient></defs>' +
    '<rect x="6" y="6" width="6.2" height="32" rx="1" fill="#b1060f"/>' +
    '<rect x="21.8" y="6" width="6.2" height="32" rx="1" fill="#b1060f"/>' +
    '<path d="M6 6h6.4L28 38h-6.4L6 6z" fill="url(#nf)"/>' +
    '<text x="38" y="29" fill="#e50914" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="20.5" letter-spacing="1.4">NETFLIX</text>'
  ),
  disney: svgRaw(
    '<defs><linearGradient id="dp" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#0063e5"/><stop offset="55%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#a5f3fc"/></linearGradient></defs>' +
    '<path d="M18 15C38 2 88 2 114 16" stroke="url(#dp)" stroke-width="2.6" stroke-linecap="round"/>' +
    '<circle cx="114" cy="16" r="2.3" fill="#a5f3fc"/>' +
    '<text x="64" y="33" text-anchor="middle" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="22" letter-spacing="-0.4">Disney</text>' +
    '<path d="M111 20v11M105.5 25.5h11" stroke="#38bdf8" stroke-width="3" stroke-linecap="round"/>'
  ),
  prime: svgRaw(
    '<text x="70" y="24" text-anchor="middle" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="21" letter-spacing="-0.3">prime video</text>' +
    '<path d="M34 31Q70 42 106 30" stroke="#00a8e1" stroke-width="3.2" stroke-linecap="round"/>' +
    '<path d="M100 26.5L107.5 30L102.5 36.5" stroke="#00a8e1" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'
  ),
  max: svgRaw(
    '<defs><linearGradient id="mx" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#2563eb"/></linearGradient></defs>' +
    '<text x="70" y="31" text-anchor="middle" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="29" letter-spacing="-0.8">max</text>' +
    '<circle cx="72.5" cy="22.5" r="3.6" fill="url(#mx)"/>'
  ),
  exxen: svgRaw(
    '<rect x="10" y="7" width="120" height="30" rx="6" fill="#ffcb05"/>' +
    '<text x="70" y="28.5" text-anchor="middle" fill="#09090b" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="21" letter-spacing="2.2">EXXEN</text>'
  ),
  blutv: svgRaw(
    '<text x="45" y="30" text-anchor="middle" fill="#00a8ff" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="25" letter-spacing="-0.5">blu</text>' +
    '<rect x="70" y="9" width="38" height="26" rx="13" fill="#00a8ff"/>' +
    '<text x="89" y="27.5" text-anchor="middle" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="16">tv</text>'
  ),
  gain: svgRaw(
    '<rect x="14" y="9" width="5" height="26" rx="2.5" fill="#e11d48"/>' +
    '<text x="76" y="30" text-anchor="middle" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="25" letter-spacing="2.5">GAİN</text>' +
    '<circle cx="91.5" cy="10.5" r="2.6" fill="#e11d48"/>'
  ),
  tod: svgRaw(
    '<defs><linearGradient id="td" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#e879f9"/><stop offset="100%" stop-color="#9333ea"/></linearGradient></defs>' +
    '<rect x="16" y="7" width="108" height="30" rx="8" fill="url(#td)" fill-opacity="0.18" stroke="url(#td)" stroke-width="2"/>' +
    '<text x="70" y="29" text-anchor="middle" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="23" letter-spacing="3">TOD</text>' +
    '<circle cx="70" cy="22" r="4.2" fill="#e879f9"/>'
  ),
  tabii: svgRaw(
    '<text x="66" y="30" text-anchor="middle" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="25" letter-spacing="-0.6">tabii</text>' +
    '<circle cx="85" cy="11" r="3" fill="#00e5a3"/>' +
    '<circle cx="93.5" cy="11" r="3" fill="#ec4899"/>'
  ),
  tvplus: svgRaw(
    '<rect x="14" y="8" width="44" height="28" rx="7" fill="#facc15"/>' +
    '<text x="36" y="28.5" text-anchor="middle" fill="#09090b" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="20">TV</text>' +
    '<path d="M74 14v16M66 22h16" stroke="#38bdf8" stroke-width="4" stroke-linecap="round"/>' +
    '<text x="108" y="27" text-anchor="middle" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="800" font-size="13">Turkcell</text>'
  ),
  puhutv: svgRaw(
    '<rect x="12" y="9" width="26" height="26" rx="7" fill="#ef4444"/>' +
    '<path d="M21 16v12l10-6-10-6z" fill="#ffffff"/>' +
    '<text x="84" y="29" text-anchor="middle" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="20" letter-spacing="-0.4">puhutv</text>'
  ),
  mubi: svgRaw(
    '<g fill="#0057ff"><circle cx="16" cy="14" r="2.6"/><circle cx="24" cy="14" r="2.6"/><circle cx="32" cy="14" r="2.6"/><circle cx="16" cy="22" r="2.6"/><circle cx="24" cy="22" r="2.6"/><circle cx="32" cy="22" r="2.6"/><circle cx="16" cy="30" r="2.6"/><circle cx="24" cy="30" r="2.6"/><circle cx="32" cy="30" r="2.6"/></g>' +
    '<text x="86" y="30" text-anchor="middle" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="24" letter-spacing="2">MUBI</text>'
  ),
  apple: svgRaw(
    '<path d="M35 23.5c0-3.2 2.6-4.7 2.7-4.8-1.5-2.2-3.8-2.5-4.6-2.5-2-.2-3.8 1.2-4.8 1.2-1 0-2.5-1.2-4.2-1.1-2.1 0-4.1 1.2-5.2 3.1-2.2 3.8-.6 9.5 1.6 12.6 1.1 1.5 2.3 3.2 4 3.1 1.6-.1 2.2-1 4.1-1s2.5 1 4.2 1c1.7 0 2.8-1.5 3.9-3.1 1.2-1.8 1.7-3.5 1.7-3.6-.1-.1-3.4-1.3-3.4-4.9zM31.8 14c.9-1.1 1.5-2.6 1.3-4.1-1.3.1-2.8.9-3.7 1.9-.8.9-1.5 2.5-1.3 3.9 1.5.1 2.8-.7 3.7-1.7z" fill="#ffffff"/>' +
    '<text x="82" y="30" text-anchor="middle" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="24" letter-spacing="-0.5">tv+</text>'
  ),
  hulu: svgRaw(
    '<text x="70" y="31" text-anchor="middle" fill="#1ce783" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="28" letter-spacing="-0.6">hulu</text>'
  ),
  paramount: svgRaw(
    '<path d="M70 6L52 24h36L70 6z" fill="rgba(0,100,255,0.28)" stroke="#38bdf8" stroke-width="1.8" stroke-linejoin="round"/>' +
    '<text x="70" y="35" text-anchor="middle" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="16.5" letter-spacing="-0.3">Paramount+</text>'
  ),
  peacock: svgRaw(
    '<text x="64" y="29" text-anchor="middle" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="19.5" letter-spacing="-0.3">peacock</text>' +
    '<circle cx="114" cy="14" r="2.4" fill="#facc15"/><circle cx="119" cy="17" r="2.4" fill="#f97316"/><circle cx="121" cy="22" r="2.4" fill="#ef4444"/><circle cx="119" cy="27" r="2.4" fill="#a855f7"/><circle cx="114" cy="30" r="2.4" fill="#3b82f6"/><circle cx="109" cy="27" r="2.4" fill="#10b981"/>'
  ),
  plex: svgRaw(
    '<text x="56" y="30" text-anchor="middle" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="25" letter-spacing="-0.5">ple</text>' +
    '<path d="M81 13l9 9-9 9h7l9-9-9-9h-7z" fill="#e5a00d"/>' +
    '<path d="M103 13l-6 9 6 9h-6l-6-9 6-9h6z" fill="#ffffff"/>'
  ),
  pluto: svgRaw(
    '<circle cx="24" cy="22" r="11" stroke="#facc15" stroke-width="2.5" fill="rgba(250,204,21,0.15)"/>' +
    '<text x="24" y="26.5" text-anchor="middle" fill="#facc15" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="12">tv</text>' +
    '<text x="82" y="29.5" text-anchor="middle" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="22" letter-spacing="-0.4">pluto</text>'
  ),
  kick: svgRaw(
    '<rect x="14" y="7" width="112" height="30" rx="7" fill="rgba(83,252,24,0.14)" stroke="#53fc18" stroke-width="2"/>' +
    '<text x="70" y="29.5" text-anchor="middle" fill="#53fc18" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="23" letter-spacing="2.5">KICK</text>'
  ),
  tiktok: svgRaw(
    '<path d="M27 10v15.5a4.5 4.5 0 1 1-3.5-4.4V17a8.5 8.5 0 1 0 7.5 8.4V16c1.5 1.1 3.4 1.8 5.5 1.8v-4c-2.8 0-5.2-1.8-5.5-3.8H27z" fill="#25f4ee" transform="translate(-1.5,-1)"/>' +
    '<path d="M27 10v15.5a4.5 4.5 0 1 1-3.5-4.4V17a8.5 8.5 0 1 0 7.5 8.4V16c1.5 1.1 3.4 1.8 5.5 1.8v-4c-2.8 0-5.2-1.8-5.5-3.8H27z" fill="#fe2c55" transform="translate(1.5,1)"/>' +
    '<path d="M27 10v15.5a4.5 4.5 0 1 1-3.5-4.4V17a8.5 8.5 0 1 0 7.5 8.4V16c1.5 1.1 3.4 1.8 5.5 1.8v-4c-2.8 0-5.2-1.8-5.5-3.8H27z" fill="#ffffff"/>' +
    '<text x="84" y="29" text-anchor="middle" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="20.5" letter-spacing="-0.3">TikTok</text>'
  ),
  dailymotion: svgRaw(
    '<rect x="8" y="9" width="26" height="26" rx="7" fill="#6366f1"/>' +
    '<text x="21" y="28.5" text-anchor="middle" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="19">d</text>' +
    '<text x="86" y="28" text-anchor="middle" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="800" font-size="15.5" letter-spacing="-0.3">dailymotion</text>'
  ),
  dropbox: svgRaw(
    '<path d="M20 9l-9 5.8 9 5.8 9-5.8-9-5.8zm18 0l-9 5.8 9 5.8 9-5.8-9-5.8zM11 26.4l9 5.8 9-5.8-9-5.8-9 5.8zm27-5.8l-9 5.8 9 5.8 9-5.8-9-5.8z" fill="#0061ff"/>' +
    '<text x="92" y="28.5" text-anchor="middle" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="800" font-size="18.5" letter-spacing="-0.3">Dropbox</text>'
  ),
  youtube: svgRaw(
    '<rect x="6" y="8" width="38" height="28" rx="8" fill="#ff0033"/>' +
    '<path d="M21 15.5v13l11-6.5-11-6.5z" fill="#ffffff"/>' +
    '<text x="50" y="29" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="20" letter-spacing="-0.5">YouTube</text>'
  ),
  crunchyroll: svgRaw(
    '<circle cx="22" cy="22" r="13" fill="#f47521"/>' +
    '<circle cx="24" cy="22" r="9.5" fill="#0d0f17"/>' +
    '<circle cx="26.5" cy="20.5" r="5" fill="#f47521"/>' +
    '<circle cx="28.5" cy="18.5" r="2" fill="#ffffff"/>' +
    '<text x="41" y="28" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="800" font-size="16.5" letter-spacing="-0.3">crunchyroll</text>'
  ),
  twitch: svgRaw(
    '<path d="M12 7L8 12v18h6v5l5-5h4l9-9V7H12z" fill="#9146ff"/>' +
    '<path d="M14 10h15v10l-4 4h-5l-3.5 3.5V24H14V10z" fill="#ffffff"/>' +
    '<rect x="18.5" y="13.5" width="2.4" height="6" fill="#9146ff"/><rect x="23.5" y="13.5" width="2.4" height="6" fill="#9146ff"/>' +
    '<text x="38" y="28.5" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="20.5" letter-spacing="-0.3">twitch</text>'
  ),
  vimeo: svgRaw(
    '<rect x="8" y="8" width="28" height="28" rx="8" fill="#1ab7ea"/>' +
    '<path d="M30 16.5c-.1 2.2-1.6 5.2-4.6 9-3 3.9-5.5 5.8-7.6 5.8-1.3 0-2.4-1.2-3.2-3.6l-1.7-6.4c-.6-2.4-1.3-3.6-2-3.6-.2 0-.7.3-1.6 1l-1-1.3c1-.9 2-1.8 3-2.7 1.4-1.2 2.4-1.8 3.1-1.9 1.6-.2 2.6 1 3 3.4.4 2.6.7 4.2.9 4.9.5 2.1 1 3.2 1.6 3.2.5 0 1.2-.7 2.1-2.1.9-1.5 1.3-2.5 1.4-3.3.1-1.2-.4-1.9-1.4-1.9-.5 0-1.1.1-1.6.4 1.1-3.5 3.2-5.2 6.3-5.1 2.3.1 3.4 1.6 3.3 5.2z" fill="#ffffff" transform="translate(2,0) scale(0.85)"/>' +
    '<text x="43" y="29" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="21" letter-spacing="-0.4">vimeo</text>'
  ),
  drive: svgRaw(
    '<path d="M18.5 9L9 25.5l4.8 8.3 9.5-16.5L18.5 9z" fill="#00ac47"/>' +
    '<path d="M20 9l9.5 16.5h9.5L29.5 9H20z" fill="#ffba00"/>' +
    '<path d="M18.8 26.8L14 35h19.5l4.8-8.2H18.8z" fill="#0066da"/>' +
    '<text x="44" y="28.5" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="800" font-size="19.5" letter-spacing="-0.3">Drive</text>'
  ),
  tubi: svgRaw(
    '<defs><linearGradient id="tb" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#ff3e2e"/><stop offset="100%" stop-color="#facc15"/></linearGradient></defs>' +
    '<rect x="14" y="8" width="112" height="28" rx="14" fill="url(#tb)" fill-opacity="0.18" stroke="url(#tb)" stroke-width="2"/>' +
    '<text x="70" y="29" text-anchor="middle" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="22" letter-spacing="-0.4">tubi</text>'
  ),
  web: svgRaw(
    '<circle cx="24" cy="22" r="11.5" stroke="#38bdf8" stroke-width="2.2" fill="rgba(56,189,248,0.12)"/>' +
    '<ellipse cx="24" cy="22" rx="5.2" ry="11.5" stroke="#38bdf8" stroke-width="1.8"/>' +
    '<path d="M13 22h22M14.5 16.8h19M14.5 27.2h19" stroke="#38bdf8" stroke-width="1.6"/>' +
    '<text x="44" y="28" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="800" font-size="17">Web Video</text>'
  ),
  upload: svgRaw(
    '<rect x="10" y="9" width="26" height="26" rx="8" fill="rgba(0,245,212,0.14)" stroke="#00f5d4" stroke-width="2"/>' +
    '<path d="M23 27V15M18.5 19.5L23 15l4.5 4.5M16.5 30h13" stroke="#00f5d4" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<text x="43" y="27.5" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="800" font-size="15.5">Dosya Yükle</text>'
  ),
  hdfilmcehennemi: svgRaw(
    '<defs><linearGradient id="hfc" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#ff6b00"/><stop offset="100%" stop-color="#ef4444"/></linearGradient></defs>' +
    '<rect x="6" y="7" width="30" height="30" rx="8" fill="url(#hfc)"/>' +
    '<path d="M16 14v16l13-8-13-8z" fill="#ffffff"/>' +
    '<text x="42" y="21" fill="#ff6b00" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="13" letter-spacing="0.4">SİNEMA+</text>' +
    '<text x="42" y="34" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="800" font-size="11.5" letter-spacing="0.4">1080p HD</text>'
  ),
  dizibox: svgRaw(
    '<rect x="6" y="8" width="28" height="28" rx="7" fill="#10b981"/>' +
    '<path d="M14 15h12v14H14z" fill="none" stroke="#09090b" stroke-width="2.4" rx="2"/>' +
    '<path d="M18 19v6l5-3-5-3z" fill="#09090b"/>' +
    '<text x="40" y="29" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="18.5" letter-spacing="0.6">DİZİ+</text>' +
    '<text x="88" y="29" fill="#10b981" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="15.5" letter-spacing="0.5">ARŞİV</text>'
  ),
  dizilife: svgRaw(
    '<defs><linearGradient id="dlf" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#8b5cf6"/><stop offset="100%" stop-color="#06b6d4"/></linearGradient></defs>' +
    '<rect x="6" y="8" width="28" height="28" rx="8" fill="url(#dlf)"/>' +
    '<path d="M16 15v14l11-7-11-7z" fill="#ffffff"/>' +
    '<text x="40" y="29" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="17.5" letter-spacing="0.3">SEZON+</text>' +
    '<text x="108" y="29" fill="#38bdf8" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="17.5" letter-spacing="0.3">TV</text>'
  ),
  fullhdfilm: svgRaw(
    '<rect x="6" y="9" width="34" height="26" rx="6" fill="#eab308"/>' +
    '<text x="23" y="26.5" text-anchor="middle" fill="#09090b" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="13">4K</text>' +
    '<text x="46" y="22" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="13">VİZYON 4K</text>' +
    '<text x="46" y="34" fill="#eab308" font-family="Inter,system-ui,sans-serif" font-weight="800" font-size="11">SİNEMA</text>'
  ),
  yabancidizi: svgRaw(
    '<rect x="6" y="8" width="28" height="28" rx="8" fill="rgba(6,182,212,0.2)" stroke="#06b6d4" stroke-width="2"/>' +
    '<text x="20" y="27" text-anchor="middle" fill="#06b6d4" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="13">M+</text>' +
    '<text x="39" y="22" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="13">MARATON+</text>' +
    '<text x="39" y="34" fill="#06b6d4" font-family="Inter,system-ui,sans-serif" font-weight="800" font-size="10.5">VIP ARŞİV</text>'
  ),
  ytmusic: svgRaw(
    '<circle cx="21" cy="22" r="13.5" fill="#ff0033"/>' +
    '<circle cx="21" cy="22" r="8.2" fill="none" stroke="#ffffff" stroke-width="1.6"/>' +
    '<path d="M18.5 17.8v8.4l7-4.2-7-4.2z" fill="#ffffff"/>' +
    '<text x="41" y="21" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="13">YouTube</text>' +
    '<text x="41" y="34" fill="#ff0033" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="13">MUSIC</text>'
  ),
  spotify: svgRaw(
    '<circle cx="21" cy="22" r="13.5" fill="#1db954"/>' +
    '<path d="M14.5 18.5c4.5-1.4 9.5-1.1 13.4 1.1M15.5 22.5c3.6-1.1 7.6-.8 10.8.9M16.5 26.2c2.8-.8 5.9-.6 8.4.7" stroke="#09090b" stroke-width="2.2" stroke-linecap="round"/>' +
    '<text x="41" y="28.5" fill="#1db954" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="19.5" letter-spacing="-0.4">Spotify</text>'
  ),
  deezer: svgRaw(
    '<defs><linearGradient id="dz" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#a238ff"/><stop offset="100%" stop-color="#ec4899"/></linearGradient></defs>' +
    '<rect x="7" y="23" width="4" height="10" rx="1" fill="#a238ff"/><rect x="13" y="17" width="4" height="16" rx="1" fill="#c026d3"/><rect x="19" y="12" width="4" height="21" rx="1" fill="#ec4899"/><rect x="25" y="19" width="4" height="14" rx="1" fill="#f43f5e"/>' +
    '<text x="36" y="29" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="20" letter-spacing="-0.4">deezer</text>'
  ),
  applemusic: svgRaw(
    '<rect x="6" y="8" width="28" height="28" rx="7" fill="#fa243c"/>' +
    '<path d="M24 14v10.5a2.8 2.8 0 1 1-1.8-2.6V17l-6 1.5v7a2.8 2.8 0 1 1-1.8-2.6V15.5L24 14z" fill="#ffffff"/>' +
    '<text x="40" y="21" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="13">Apple</text>' +
    '<text x="40" y="34" fill="#fa243c" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="13">Music</text>'
  ),
  soundcloud: svgRaw(
    '<rect x="6" y="8" width="28" height="28" rx="8" fill="#ff5500"/>' +
    '<path d="M14 26h13a3.5 3.5 0 0 0 .5-7 5 5 0 0 0-9.6-1.5A3.2 3.2 0 0 0 14 26z" fill="#ffffff"/>' +
    '<text x="39" y="27.5" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="15" letter-spacing="-0.3">SoundCloud</text>'
  ),
  music: svgRaw(
    '<defs><linearGradient id="mhub" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#1db954"/><stop offset="50%" stop-color="#fa243c"/><stop offset="100%" stop-color="#a238ff"/></linearGradient></defs>' +
    '<rect x="6" y="7" width="30" height="30" rx="9" fill="url(#mhub)"/>' +
    '<path d="M25 13.5v10.8a3 3 0 1 1-2-2.8V16.8l-6.5 1.6v6.9a3 3 0 1 1-2-2.8V15l10.5-1.5z" fill="#ffffff"/>' +
    '<text x="42" y="21" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="13.5" letter-spacing="0.3">MÜZİK &amp; KLİP</text>' +
    '<text x="42" y="34" fill="#1db954" font-family="Inter,system-ui,sans-serif" font-weight="800" font-size="10.2" letter-spacing="0.2">SPOTIFY · APPLE · DEEZER · YTM</text>'
  ),
  cinema: svgRaw(
    '<defs><linearGradient id="chub" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#ff6b00"/><stop offset="50%" stop-color="#e50914"/><stop offset="100%" stop-color="#8b5cf6"/></linearGradient></defs>' +
    '<rect x="6" y="7" width="30" height="30" rx="9" fill="url(#chub)"/>' +
    '<path d="M16 14v16l13-8-13-8z" fill="#ffffff"/>' +
    '<text x="42" y="21" fill="#ffffff" font-family="Inter,system-ui,sans-serif" font-weight="900" font-size="13.2" letter-spacing="0.3">SİNEMA, DİZİ &amp; ANİME+</text>' +
    '<text x="42" y="34" fill="#ffb703" font-family="Inter,system-ui,sans-serif" font-weight="800" font-size="10.2" letter-spacing="0.2">40.000+ FİLM · DİZİ · ANİMETRİX 4K</text>'
  ),
};

export const PROVIDER_CATEGORIES = [
  { id: 'all', label: '🌐 Tümü' },
  { id: 'free_tr', label: '🍿 40.000+ Sinema & Dizi' },
  { id: 'music', label: '🎵 Müzik & Klip' },
  { id: 'global', label: '🎬 Global Platformlar' },
  { id: 'tr', label: '🇹🇷 Yerli Platformlar' },
  { id: 'live', label: '🔴 Canlı & Sosyal' },
  { id: 'cloud', label: '☁️ Bulut & Araçlar' },
];

export const PROVIDERS = [
  { id: 'cinema', name: 'Sinema, Dizi & Anime+', cat: 'free_tr', badge: '40.000+ Film · Dizi · Anime · TR Dublaj & Altyazı', logo: LOGOS.cinema, bg: '#10121a', accent: '#ff6b00', web: true, kind: 'catalog', freeNoAuth: true,
    homeUrl: '', placeholder: '40.000+ ücretsiz film, yabancı dizi, Animetrix/Animecix anime ara veya bağlantı yapıştır...',
    idParser: (u) => (
      (u.match(/hdfilmcehennemi\.[a-z.]+\/((?:film|dizi|bolum)\/[\w-]+)/i) || [])[1] ||
      (u.match(/dizibox\.[a-z.]+\/((?:diziler\/)?[\w-]+(?:-izle)?)/i) || [])[1] ||
      (u.match(/dizi\d*\.(?:life|com|org)\/((?:dizi|film)\/[\w-]+)/i) || [])[1] ||
      (u.match(/(?:fullhdfilmizlesene|jetfilmizle)\.[a-z.]+\/(?:film\/)?([\w-]+)/i) || [])[1] ||
      (u.match(/yabancidizi\.[a-z.]+\/(?:dizi|izle)\/([\w-]+)/i) || [])[1] ||
      (u.match(/animecix\.[a-z.]+\/(?:titles|watch)\/([\w-]+)/i) || [])[1] ||
      (u.match(/plex\.tv\/(?:movie|show|watch)\/([\w-]+)/i) || [])[1] ||
      (u.match(/pluto\.tv\/.*?(?:movies|series|live-tv)\/([\w-]+)/i) || [])[1] ||
      (u.match(/tubitv\.com\/(?:video|movies|tv-shows|series)\/(\d+)/i) || [])[1] || null
    ) },
  { id: 'music', name: 'Müzik & Klip', cat: 'music', badge: 'Spotify · Apple Music · Deezer · YT Music · SoundCloud', logo: LOGOS.music, bg: '#10121a', accent: '#1db954', web: true, kind: 'music', freeNoAuth: true,
    homeUrl: '', placeholder: 'Spotify, Apple Music, Deezer, YouTube Music veya SoundCloud şarkı/klip ara veya bağlantı yapıştır...',
    idParser: (u) => (
      (u.match(/music\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})/i) || [])[1] ||
      (u.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?(?:track|album|playlist)\/([A-Za-z0-9]+)/i) || [])[1] ||
      (u.match(/deezer\.com\/(?:[a-z]+\/)?(?:track|album|playlist)\/(\d+)/i) || [])[1] ||
      (u.match(/music\.apple\.com\/[a-z]{2}\/(?:album|playlist|music-video|song)\/[^/]+\/(\d+)/i) || [])[1] ||
      (u.match(/soundcloud\.com\/([\w-]+\/[\w-]+)/i) || [])[1] || null
    ) },
  { id: 'netflix', name: 'Netflix', cat: 'global', badge: '4K HDR · Dizi & Film', logo: LOGOS.netflix, bg: '#10121a', accent: '#e50914', web: true, kind: 'catalog',
    homeUrl: 'https://www.netflix.com/browse', placeholder: "Netflix'te dizi, film ara veya bağlantı yapıştır...",
    idParser: (u) => (u.match(/netflix\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:watch|title)\/(\d+)/i) || [])[1] || null },
  { id: 'youtube', name: 'YouTube', cat: 'live', badge: '4K · Canlı & Video', logo: LOGOS.youtube, bg: '#10121a', accent: '#ff0033', web: true, kind: 'search',
    placeholder: "YouTube'da video, dizi veya film ara...", defaultQuery: 'resmi fragman 4K',
    idParser: (u) => (u.match(/(?:youtube\.com\/(?:[^/\n\s]+\/\s*)?(?:v\/|u\/\w\/|live\/|embed\/|watch\?v=|&v=|shorts\/)|youtu\.be\/)([^"&?/\s]{11})/i) || [])[1] || null },
  { id: 'disney', name: 'Disney+', cat: 'global', badge: 'Orijinal & Sinema', logo: LOGOS.disney, bg: '#10121a', accent: '#0063e5', web: true, kind: 'catalog',
    homeUrl: 'https://www.disneyplus.com', placeholder: "Disney+'ta dizi, film ara veya bağlantı yapıştır...",
    idParser: (u) => (u.match(/disneyplus\.com\/(?:[a-z-]+\/)?(?:play|video|movies|series)\/([\w-]+)/i) || [])[1] || null },
  { id: 'prime', name: 'Prime Video', cat: 'global', badge: 'Amazon Originals', logo: LOGOS.prime, bg: '#10121a', accent: '#00a8e1', web: true, kind: 'catalog',
    homeUrl: 'https://www.primevideo.com', placeholder: "Prime Video'da dizi, film ara veya bağlantı yapıştır...",
    idParser: (u) => (u.match(/(?:primevideo|amazon)\.[a-z.]+\/.*?(?:gti=|asin=|detail\/)([\w.-]+)/i) || [])[1] || null },
  { id: 'max', name: 'Max', cat: 'global', badge: 'HBO · Warner Bros', logo: LOGOS.max, bg: '#10121a', accent: '#2563eb', web: true, kind: 'catalog',
    homeUrl: 'https://play.max.com', placeholder: "Max'te dizi, film ara veya bağlantı yapıştır...",
    idParser: (u) => (u.match(/(?:hbomax|max)\.com\/.*?(?:video\/watch|play|movies|series)\/([\w-]+)/i) || [])[1] || null },
  { id: 'apple', name: 'Apple TV+', cat: 'global', badge: 'Apple Originals 4K', logo: LOGOS.apple, bg: '#10121a', accent: '#f8fafc', web: true, kind: 'catalog',
    homeUrl: 'https://tv.apple.com/tr', placeholder: "Apple TV+'ta dizi veya film ara...",
    idParser: (u) => (u.match(/tv\.apple\.com\/.*?(?:movie|show|episode)\/[\w-]+\/([\w.]+)/i) || [])[1] || null },
  { id: 'mubi', name: 'MUBI', cat: 'global', badge: 'Kült & Festival Sineması', logo: LOGOS.mubi, bg: '#10121a', accent: '#0057ff', web: true, kind: 'catalog',
    homeUrl: 'https://mubi.com/tr', placeholder: "MUBI'de seçkin film ara...",
    idParser: (u) => (u.match(/mubi\.com\/.*?(?:films)\/([\w-]+)/i) || [])[1] || null },
  { id: 'tod', name: 'TOD', cat: 'tr', badge: 'beIN · Dizi, Film & Spor', logo: LOGOS.tod, bg: '#10121a', accent: '#d946ef', web: true, kind: 'catalog',
    homeUrl: 'https://www.todtv.com.tr', placeholder: "TOD'da dizi veya film ara...",
    idParser: (u) => (u.match(/todtv\.com\.tr\/(?:icerik|izle|film|dizi)\/([\w-]+)/i) || [])[1] || null },
  { id: 'tabii', name: 'tabii', cat: 'tr', badge: 'TRT Dijital Orijinal', logo: LOGOS.tabii, bg: '#10121a', accent: '#00e5a3', web: true, kind: 'catalog',
    homeUrl: 'https://www.tabii.com/tr', placeholder: "tabii'de orijinal dizi veya film ara...",
    idParser: (u) => (u.match(/tabii\.com\/.*?(?:watch|detail)\/([\w-]+)/i) || [])[1] || null },
  { id: 'exxen', name: 'Exxen', cat: 'tr', badge: 'Yerli Dizi & Şov', logo: LOGOS.exxen, bg: '#10121a', accent: '#ffcb05', web: true, kind: 'catalog',
    homeUrl: 'https://www.exxen.com/tr', placeholder: "Exxen'de dizi, program veya film ara...",
    idParser: (u) => (u.match(/exxen\.com\/.*?(?:detail|watch)\/([\w-]+)/i) || [])[1] || null },
  { id: 'blutv', name: 'BluTV', cat: 'tr', badge: 'Yerli & HBO', logo: LOGOS.blutv, bg: '#10121a', accent: '#00a8ff', web: true, kind: 'catalog',
    homeUrl: 'https://www.blutv.com', placeholder: "BluTV'de dizi veya film ara...",
    idParser: (u) => (u.match(/blutv\.com\/(?:diziler|filmler|izle)\/([\w-]+)/i) || [])[1] || null },
  { id: 'gain', name: 'GAİN', cat: 'tr', badge: 'Yeni Nesil İçerik', logo: LOGOS.gain, bg: '#10121a', accent: '#e11d48', web: true, kind: 'catalog',
    homeUrl: 'https://www.gain.tv', placeholder: "GAİN'de dizi, program veya film ara...",
    idParser: (u) => (u.match(/gain\.tv\/(?:icerik|izle)\/([\w-]+)/i) || [])[1] || null },
  { id: 'tvplus', name: 'TV+', cat: 'tr', badge: 'Turkcell TV+ Sinema', logo: LOGOS.tvplus, bg: '#10121a', accent: '#facc15', web: true, kind: 'catalog',
    homeUrl: 'https://tvplus.com.tr', placeholder: "TV+'ta film veya dizi ara...",
    idParser: (u) => (u.match(/tvplus\.com\.tr\/(?:izle|film|dizi)\/([\w-]+)/i) || [])[1] || null },
  { id: 'puhutv', name: 'puhutv', cat: 'tr', badge: 'Yerli Dizi & Yeşilçam', logo: LOGOS.puhutv, bg: '#10121a', accent: '#ef4444', web: true, kind: 'catalog',
    homeUrl: 'https://puhutv.com', placeholder: "puhutv'de dizi veya film ara...",
    idParser: (u) => (u.match(/puhutv\.com\/([\w-]+)-izle/i) || [])[1] || null },
  { id: 'crunchyroll', name: 'Crunchyroll', cat: 'global', badge: 'Anime · Simulcast', logo: LOGOS.crunchyroll, bg: '#10121a', accent: '#f47521', web: true, kind: 'catalog',
    homeUrl: 'https://www.crunchyroll.com', placeholder: "Crunchyroll'da anime ara veya bağlantı yapıştır...",
    idParser: (u) => (u.match(/crunchyroll\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:watch|series)\/([A-Z0-9]+)/i) || [])[1] || null },
  { id: 'hulu', name: 'Hulu', cat: 'global', badge: 'FX & Hulu Originals', logo: LOGOS.hulu, bg: '#10121a', accent: '#1ce783', web: true, kind: 'catalog',
    homeUrl: 'https://www.hulu.com', placeholder: "Hulu'da dizi veya film ara...",
    idParser: (u) => (u.match(/hulu\.com\/(?:watch|series|movie)\/([\w-]+)/i) || [])[1] || null },
  { id: 'paramount', name: 'Paramount+', cat: 'global', badge: 'Showtime & CBS', logo: LOGOS.paramount, bg: '#10121a', accent: '#0064ff', web: true, kind: 'catalog',
    homeUrl: 'https://www.paramountplus.com', placeholder: "Paramount+'ta film veya dizi ara...",
    idParser: (u) => (u.match(/paramountplus\.com\/(?:movies|shows|video)\/([\w-]+)/i) || [])[1] || null },
  { id: 'peacock', name: 'Peacock', cat: 'global', badge: 'Universal & NBC', logo: LOGOS.peacock, bg: '#10121a', accent: '#a855f7', web: true, kind: 'catalog',
    homeUrl: 'https://www.peacocktv.com', placeholder: "Peacock'ta film veya dizi ara...",
    idParser: (u) => (u.match(/peacocktv\.com\/watch\/(?:asset|playback)\/([\w-]+)/i) || [])[1] || null },
  { id: 'twitch', name: 'Twitch', cat: 'live', badge: 'Canlı Yayın', logo: LOGOS.twitch, bg: '#10121a', accent: '#9146ff', web: true, kind: 'link', live: true,
    placeholder: 'Twitch kanal adı veya bağlantısı (twitch.tv/kanal)',
    idParser: (u) => (
      (u.match(/(?:www\.|m\.)?twitch\.tv\/(?:videos\/(\d+)|[\w-]+\/clip\/([\w-]+)|([a-z0-9_]{3,25}))/i) || []).slice(1).find(Boolean) ||
      (u.match(/clips\.twitch\.tv\/([\w-]+)/i) || [])[1] || null
    ) },
  { id: 'kick', name: 'Kick', cat: 'live', badge: 'Canlı Yayın · 60fps', logo: LOGOS.kick, bg: '#10121a', accent: '#53fc18', web: true, kind: 'link', live: true,
    placeholder: 'Kick kanal adı veya bağlantısı (kick.com/kanal)',
    idParser: (u) => (u.match(/kick\.com\/([a-z0-9_.-]{2,30})/i) || [])[1] || null },
  { id: 'tiktok', name: 'TikTok', cat: 'live', badge: 'Kısa Video & Reels', logo: LOGOS.tiktok, bg: '#10121a', accent: '#fe2c55', web: true, kind: 'link',
    placeholder: 'TikTok video bağlantısı yapıştır (tiktok.com/@.../video/...)',
    idParser: (u) => (u.match(/tiktok\.com\/.*?(?:video)\/(\d+)/i) || [])[1] || null },
  { id: 'dailymotion', name: 'Dailymotion', cat: 'live', badge: 'HD Video & Dizi', logo: LOGOS.dailymotion, bg: '#10121a', accent: '#6366f1', web: true, kind: 'link',
    placeholder: 'Dailymotion video bağlantısı yapıştır (dailymotion.com/video/...)',
    idParser: (u) => (u.match(/(?:dailymotion\.com\/video\/|dai\.ly\/)([a-z0-9]+)/i) || [])[1] || null },
  { id: 'vimeo', name: 'Vimeo', cat: 'live', badge: '4K Yönetmen Kurgu', logo: LOGOS.vimeo, bg: '#10121a', accent: '#1ab7ea', web: true, kind: 'link',
    placeholder: 'Vimeo video bağlantısı yapıştır (vimeo.com/...)',
    idParser: (u) => (u.match(/vimeo\.com\/(?:channels\/[\w]+\/|groups\/[^/]+\/videos\/|video\/)?(\d+)/i) || [])[1] || null },
  { id: 'drive', name: 'Google Drive', cat: 'cloud', badge: 'Bulut Video', logo: LOGOS.drive, bg: '#10121a', accent: '#10b981', web: true, kind: 'link', embedOnly: true,
    placeholder: 'Herkese açık Drive video bağlantısı (drive.google.com/file/d/...)',
    idParser: (u) => (u.match(/drive\.google\.com\/(?:file\/d\/|open\?id=)([\w-]{20,})/i) || [])[1] || null },
  { id: 'dropbox', name: 'Dropbox', cat: 'cloud', badge: 'Bulut MP4 / MKV', logo: LOGOS.dropbox, bg: '#10121a', accent: '#0061ff', web: true, kind: 'link',
    placeholder: 'Dropbox paylaşılan video bağlantısı yapıştır (dropbox.com/s/...)',
    idParser: (u) => (/dropbox\.com\/(?:s|scl\/fi)\//i.test(u) ? u : null) },
  { id: 'web', name: 'Web', cat: 'cloud', badge: 'MP4 · M3U8 · URL', logo: LOGOS.web, bg: '#10121a', accent: '#38bdf8', web: true, kind: 'link',
    placeholder: 'Video sayfası, .mp4 veya .m3u8 bağlantısı yapıştır',
    idParser: (u) => (/^https?:\/\//i.test(u) ? u : null) },
  { id: 'upload', name: 'Dosya Yükle', cat: 'cloud', badge: 'Yerel Video', logo: LOGOS.upload, glyph: 'upload', bg: '#10121a', accent: '#00f5d4', web: true, kind: 'upload' },
];

const CINEMA_ALIASES = ['cinema', 'hdfilmcehennemi', 'dizibox', 'dizilife', 'fullhdfilm', 'yabancidizi', 'plex', 'pluto', 'tubi'];
export const getProvider = (id) => {
  const norm = ['ytmusic', 'spotify', 'deezer', 'applemusic', 'soundcloud'].includes(id)
    ? 'music'
    : (CINEMA_ALIASES.includes(id) ? 'cinema' : (id === 'direct' || id === 'hls' ? 'web' : id));
  return PROVIDERS.find((p) => p.id === norm) || null;
};

export function parseVideoUrl(raw) {
  const url = String(raw || '').trim();
  if (!url) return null;
  for (const p of PROVIDERS) {
    if (p.id === 'web') continue;
    const id = p.idParser?.(url);
    if (id) return { provider: p.id, id, url };
  }
  if (/^https?:\/\//i.test(url)) return { provider: 'web', id: url, url };
  return null;
}

export const isDesktop = () => !!window.vortexDesktop;
export const providerUsable = (p) => !!p && (p.web || isDesktop());
