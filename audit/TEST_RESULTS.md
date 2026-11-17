# Watchlivo (`watchlivo.online`) — Kapsamlı Test Sonuçları ve Kalite Güvence Raporu (`v134`)

- **Denetim Tarihi:** 6 Kasım 2026
- **Hedef Sürüm:** `20261106_v134`
- **Genel Durum:** **TÜM OTOMATİK VE ÇALIŞMA ZAMANI TESTLERİ GEÇTİ (`0` Başarısız Test)**

---

## 1. Test Katmanları Özeti

| Test Katmanı | Araç / Çerçeve | Kapsam | Sonuç | Süre |
| :--- | :--- | :--- | :---: | :---: |
| **Python Sözdizimi & Derleme** | `py_compile` (Python 3.12) | 25 Python sunucu ve test modülü | **25 / 25 GEÇTİ** | `0.8 sn` |
| **JavaScript ES Modül Sözdizimi** | `node --check` | 33 JS modülü (`bootstrap.js`, `desktop-auth.js`, `hls-loader.js` dahil) + `sw.js` | **33 / 33 GEÇTİ** | `1.9 sn` |
| **Backend & Protokol Regresyon Paketi** | `pytest` (`Starlette TestClient`) | 4 test dosyasında 89 birim ve entegrasyon testi (`test_v134` dahil) | **89 / 89 GEÇTİ** | `107.0 sn` |
| **Sıkı CSP, Kod Bölme & Lazy HLS Doğrulaması** | `verify_v134_runtime_csp_and_perf.py` | `/` (`165.1 KB` GZip JS), `#/mesh/cinema-club` (`hlsLazyLoaded: true`), `/contact`, `/stats`, `/desktop-auth` | **`0` CSP İhlali / `0` Hata** | `9.8 sn` |
| **Çoklu Tarayıcı E2E Kullanıcı Akışları** | Playwright (`chromium`, `chrome`, `firefox`, `webkit`) | Arama, oda açma, sohbet, küçültme (PiP), geri yükleme, çıkış, XSS | **4 / 4 Motor GEÇTİ** | `27.5 sn` |
| **21 Çözünürlük Responsive & A11y Denetimi** | Playwright Viewport Matrisi (`320×568` – `3440×1440`) | `Home` + `Mesh` (42 ekran durumu), taşma, buton adı, `alt`, input boyutu | **42 / 42 Durum GEÇTİ** | `41.0 sn` |
| **Güvenlik, Sınır Değer, Tema & Bellek Denetimi** | `deep_functional_and_security_audit.py` | SSRF, SQLi, bozuk JSON, yetkisiz host eylemi, 8 tema kontrastı, `Escape`, Heap | **%100 GEÇTİ** | `14.2 sn` |

---

## 2. `pytest` Regresyon Paketleri Dökümü (`89 / 89` Başarılı)

1. **`tests/test_regressions.py` (63 test — `test_v133` & `test_v134` dahil):**
   - Oda oluşturma, lider/ortak mod geçişleri, yardımcı yönetici (`Co-Host`) atama ve devir zinciri.
   - Odadan çıkıp geri girildiğinde aktif liderin canlı saniyesine (`currentTime` + duvar saati ilerlemesi) saliselik senkronizasyon (`v132` & `v133`).
   - Kaldığın saniyeden devam etme (`epProgress`), sezon finalinden yeni sezona geçiş (`S1:B9 -> S2:B1`), önceki/sonraki bölüm sınır kontrolleri.
   - HLS büyük segment (`.ts` > 5 MB, `.m4s` > 3 MB) kesintisiz aktarım ve bozuk akış önbellek zehirlenmesi koruması.
   - Android APK (`PK\x03\x04`) ve iOS ARM64 IPA (`\xcf\xfa\xed\xfe`) ikili doğrulamaları.
   - **`test_v133` Yeni Regresyon Kontrolleri:** Bozuk/dizi JSON reddi (`400`), `_precreated` oda ele geçirme engeli, `/api/auth/logout` oturum jetonu iptali, kilitli odada `/r/{id}` `r_tok` gizleme, `/api/upload` kimliksiz (`401`) ve sahte başlıklı `.mp4` (`415`) engeli, yetkisiz GA4 yazma engeli (`403`), iletişim e-postası maskeleme (`s***@example.com`), `SelectiveGZipMiddleware` sıkıştırma ve ikili APK muafiyeti, Electron `sandbox: true` ve `role="slider"` erişilebilirlik sözleşmeleri.
   - **`test_v134` Faz-2 Kontrolleri:** `vercel.json` ve `server.py` içinde `script-src` `'unsafe-inline'` yokluğu, `/r/{id}`, `/contact` ve `/stats` üzerinde istek başına benzersiz kriptografik `'nonce-...'` doğrulaması, `main.js` dinamik `import('./views/mesh.js')` + `hls-loader.js` sözleşmeleri ve `RateLimiter` tek-RTT Redis Lua `EVAL` atomik hız sınırlama doğrulaması.
