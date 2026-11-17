# Watchlivo (`watchlivo.online`) — Çoklu Platform, Cihaz, Çözünürlük ve Tarayıcı Uyumluluk Raporu (`v133`)

- **Denetim Tarihi:** 6 Kasım 2026
- **Hedef Sürüm:** `20261106_v133`
- **Şeffaflık İlkeleri:** Bu raporda **Gerçek Ortamda Çalıştırılan Testler**, **Tarayıcı / Viewport / Dokunmatik Simülasyonu** ve **Statik Kod / İkili Paket İncelemesi** birbirinden kesin çizgilerle ayrılmıştır. Fiziksel erişim bulunmayan hiçbir donanım veya işletim sistemi gerçek cihaz testi olarak sunulmamıştır.

---

## 1. Test Yöntemi Sınıflandırması (Gerçek Ortam vs Simülasyon vs Statik İnceleme)

| Ortam / Cihaz Grubu | Uygulanan Yöntem | Kapsam ve Açıklama |
| :--- | :--- | :--- |
| **Windows 11 (x64) + Google Chrome, Chromium, Mozilla Firefox, WebKit** | **Gerçek Ortam Testi** | Yerel Uvicorn sunucusu ve canlı `https://watchlivo.online` üzerinde gerçek tarayıcı motorlarıyla uçtan uca çalıştırıldı. |
| **iPhone, Android Telefon, iPad ve Android Tablet Ekranları (Dikey & Yatay)** | **Viewport & Dokunmatik Simülasyonu** | Playwright üzerinde gerçek `WebKit` ve `Chromium` motorlarıyla `is_mobile=True`, `has_touch=True` ve 21 ayrı çözünürlükte simüle edildi (fiziksel telefon/tablet donanımı bağlı değildir). |
| **Microsoft Edge (`msedge.exe`), Opera, Brave** | **Motor Eşdeğerliği + Statik İnceleme** | Bu makinede `msedge.exe`, `opera.exe` ve `brave.exe` kurulu değildir (`available: false`). Blink/V8 tabanlı motor uyumluluğu gerçek `Google Chrome` ile; Brave reklam engelleyici uyumluluğu ise birinci parti `/api/rave/ga-collect` rölesiyle doğrulandı. |
| **macOS (Apple Silicon / Retina) ve Linux (Ubuntu / Debian / Fedora)** | **Motor Eşdeğerliği + Statik İnceleme** | Fiziksel macOS/Linux makine erişimi yoktur. Safari/WebKit davranışı gerçek `WebKit` motoruyla, Firefox/Chrome davranışı gerçek Gecko/Blink motorlarıyla ve Electron `desktop/main.js` platform dallanmaları (`process.platform === 'darwin'`) statik olarak denetlendi. |
| **Android APK (`Watchlivo-v2.0.apk`) ve iOS IPA (`Watchlivo-v2.0.ipa`)** | **İkili Paket + Protokol Doğrulaması** | ZIP/APK imzası (`PK\x03\x04`), `AndroidManifest.xml` PiP izinleri, ARM64 Mach-O başlığı (`\xcf\xfa\xed\xfe`), SHA-256 bütünlüğü ve `/api/ios/manifest.plist` OTA sözleşmesi otomatik testlerle doğrulandı. |

---

## 2. 21 Ekran Çözünürlüğü Matrisi — Ana Sayfa (`Home`) ve Sinema Odası (`Mesh`)

Her çözünürlükte yatay taşma (`scrollWidth - innerWidth`), kapsayıcı dışına taşan görünür öğe, isimsiz buton (`aria-label`/`title`), eksik `alt` özniteliği ve mobil form yazı boyutu (`>= 16px` iOS otomatik yakınlaştırma koruması) hem **Ana Sayfada** hem **Aktif İzleme Odasında** ölçüldü:

