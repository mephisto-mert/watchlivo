// VORTEX UI core: element helper, icons, popups (Rave PopUp parity), toasts, and Dark Theme/Schema studio.
import { state, setUiPref, THEME_SCHEMAS } from './store.js?v=20261030_v26';

const SVG = (d, extra = '') => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;

export const icons = {
  close: SVG('<path d="M18 6 6 18M6 6l12 12"/>'),
  back: SVG('<path d="m15 18-6-6 6-6"/>'),
  rooms: SVG('<rect x="3" y="4" width="8" height="7" rx="2"/><rect x="13" y="4" width="8" height="7" rx="2"/><rect x="3" y="13" width="8" height="7" rx="2"/><rect x="13" y="13" width="8" height="7" rx="2"/>'),
  settings: SVG('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  searchVideo: SVG('<rect x="2" y="5" width="14" height="14" rx="2.5"/><path d="m16 10 6-3.5v11L16 14"/><path d="m7.5 9.5 4 2.5-4 2.5z" fill="currentColor" stroke="none"/>'),
  search: SVG('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
  vote: SVG('<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>'),
  addUser: SVG('<circle cx="9" cy="8" r="4"/><path d="M2 20a7 7 0 0 1 14 0"/><path d="M19 8v6M16 11h6"/>'),
  users: SVG('<circle cx="9" cy="8" r="3.8"/><path d="M2 20a6.8 6.8 0 0 1 13.6 0"/><path d="M16.2 4.5a3.5 3.5 0 0 1 0 7M22 20a6.5 6.5 0 0 0-4.6-6.2"/>'),
  map: SVG('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
  play: SVG('<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>'),
  pause: SVG('<rect x="6" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none"/><rect x="14" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none"/>'),
  skip: SVG('<path d="M5 4.5v15l10-7.5z" fill="currentColor" stroke="none"/><path d="M19 5v14"/>'),
  rewind10: SVG('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M9.5 14.5v-5l-1.2 1"/><rect x="12" y="9.5" width="3.2" height="5" rx="1.5"/>'),
  forward10: SVG('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M9.5 14.5v-5l-1.2 1"/><rect x="12" y="9.5" width="3.2" height="5" rx="1.5"/>'),
  subtitles: SVG('<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M10.2 10.2a2.2 2.2 0 1 0 0 3.6M16.4 10.2a2.2 2.2 0 1 0 0 3.6"/>'),
  volume: SVG('<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>'),
  mute: SVG('<path d="M11 5 6 9H2v6h4l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>'),
  fullscreen: SVG('<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>'),
  gear: SVG('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  mic: SVG('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5"/>'),
  micOff: SVG('<path d="m2 2 20 20"/><path d="M9 9v1a3 3 0 0 0 5.1 2.1M15 9.3V5a3 3 0 0 0-5.9-.7"/><path d="M5 10a7 7 0 0 0 11.7 5.2M19 10a7 7 0 0 1-.5 2.6M12 17v5"/>'),
  camera: SVG('<path d="m16 10 5-3v10l-5-3"/><rect x="2" y="6" width="14" height="12" rx="2.5"/>'),
  cameraOff: SVG('<path d="m2 2 20 20"/><path d="M10.6 6H14a2 2 0 0 1 2 2v2.5l5-3v9"/><path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2"/>'),
  screenShare: SVG('<rect x="2" y="3" width="20" height="14" rx="2.5"/><path d="M8 21h8M12 17v4"/><path d="m9 10 3-3 3 3M12 7v6"/>'),
  snapshot: SVG('<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>'),
  episodes: SVG('<rect x="3" y="7" width="14" height="11" rx="2"/><path d="M7 4h12a2 2 0 0 1 2 2v9"/>'),
  poll: SVG('<path d="M18 20V10M12 20V4M6 20v-6"/>'),
  sparkle: SVG('<path d="m12 3 1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/><path d="M19 16v4M17 18h4"/>'),
  audioWave: SVG('<path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/>'),
  pip: SVG('<rect x="2" y="4" width="20" height="15" rx="2.5"/><rect x="12" y="11" width="7" height="5" rx="1" fill="currentColor"/>'),
  minimize: SVG('<rect x="2" y="4" width="20" height="15" rx="2.5"/><rect x="12" y="11" width="7" height="5" rx="1" fill="currentColor"/><path d="M6 8l4 4M10 8v4H6"/>'),
  expand: SVG('<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>'),
  speed: SVG('<path d="M12 14 15.5 9.5"/><path d="M3.3 17a10 10 0 1 1 17.4 0"/>'),
  externalLink: SVG('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>'),
  reply: SVG('<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>'),
  send: SVG('<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>'),
  smile: SVG('<circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/>'),
  gif: SVG('<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M10 10H8a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h2v-2M13 10v4M16 14v-4h3M16 12h2"/>'),
  share: SVG('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>'),
  copy: SVG('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  globe: SVG('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/>'),
  lock: SVG('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  friends: SVG('<circle cx="8" cy="9" r="3"/><circle cx="16" cy="9" r="3"/><path d="M2 20a6 6 0 0 1 12 0M10 20a6 6 0 0 1 12 0"/>'),
  nearby: SVG('<path d="M12 21s-7-6.3-7-12a7 7 0 0 1 14 0c0 5.7-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/>'),
  hidden: SVG('<path d="m2 2 20 20"/><path d="M6.7 6.7C4 8.4 2 12 2 12s3.6 7 10 7c1.9 0 3.6-.6 5-1.5M10.6 5.1C11 5 11.5 5 12 5c6.4 0 10 7 10 7a17.7 17.7 0 0 1-2.4 3.3"/>'),
  crown: SVG('<path d="m2 7 5 5 5-8 5 8 5-5-2 12H4z" fill="currentColor" stroke="none"/>'),
  kick: SVG('<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l-5-5 5-5M5 12h12"/>'),
  plus: SVG('<path d="M12 5v14M5 12h14"/>'),
  trash: SVG('<path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15"/>'),
  link: SVG('<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>'),
  upload: SVG('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>'),
  desktop: SVG('<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>'),
  download: SVG('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>'),
  android: SVG('<path d="M5 16v6M19 16v6M6 18h12a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2zm3-13 1.5 2.5m6-2.5L15 7.5M9 12h.01M15 12h.01"/>'),
  windows: SVG('<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>'),
  sync: SVG('<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>'),
  chat: SVG('<path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z"/>'),
  theater: SVG('<rect x="2" y="4" width="20" height="16" rx="2.5"/><path d="M16 4v16"/>'),
  panelRightClose: SVG('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/><path d="m10 15 3-3-3-3"/>'),
  panelRightOpen: SVG('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/><path d="m12 9-3 3 3 3"/>'),
  phoneCall: SVG('<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.58 2.81.7A2 2 0 0 1 22 16.92z"/>'),
  phoneOff: SVG('<path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.58 2.81.7A2 2 0 0 1 22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91"/><line x1="2" y1="2" x2="22" y2="22"/>'),
  headphones: SVG('<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>'),
  headphonesOff: SVG('<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 14.36-7.24"/><path d="M21 14h-3a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-5"/><line x1="2" y1="2" x2="22" y2="22"/>'),
  clock: SVG('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>'),
  barChart: SVG('<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>'),
  qr: SVG('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM18 18h3v3h-3zM18 14h3M14 18v3"/>'),
  swap: SVG('<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>'),
  layoutGrid: SVG('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>'),
  sliders: SVG('<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>'),
  chevronRight: SVG('<polyline points="9 18 15 12 9 6"/>'),
  cameraSnap: SVG('<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>'),
  palette: SVG('<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.6-.7 1.6-1.6 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.6 1.6-1.6H16c3.3 0 6-2.7 6-6 0-4.9-4.5-8.6-10-8.6z"/>'),
};

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sv === undefined || sv === null) continue;
        if (sk.startsWith('--')) el.style.setProperty(sk, String(sv));
        else el.style[sk] = sv;
      }
    }
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const icon = (name) => h('span', { html: icons[name] || '', style: { display: 'inline-flex' } });

// replaceChildren() stringifies null/false ("null" text); fill() drops them like h() does.
export const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));

export function toast(text, ms = 2600) {
  const t = h('div', { class: 'toast acrylic' }, text);
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  let host = document.getElementById('toast-root');
  if (fsEl && host && !fsEl.contains(host)) {
    fsEl.appendChild(host);
  } else if (!fsEl && host && host.parentElement !== document.body) {
    document.body.appendChild(host);
  }
  (host || document.body).append(t);
  setTimeout(() => t.remove(), ms);
}

// Rave PopUp: { title, message, options:[{label, primary, danger, onClick}], content(Node), dismissable }
export function popup({ title, message, options = [], content = null, dismissable = true } = {}) {
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  const root = document.getElementById('popup-root');
  if (fsEl && root && !fsEl.contains(root)) {
    fsEl.appendChild(root);
  } else if (!fsEl && root && root.parentElement !== document.body) {
    document.body.appendChild(root);
  }
  const onKey = (e) => {
    if (e.key === 'Escape' && dismissable) {
      close();
    }
  };
  const close = () => {
    window.removeEventListener('keydown', onKey);
    back.remove();
  };
  if (dismissable) window.addEventListener('keydown', onKey);
  const closeBtn = dismissable
    ? h('button', {
        type: 'button',
        class: 'popup-close-x',
        'aria-label': 'Kapat',
        title: 'Kapat (ESC)',
        onclick: () => close(),
        html: icons.close,
      })
    : null;
  const card = h('div', { class: 'popup acrylic', role: 'dialog', 'aria-modal': 'true' },
    closeBtn,
    title ? h('h3', { class: dismissable ? 'popup-title-pad' : '' }, title) : null,
    message ? h('p', {}, message) : null,
    content,
    options.length ? h('div', { class: 'popup-options' }, options.map((o) =>
      h('button', { class: `btn ${o.primary ? 'primary' : ''} ${o.danger ? 'danger' : ''}`, onclick: async () => { const keep = await o.onClick?.(); if (keep !== true) close(); } }, o.label))) : null);
  const back = h('div', { class: 'popup-backdrop', onclick: (e) => { if (dismissable && e.target === back) close(); } }, card);
  root.append(back);
  return { close, card };
}

export const confirmPopup = (message, yes = 'Evet', no = 'Hayır') => new Promise((resolve) => {
  popup({ message, dismissable: false, options: [
    { label: yes, primary: true, onClick: () => resolve(true) },
    { label: no, onClick: () => resolve(false) },
  ] });
});

export function fmtTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return hh ? `${hh}:${p(mm)}:${p(ss)}` : `${mm}:${p(ss)}`;
}

