# Watchlivo (`watchlivo.online`) — Performans Ölçümleri ve Optimizasyon Raporu (`v134`)

- **Denetim Tarihi:** 6 Kasım 2026
- **Hedef Sürüm:** `20261106_v134`
- **Ölçüm Ortamı:** Windows 11 üzerinde gerçek `Chromium`, `Google Chrome`, `Mozilla Firefox` ve `WebKit` (Safari motoru) tarayıcı örnekleri (`Navigation Timing L2`, `Paint Timing`, `Resource Timing` ve `performance.memory`).

---

## 1. Önce / Sonra Ağ Aktarım Boyutu Karşılaştırması (`v133` GZip + `v134` Kod Bölme)

Denetim öncesinde Starlette uygulama katmanında sıkıştırma ara katmanı (`GZipMiddleware`) bulunmadığı için tüm ES modülleri, CSS dosyaları ve JSON yanıtları sıkıştırılmamış olarak taşınıyordu. `v133` sürümünde **`SelectiveGZipMiddleware`** eklendi; `v134` sürümünde ise `main.js` içinde **dinamik `import('./views/mesh.js')` kod bölme**, **`hls-loader.js` ile isteğe bağlı `hls.min.js` yükleme** ve **tembel Firebase SDK başlatma** uygulanarak oda/oynatıcı modülleri ana sayfa ilk açılışından tamamen ayrıldı:

| Metrik (İlk Açılış Aktarımı — `/`) | Onarım Öncesi (Sıkıştırmasız) | `v133` (GZip) | `v134` (GZip + Code-Splitting) | Toplam İyileşme |
| :--- | :---: | :---: | :---: | :---: |
| **JavaScript Aktarımı (Chromium / Chrome)** | `1,390 KB` (`29+1` dosya) | `450 KB` | **`165.1 KB` (`15` dosya)** | **-%88.1** |
| **CSS Aktarımı (`vortex.css` + `mesh.css`)** | `438 KB` | `76 KB` | **`76.0 KB`** | **-%82.6** |
| **Toplam JS + CSS İlk Yükleme (Chrome)** | **`1,828 KB` (~1.83 MB)** | `526 KB` | **`241.1 KB` (~0.24 MB)** | **-%86.8 (-1.59 MB)** |

---

## 2. Tarayıcı Motorlarına Göre Yüklenme ve Boyama Metrikleri (`1366×768`)

| Tarayıcı Motoru | TTFB | FCP (İlk İçerikli Boyama) | DOMContentLoaded | Tam Yükleme (`load`) | Toplam Kaynak | JS + CSS Aktarımı |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Chromium (Headless)** | `1 ms` | `808 ms` | `729 ms` | `751 ms` | `63` | `450 KB + 76 KB` |
| **Google Chrome (Gerçek)** | `1 ms` | `1,272 ms` | `751 ms` | `774 ms` | `65` | `450 KB + 76 KB` |
| **Mozilla Firefox (Gecko)** | `1 ms` | `1,087 ms` | `1,170 ms` | `2,247 ms` | `62` | `389 KB + 76 KB` |
| **WebKit (Safari Motoru)** | `1 ms` | `778 ms` | `768 ms` | `768 ms` | `75` | `330 KB + 76 KB` |

---

## 3. Uygulanan Backend, Bellek ve GPU Render Optimizasyonları

1. **Seçici GZip Sıkıştırma (`SelectiveGZipMiddleware` — `server.py`):**
   - `minimum_size=1000` eşiğiyle HTML, JS, CSS, JSON ve VTT yanıtlarını sıkıştırır; HLS `.ts`/`.m4s` segmentlerini ve APK/IPA indirmelerini atlayarak CPU/bellek şişmesini ve `206 Partial Content` bozulmasını önler.
2. **Sınırsız Büyüyen Sunucu Önbelleklerine LRU Sınırı (`WL-BUG-037`, `WL-BUG-038`):**
   - `auth_engine.py` içindeki `_PHONE_CODES` sözlüğü `OrderedDict` tabanlı **2.000 kayıtlık LRU** yapısına dönüştürüldü ve süresi dolan OTP kayıtları otomatik temizlendi.
   - `music_engine.py` içindeki YouTube önbelleği **512 kayıt**, şarkı sözü (`.vtt`) önbelleği **256 kayıt** üst sınırıyla sınırlandırıldı.
3. **Sürekli Birleştirme (`Compositor`) ve Pil Tüketimi İyileştirmeleri (`WL-BUG-039`, `WL-BUG-040`):**
   - `static/css/vortex.css` içindeki `.poster-card` ve `.lobby-card` sınıflarından kalıcı `will-change: transform` kaldırılarak yüzlerce kart açıkken GPU doku belleği (VRAM) şişmesi önlendi; yalnızca `:hover` / `:focus-visible` anında etkinleştirildi.
   - `static/css/mesh.css` içindeki danmaku kayan yazı animasyonu `left` yerine GPU hızlandırmalı **`transform: translate3d(...)`** kullanacak şekilde yeniden yazıldı; ana iş parçacığı yeniden yerleşim (`layout thrashing`) maliyeti sıfırlandı.
4. **Dinamik `import()` Kod Bölme & İsteğe Bağlı `hls.min.js` (`WL-BUG-044` — `v134`):**
   - `static/js/main.js` içindeki statik `views/mesh.js` bağımlılığı dinamik `import('./views/mesh.js')` yapısına taşındı; 15 oda/oynatıcı/WebRTC modülü ana sayfa yükünden tamamen koparıldı (`loadedMeshOnHome: false`).
   - `static/index.html` içinden `hls.min.js` kaldırılarak `static/js/players/hls-loader.js` (`ensureHlsJs`) ile yalnızca odaya/videoya girildiğinde asenkron yüklenmesi sağlandı (`loadedHlsOnHome: false`, `hlsLazyLoaded: true`).
   - `static/js/profile.js` içinde açılış modalında gereksiz peşin Firebase SDK indirmesi kaldırıldı; yalnızca kullanıcı Google/SMS butonuna bastığında yükleniyor.
5. **Bellek Sızıntısı ve Yaşam Döngüsü Doğrulaması (`5×` Oda Giriş/Çıkış Döngüsü):**
   - `Home ⇄ Mesh` arasında art arda 5 tam oda oluşturma, bağlanma ve ayrılma döngüsü koşturuldu:
     - **Başlangıç JS Heap:** `9.54 MB`
     - **5 Döngü Sonu JS Heap:** `9.54 MB` (**`Δ = 0.00 MB`** — zamanlayıcı, WebSocket, `AudioContext` ve DOM referansları `leaveMeshView` ile eksiksiz temizlenmektedir).
   - **DOM Düğüm Sayısı:** Ana sayfada `~940` düğüm, tam dolu sinema odasında `~1.812` düğüm (önerilen `< 1.500–2.000` sağlıklı eşik aralığında).

---

## 4. Sonraki İsteğe Bağlı İyileştirme Notu

1. **Görsel Format Dönüşümü (`AVIF` / `WebP`):** Statik OG ve tanıtım görsellerinin çoklu çözünürlüklü `srcset` + `WebP` varyantlarıyla sunulması LCP süresini düşük bant genişlikli mobil ağlarda %15–25 iyileştirebilir.