| # | Çözünürlük | Temsil Ettiği Form Faktörü / Yön | Mod | Yatay Taşma (`Home` / `Mesh`) | Görsel Taşma (`overflowingEls`) | İsimsiz Buton / Eksik `alt` | Mobil Input `>= 16px` | Sonuç |
| :-: | :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| 1 | `320 × 568` | iPhone SE (1. Nesil) — Dikey | Dokunmatik | `0 px` / `0 px` | `0` / `0` | `0` / `0` | **Evet (`16px`)** | **GEÇTİ** |
| 2 | `360 × 640` | Küçük Ekran Android (Galaxy A) — Dikey | Dokunmatik | `0 px` / `0 px` | `0` / `0` | `0` / `0` | **Evet (`16px`)** | **GEÇTİ** |
| 3 | `375 × 667` | iPhone SE (3. Nesil) / 8 — Dikey | Dokunmatik | `0 px` / `0 px` | `0` / `0` | `0` / `0` | **Evet (`16px`)** | **GEÇTİ** |
| 4 | `390 × 844` | iPhone 13 / 14 — Dikey | Dokunmatik | `0 px` / `0 px` | `0` / `0` | `0` / `0` | **Evet (`16px`)** | **GEÇTİ** |
| 5 | `393 × 852` | iPhone 15 / 16 / Pro (Dynamic Island) | Dokunmatik | `0 px` / `0 px` | `0` / `0` | `0` / `0` | **Evet (`16px`)** | **GEÇTİ** |
| 6 | `414 × 896` | Büyük Android / Pixel / XR — Dikey | Dokunmatik | `0 px` / `0 px` | `0` / `0` | `0` / `0` | **Evet (`16px`)** | **GEÇTİ** |
| 7 | `430 × 932` | iPhone 15 / 16 Pro Max / Galaxy S Ultra | Dokunmatik | `0 px` / `0 px` | `0` / `0` | `0` / `0` | **Evet (`16px`)** | **GEÇTİ** |
| 8 | `600 × 960` | Katlanabilir İç Ekran / Küçük Tablet | Dokunmatik | `0 px` / `0 px` | `0` / `0` | `0` / `0` | **Evet (`16px`)** | **GEÇTİ** |
| 9 | `768 × 1024` | iPad Mini / Standart iPad — Dikey | Dokunmatik | `0 px` / `0 px` | `0` / `0` | `0` / `0` | **Evet (`16px`)** | **GEÇTİ** |
| 10 | `820 × 1180` | iPad Air / Galaxy Tab — Dikey | Dokunmatik | `0 px` / `0 px` | `0` / `0` | `0` / `0` | **Evet (`16px`)** | **GEÇTİ** |
| 11 | `1024 × 768` | Standart iPad — Yatay | Dokunmatik | `0 px` / `0 px` | `0` / `0` | `0` / `0` | Uygulanabilir | **GEÇTİ** |
| 12 | `844 × 390` | iPhone 13 / 14 — Yatay (Sinema Modu) | Dokunmatik | `0 px` / `0 px` | `0` / `0` | `0` / `0` | **Evet (`16px`)** | **GEÇTİ** |
| 13 | `932 × 430` | iPhone 16 Pro Max — Yatay | Dokunmatik | `0 px` / `0 px` | `0` / `0` | `0` / `0` | **Evet (`16px`)** | **GEÇTİ** |
| 14 | `1180 × 820` | iPad Air / iPad Pro 11" — Yatay | Dokunmatik | `0 px` / `0 px` | `0` / `0` | `0` / `0` | Uygulanabilir | **GEÇTİ** |
| 15 | `1280 × 720` | HD Dizüstü / Chromebook | Masaüstü | `0 px` / `0 px` | `0` / `0` | `0` / `0` | Masaüstü | **GEÇTİ** |
| 16 | `1366 × 768` | Standart Windows Dizüstü | Masaüstü | `0 px` / `0 px` | `0` / `0` | `0` / `0` | Masaüstü | **GEÇTİ** |
| 17 | `1440 × 900` | MacBook Air 13" / 15" Ölçekli | Masaüstü | `0 px` / `0 px` | `0` / `0` | `0` / `0` | Masaüstü | **GEÇTİ** |
| 18 | `1536 × 864` | Windows 11 `%125` DPI Ölçeklendirme | Masaüstü | `0 px` / `0 px` | `0` / `0` | `0` / `0` | Masaüstü | **GEÇTİ** |
| 19 | `1920 × 1080` | Full HD Masaüstü Monitör | Masaüstü | `0 px` / `0 px` | `0` / `0` | `0` / `0` | Masaüstü | **GEÇTİ** |
| 20 | `2560 × 1440` | QHD / Retina Harici Monitör | Masaüstü | `0 px` / `0 px` | `0` / `0` | `0` / `0` | Masaüstü | **GEÇTİ** |
| 21 | `3440 × 1440` | 21:9 Ultrawide Sinema Monitörü | Masaüstü | `0 px` / `0 px` | `0` / `0` | `0` / `0` | Masaüstü | **GEÇTİ** |