export function setBackground(url) {
  const img = document.getElementById('bg-img');
  if (!img) return;
  if (!url) {
    img.classList.remove('on');
    img.removeAttribute('src');
    delete img.dataset.src;
    img.style.display = 'none';
    return;
  }
  img.style.display = '';
  if (img.dataset.src === url) return;
  img.dataset.src = url;
  img.classList.remove('on');
  img.onload = () => img.classList.add('on');
  img.src = url;
}

const DEFAULT_OPENAI_KEY = '';
const DEFAULT_SUNO_KEY = '';

export function getAiApiConfig() {
  return {
    openaiModel: localStorage.getItem('kinox_openai_model') || 'gpt-6.1-sol',
    openaiKey: localStorage.getItem('kinox_openai_key') || DEFAULT_OPENAI_KEY,
    sunoModel: localStorage.getItem('kinox_suno_model') || 'suno-v4.5-mureka-9.5',
    sunoKey: localStorage.getItem('kinox_suno_key') || DEFAULT_SUNO_KEY,
  };
}

export function openAiConfigModal(onSaved) {
  const cur = getAiApiConfig();
  const modelInp = h('input', { class: 'input', value: cur.openaiModel, placeholder: 'Dil & DJ Modeli (örn. claude-sonnet-4-5, deepseek-v3)' });
  const keyInp = h('input', { class: 'input', type: 'password', value: cur.openaiKey, placeholder: 'Özel AI API Anahtarı (isteğe bağlı)' });
  const sunoModelInp = h('input', { class: 'input', value: cur.sunoModel, placeholder: 'Müzik Motoru (örn. suno-v4.5-mureka-9.5)' });
  const sunoKeyInp = h('input', { class: 'input', type: 'password', value: cur.sunoKey, placeholder: 'Özel Suno/Mureka API Anahtarı (isteğe bağlı)' });
  const box = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
    h('div', { class: 'dim', style: { fontSize: '.83rem', lineHeight: '1.45' } },
      'Watchlivo AI DJ, şarkı sözü senkronizasyonu ve müzik üretim motoru ayarlarını buradan yapılandırabilirsiniz.'),
    h('label', { style: { fontSize: '.78rem', fontWeight: '700' } }, 'AI DJ & Sohbet Modeli'),
    modelInp,
    keyInp,
    h('label', { style: { fontSize: '.78rem', fontWeight: '700' } }, 'Suno / Mureka Müzik Motoru'),
    sunoModelInp,
    sunoKeyInp
  );
  popup({
    title: '🔑 AI & Müzik Motoru Yapılandırması',
    content: box,
    options: [
      {
        label: '✓ Ayarları Kaydet',
        primary: true,
        onClick: () => {
          try {
            localStorage.setItem('kinox_openai_model', modelInp.value.trim() || 'gpt-6.1-sol');
            localStorage.setItem('kinox_openai_key', keyInp.value.trim());
            localStorage.setItem('kinox_suno_model', sunoModelInp.value.trim() || 'suno-v4.5-mureka-9.5');
            localStorage.setItem('kinox_suno_key', sunoKeyInp.value.trim());
          } catch (_) {}
          toast('✓ AI & Model yapılandırması kaydedildi');
          onSaved?.(getAiApiConfig());
        },
      },
      { label: 'Kapat' },
    ],
  });
}