2. **`tests/test_rooms_sync.py` (7 senaryo):**
   - Çoklu cihazda aynı kullanıcı adıyla sahte liderlik gasbı engeli, lider yenileme (`refresh`) sonrası yetki koruma ve izleyici `seek` reddi.
3. **`tests/test_v83_social_history_ui.py` (10 test):**
   - Hesaplar arası izleme geçmişi/liste izolasyonu, arkadaşlık isteği/kabul/iptal döngüsü, DM mesajlaşma ve `20261106_v134` önbellek sürümü tutarlılığı.
4. **`tests/test_v89_twenty_agent_audit.py` (9 test):**
   - Yerel şifrenin yetkisiz Firebase girişiyle ezilmemesi (`_PASSWORD_RESET_PENDING` kilidi), `targetUid="*"` bildirim doğrulaması, ölü akış (`-1`) filtrelemesi ve hız sınırlayıcı kontrolleri.

---

## 3. 7 Boyutlu Fonksiyonel Senaryo Matrisi

| Fonksiyon / Akış | 1. Normal Kullanım | 2. Boş Veri | 3. Hatalı Veri | 4. Sınır Değerler | 5. Ağ / Soğuk Başlangıç | 6. Tekrarlanan İşlem | 7. Yetkisiz Kullanım |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Kayıt & Giriş (`/api/auth/*`)** | Geçti | `400` Uyarı | SQLi / Bozuk E-posta `400/401` | Şifre `<6` red, `128` krk sınır | Yerel + KV yedekleme | Çift kayıt `409` | İptal edilmiş jeton `false` |
| **Oda Oluşturma (`/api/rooms/create`)** | Geçti | Varsayılan güvenli oda | Bozuk JSON `400` | `10.000` krk ad -> `80` krk kırpma, `rate: 99999 -> 1.0` | `syncToken` ile durum kurtarma | Çift tıklama tekil oda | `_precreated` dış gasp engelli |
| **Oda Senkronizasyonu (`/sync` & WS)** | Geçti | Eksik alanlarda güvenli varsayılan | `NaN` / negatif saniye -> `0.0` | `season: -50 -> 0`, geri sarma koruması | WS kopuşunda HTTP poll geçişi | Aynı `syncToken` idempotent | İzleyici `pause/seek/close` engelli |
| **Arkadaş & DM (`/api/rave/social/*`)** | Geçti | Boş arama `[]` | Geçersiz `@handle` uyarısı | Mesaj uzunluk kırpma, `80` mesaj penceresi | KV zaman aşımı koruması | Çift arkadaşlık isteği tekil | Arkadaş olmayana `canMessage: false` |
| **Medya & Dosya Yükleme (`/api/upload`)** | Geçti | Dosyasız form `400` | `.png` / `.svg` `400`, sahte `.mp4` `415` | `>1 GB` `413`, kota `507` | Kesilen yüklemede yetim dosya silme | Hız sınırı (`429`) | Girişsiz yükleme `401` |
| **İletişim & Raporlama (`/contact`)** | Geçti | Boş ad/mesaj `400` | Geçersiz kategori varsayılana döner | `1200` karakter sınırı | Çift tıklama korumalı form | Hız sınırlı | E-posta maskeli (`s***@...`) |

---

## 4. WCAG 2.1 AA Erişilebilirlik ve Klavye Doğrulaması

- **8 Tema Kontrast Ölçümü (`deep_audit_post.json`):**
  - Vurgu butonu kontrastları (`--accent` / `--accent-ink`): `supabase` **`11.16:1`**, `catppuccin` **`10.95:1`**, `mint` **`10.28:1`**, `amber` **`9.03:1`**, `vercel` **`9.00:1`**, `indigo` **`7.76:1`** *(onarım öncesi `3.68:1` idi)*, `t3chat` **`7.66:1`**, `graphite` **`6.65:1`** (tümü WCAG AA `4.5:1` ve neredeyse tamamı AAA `7.0:1` üzerinde).
  - Gövde metni kontrastları: **`18.72:1` – `19.28:1`**.
- **Klavye & Ekran Okuyucu Kontrolleri:**
  - `.skip-link` (`Ana içeriğe atla`), `<main id="home-main">`, tüm açılır pencerelerde `Escape` ile kapanma (`closedOnEscape: true`), `Tab` / `Shift+Tab` odak tuzağı ve kapanışta önceki öğeye odak iadesi, video zaman çubuğunda `role="slider"` + `ArrowLeft/Right` `±5 sn` sarma doğrulandı.