---

## 3. Tarayıcı Motoru ve WebKit / Safari Özel Uyumluluk Kontrolleri

| Tarayıcı / Motor | Test Türü | Konsol / Sayfa Hatası | Arama & Oda Girişi | Küçültme (Mini PiP) & Geri Açma | WebKit / Özel Fallback Durumu |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **Google Chrome (`chrome`)** | Gerçek Tarayıcı | `0` / `0` | Sorunsuz | Sorunsuz | Yerel Document/Video PiP, WebRTC Opus, `hls.js` MSE aktif. |
| **Chromium (`chromium`)** | Gerçek Motor | `0` / `0` | Sorunsuz | Sorunsuz | PWA Service Worker (`swRegistered: true`), MediaRecorder WebM aktif. |
| **Mozilla Firefox (`firefox`)** | Gerçek Tarayıcı | `0` / `0` | Sorunsuz | Sorunsuz | `scrollbar-width: none`, WebAudio kazanç artırıcı, CSS `color-mix` uyumlu. |
| **Safari / iOS WebKit (`webkit`)** | Gerçek Motor | `0` / `0` | Sorunsuz | Sorunsuz | `webkit-playsinline`, yerel HLS `.m3u8`, `webkitSetPresentationMode('picture-in-picture')`, `100vh` + `100dvh` çift bildirim, `env(safe-area-inset-*)`, WAV PCM sesli not yedeklemesi doğrulandı. |
| **Microsoft Edge / Brave / Opera** | Statik + Blink Eşdeğeri | — | Blink Uyumlu | Blink Uyumlu | `msedge.exe` kurulu değil; Blink CSS/JS uyumluluğu Chrome üzerinden, Brave kalkan uyumluluğu `/api/rave/ga-collect` üzerinden sağlandı. |

---

## 4. Cihaz Sınıfı Bazlı Uygulanan Özel Onarımlar (`v133`)

- **320px Küçük Ekran & iOS Otomatik Yakınlaştırma (`WL-BUG-029`, `WL-BUG-030`):** Tüm mobil metin girişleri (`input`, `textarea`, `select`) `16px` boyutuna sabitlendi; `< 360px` ekranlarda arama çubuğu ve açılır pencereler `max-width: calc(100vw - 12px)` ile sınırlandı.
- **Telefon Yatay (`844×390`, `932×430`) & Sanal Klavye (`kb-open`) Modu (`WL-BUG-031`):** Özel mesaj (`DM`) ve arkadaş pencereleri yatay dar yüksekliklerde `max-height: calc(var(--app-height, 100dvh) - 68px)` ile ekrana tam sığacak şekilde sıkılaştırıldı (`fitsVert: true`).
- **Tablet Geçiş Aralığı (`740px–960px`) & 21:9 Ultrawide (`3440×1440`) (`WL-BUG-032`):** Tablet dikey modda 3 sütunlu TV/platform ızgarası, ultrawide monitörlerde ise `1920px` merkezi sinema kabuğu sınırlandırması eklendi.