export function buildThemeStudio() {
  const wrap = h('div', { class: 'theme-studio' });
  const draw = () => {
    const scroller = wrap.closest('.popup, .panel-body');
    const prevScroll = scroller ? scroller.scrollTop : 0;
    const prefs = state.uiPrefs || { theme: 'obsidian', ambient: 'low', density: 'comfortable', cardStyle: 'glass' };

    wrap.replaceChildren(
      h('div', { class: 'theme-sec-title' }, '🎨 Koyu Tema Şeması (Dark Mode)'),
      h('div', { class: 'theme-grid' }, THEME_SCHEMAS.map((t) =>
        h('button', {
          type: 'button',
          class: `theme-card ${prefs.theme === t.id ? 'on' : ''}`,
          'data-theme-id': t.id,
          onclick: () => { setUiPref({ theme: t.id }); draw(); },
        },
          h('span', { class: 'theme-swatch', style: { background: t.swatch, '--swatch-accent': t.accent } },
            h('span', { class: 'theme-swatch-dot', style: { background: t.accent } })),
          h('div', { class: 'theme-meta' },
            h('b', {}, t.name),
            h('small', {}, t.desc))))),
      h('div', { class: 'theme-sec-title' }, '✨ Sahne Ambiyans Işığı'),
      h('div', { class: 'seg' }, [
        ['off', 'Kapalı', 'Saf siyah arka plan'],
        ['low', 'Loş Sinema', 'Göz yormayan hafif ambiyans'],
        ['medium', 'Canlı Sinema', 'Poster renklerine göre ışıltı'],
      ].map(([k, lbl, dsc]) => h('button', {
        type: 'button',
        class: prefs.ambient === k ? 'on' : '',
        onclick: () => { setUiPref({ ambient: k }); draw(); },
      }, lbl, h('small', {}, dsc)))),
      h('div', { class: 'theme-sec-title' }, '📐 Arayüz & Kart Görünümü'),
      h('div', { class: 'seg' }, [
        ['comfortable', 'Geniş Görünüm', 'Standart sinema kartları'],
        ['compact', 'Kompakt Grid', 'Daha fazla içerik sığdır'],
      ].map(([k, lbl, dsc]) => h('button', {
        type: 'button',
        class: prefs.density === k ? 'on' : '',
        onclick: () => { setUiPref({ density: k }); draw(); },
      }, lbl, h('small', {}, dsc)))));
    if (scroller && prevScroll > 0) scroller.scrollTop = prevScroll;
  };
  draw();
  return wrap;
}

