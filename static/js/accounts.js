// Third-party platform accounts — Rave model.
// Watchlivo never asks for, stores or transmits a Netflix / Disney+ / Exxen / … e-mail or password.
// Subscription platforms are opened in the Watchlivo app's in-app browser, where every participant
// signs in to the platform directly with their OWN account. Watchlivo only syncs play / pause / seek.
// Watchlivo's own login / register lives in profile.js and is unaffected.
import { h, toast, popup } from './ui.js?v=20261118_v184';
import { set, setView } from './store.js?v=20261118_v184';

// Remove any third-party account metadata older builds may have left in localStorage.
(function purgeLegacyPlatformAccounts() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const k = localStorage.key(i);
      if (k && /^vortex_accounts_v\d+/.test(k)) localStorage.removeItem(k);
    }
  } catch (_) { /* storage unavailable */ }
})();

const APP_LINKS = [
  ['/download/apk', 'Android uygulaması'],
  ['/download/windows', 'Windows uygulaması'],
  ['/download/ios', 'iPhone / iPad'],
];

// Platform sessions are owned by the platform's own site inside the in-app browser; Watchlivo
// has no record of them, so every platform reports the same "own account" state.
export function getAccount(providerId) {
  return { provider: providerId, ownAccount: true, loginSatisfied: false, accountEmail: '', profileName: '' };
}

export async function fetchAccounts() {
  set({ accounts: {} });
  return {};
}

export function launchProviderWindow(_url, title = 'Watchlivo') {
  setView('left', 'Search');
  toast(`${title}: platformu uygulamanın dahili tarayıcısında kendi hesabınla aç`);
}

export async function logoutAccount(_providerId, onReload) {
  toast('Platform oturumunu, platformun kendi sayfasından (dahili tarayıcıda) kapatabilirsin.');
  onReload?.();
}

export function ownAccountExplainer(p) {
  const name = p?.name || 'Bu platform';
  return h('div', { class: 'sel-desktop wl-account-explainer', 'data-account-provider': p?.id || '' },
    p?.logo ? h('img', { src: p.logo, alt: name }) : h('h3', { style: { margin: 0 } }, name),
    h('b', {}, `${name} ile birlikte izlemek için Watchlivo uygulamasını indir ve kendi ${name} hesabınla giriş yap`),
    h('div', { class: 'dim', style: { fontSize: '.86em', lineHeight: 1.55 } },
      `Watchlivo ${name} e-postanı veya şifreni hiçbir zaman istemez ve saklamaz. Giriş, uygulamanın dahili tarayıcısında doğrudan ${name} sayfasında yapılır; Watchlivo yalnızca oynat / duraklat / sar komutlarını eşitler.`),
    h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center' } },
      ...APP_LINKS.map(([href, label]) => h('a', { class: 'btn primary', href, style: { textDecoration: 'none' } }, label))));
}

export function openProviderLoginModal(p) {
  return popup({ title: `${p?.name || 'Platform'} · Kendi hesabınla`, content: ownAccountExplainer(p), options: [{ label: 'Kapat' }] });
}

export const openNetflixLoginModal = (p) => openProviderLoginModal(p || { id: 'netflix', name: 'Netflix' });
export const openMaxLoginModal = (p) => openProviderLoginModal(p || { id: 'max', name: 'Max' });

export function renderAccountBar() {
  return h('div', { class: 'rave-auth-wrap', style: { display: 'none' } });
}