export function openThemeModal() {
  const box = h('div', { class: 'theme-modal-body' },
    buildThemeStudio(),
    h('div', { class: 'theme-sec-title', style: { marginTop: '1.2em' } }, '📲 Watchlivo Resmi Uygulamaları'),
    h('div', { class: 'wl-modal-download-actions' },
      h('a', {
        class: 'btn primary wl-btn-apk-dl',
        href: '/download/apk',
        download: 'Watchlivo-v1.1.0.apk',
        onclick: () => toast('📱 Android APK indiriliyor...', 4000)
      }, h('span', { html: icons.android, style: { display: 'flex' } }), 'Android APK İndir (v1.1)'),
      h('a', {
        class: 'btn wl-btn-win-dl',
        href: '/download/windows',
        download: 'Watchlivo.exe',
        onclick: () => toast('💻 Windows Masaüstü indiriliyor...', 4000)
      }, h('span', { html: icons.windows || icons.desktop, style: { display: 'flex' } }), 'Windows İndir (EXE)'))
  );
  popup({ title: 'Görünüm & Uygulama İndir', content: box, options: [{ label: 'Tamam', primary: true }] });
}

export function openDownloadModal() {
  const box = h('div', { class: 'wl-download-modal' },
    h('div', { class: 'wl-download-header' },
      h('h3', {}, '📱 Watchlivo Cihaz Uygulamaları'),
      h('p', {}, 'Tek tıkla, tam ekran, yüksek performans ve arkadaşlarınla sıfır gecikmeli izle.')
    ),
    h('div', { class: 'wl-download-grid' },
      h('div', { class: 'wl-download-card apk' },
        h('div', { class: 'wl-download-icon' }, h('span', { html: icons.android, style: { display: 'flex' } })),
        h('div', { class: 'wl-download-info' },
          h('b', {}, 'Android Uygulaması (APK)'),
          h('small', {}, 'v1.1.0 • Android 5.0+ Tüm Telefon & Tabletler'),
          h('p', {}, 'Hızlı bağlantı, senkron odalar, reklamsız tam ekran oynatıcı.')
        ),
        h('a', {
          class: 'btn primary wl-download-action',
          href: '/download/apk',
          download: 'Watchlivo-v1.1.0.apk',
          onclick: () => toast('📱 Android APK indiriliyor...', 4000)
        }, h('span', { html: icons.download, style: { display: 'flex' } }), 'APK İndir (.apk)')
      ),
      h('div', { class: 'wl-download-card windows' },
        h('div', { class: 'wl-download-icon' }, h('span', { html: icons.windows || icons.desktop, style: { display: 'flex' } })),
        h('div', { class: 'wl-download-info' },
          h('b', {}, 'Windows Masaüstü'),
          h('small', {}, 'v1.1.0 • Windows 10 / 11 64-bit'),
          h('p', {}, 'Masaüstü donma önleyici, ultra düşük gecikme ve sistem bildirimleri.')
        ),
        h('a', {
          class: 'btn wl-download-action',
          href: '/download/windows',
          download: 'Watchlivo.exe',
          onclick: () => toast('💻 Windows Masaüstü indiriliyor...', 4000)
        }, h('span', { html: icons.download, style: { display: 'flex' } }), 'Windows İndir (.exe)')
      )
    ),
    h('div', { class: 'wl-download-footer-note' },
      'ℹ️ İndirilen APK dosyasını açmak için cihazınızda "Bilinmeyen kaynaklardan yüklemeye izin ver" seçeneğini onaylayabilirsiniz.'
    )
  );
  popup({ title: 'Watchlivo İndir', content: box, options: [{ label: 'Kapat', primary: true }] });
}
