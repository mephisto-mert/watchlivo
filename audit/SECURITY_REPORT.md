# Watchlivo (`watchlivo.online`) — Güvenlik Denetimi ve Sıkılaştırma Raporu (`v134`)

- **Denetim Tarihi:** 6 Kasım 2026
- **Hedef Sürüm:** `20261106_v134`
- **Kapsam:** Kimlik doğrulama, oturum yönetimi, oda yetkilendirmesi, SSRF, XSS, sıkı nonce tabanlı `script-src` CSP, tek-RTT Redis Lua hız sınırlama, dosya yükleme güvenliği, HTTP başlıkları, sunucusuz sırlar (`VORTEX_SECRET`, `ADMIN_SECRET`), istemci depolama ve Electron masaüstü güvenliği.

---

## 1. Yönetici Özeti

Denetim başlangıcında kimlik doğrulama sırrı (`server_secret`), yeni oluşturulan odalarda lider yetkisi devralma (`_precreated` hijack), WebRTC DataChannel üzerinden sahte senkronizasyon paketi enjeksiyonu, çıkış sonrası oturum jetonu geçerliliği ve kilitli oda davet bağlantılarında `r_tok` sızıntısı dahil olmak üzere **16 güvenlik ve yetkilendirme bulgusu** tespit edildi. Tümü `20261106_v133` sürümünde doğrudan kod üzerinde giderilerek otomatik regresyon ve canlı HTTP güvenlik problarıyla doğrulandı.

---

## 2. Tespit Edilen ve Kapatılan Güvenlik Bulguları

| Kod | Önem | Bulgu Özeti | Uygulanan Kalıcı Çözüm (Dosya) | Durum |
| :--- | :---: | :--- | :--- | :---: |
| `WL-BUG-001` | **P0** | Sabit yedek HMAC sırrı (`vortex-2026-default-hmac-key-...`) | `VORTEX_SECRET` yoksa süreç bazlı `secrets.token_hex(32)` CSPRNG üretimi zorunlu kılındı (`security.py`). | Çözüldü |
| `WL-BUG-002` | **P0** | `/api/rooms/create` sonrası `_precreated` koltuğunun dış katılımcı tarafından ele geçirilmesi | İlk katılımcı sahiplenmesi `creator_uid` ve ön-üretilmiş `clientToken` doğrulamasına bağlandı (`rooms.py`). | Çözüldü |
| `WL-BUG-003` | **P0** | Bozuk JSON gövdesinde `/api/rooms/create` uç noktasının `200 OK` ile varsayılan oda açması | Hatalı veya sözlük olmayan JSON gövdelerinde `400 Bad Request` döndürülmesi sağlandı (`rooms.py`). | Çözüldü |
| `WL-BUG-004` | **P0** | WebRTC P2P DataChannel `sync` mesajlarında lider doğrulaması olmaması | `voice.js` içinde gönderici eşin (`peerId`) aktif `state.mesh.hostId` veya `coHostIds` üyesi olması şart koşuldu. | Çözüldü |
| `WL-BUG-006` | **P1** | `/api/auth/logout` çağrısında HMAC oturum jetonunun sunucuda iptal edilmemesi | `revoke_auth_token()` ve KV destekli `_REVOKED_TOKENS` kara listesi eklendi (`auth_engine.py`). | Çözüldü |
| `WL-BUG-007` | **P1** | Sabit kodlu yedek `VAULT_KEY` şifreleme anahtarı | Ortam değişkeni yoksa `server_secret()` üzerinden SHA-256 anahtar türetimi uygulandı (`auth_engine.py`). | Çözüldü |
| `WL-BUG-008` | **P1** | Şifreli odalarda `/r/{id}` paylaşım sayfasının şifresiz isteklerde `r_tok` üretmesi | `can_expose_rtok` kontrolüyle geçerli `pwd` doğrulanmadan `r_tok` sızıntısı engellendi (`server.py`). | Çözüldü |
| `WL-BUG-009` | **P1** | Odadan atılan (`kick`) kullanıcının yeni sekme/`clientId` ile geri girebilmesi | Engel kontrolü hem `clientId` hem kalıcı `uid` (`banned_uids`) düzeyinde zorunlu kılındı (`rooms.py`). | Çözüldü |
| `WL-BUG-010` | **P1** | `client_ip()` fonksiyonunun doğrulanmamış `X-Forwarded-For` dizesini kabul etmesi | `ipaddress.ip_address()` doğrulaması eklendi; sahte/bozuk başlıklarda soket IP adresine düşülüyor (`security.py`). | Çözüldü |
| `WL-BUG-011` | **P1** | `/api/upload` uç noktasında yalnızca uzantı kontrolü yapılması | Kimlik doğrulama (`401`) + ilk 512 bayt sihirli bayt (`MZ`, `ELF`, `#!`, `<svg`, `<html`, `<script`) kontrolü (`415`) eklendi (`server.py`). | Çözüldü |
| `WL-BUG-012` | **P1** | `/api/rave/analytics` POST ile kimliksiz GA4 Ölçüm Kimliği değiştirilebilmesi | `gaMeasurementId` yazma işlemi `_is_admin_request()` (`ADMIN_SECRET` HMAC) yetkisine kilitlendi (`403`, `server.py`). | Çözüldü |
| `WL-BUG-013` | **P1** | `/api/rave/contact` GET ve `/stats` üzerinde gönderici e-postalarının açık görünmesi | Yönetici olmayan tüm yanıt ve görünümlerde `_mask_email()` (`s***@example.com`) maskelemesi uygulandı (`server.py`). | Çözüldü |
| `WL-BUG-014` | **P1** | `targetUid="*"` bildirim yayınında aktif oda doğrulaması eksikliği | Göndericinin odada bulunması ve `roomId` değerinin aktif `rooms.STORE` kaydına karşılık gelmesi zorunlu kılındı (`social_engine.py`). | Çözüldü |
| `WL-BUG-015` | **P1** | QR davet görseli isteğinde üçüncü taraf servise `pwd` ve `r_tok` gönderilmesi | Harici QR API'sine giden URL'den `pwd` ve `r_tok` parametreleri temizlendi (`controls.js`). | Çözüldü |
| `WL-BUG-016` | **P1** | Electron `BrowserWindow` yapılandırmasında `sandbox: true` eksikliği | Ana pencere ve OAuth pencerelerinde `sandbox: true`, `nodeIntegration: false`, `contextIsolation: true` ve `https:` kilitlendi (`desktop/main.js`). | Çözüldü |
| `WL-BUG-033` | **P2** | Gömülü oynatıcı `postMessage` dinleyicisinde kaynak (`event.source`) kontrolü olmaması | Yalnızca aktif `iframe.contentWindow` kaynağından gelen mesajlar işleniyor (`players/embed.js`). | Çözüldü |
| `WL-BUG-036` | **P2** | `Permissions-Policy` başlığında geçersiz sözdizimi ve `.vercelignore` eksikliği | W3C uyumlu `Permissions-Policy` başlığı yazıldı; `.env*`, `*.db`, `tests/`, `audit/` `.vercelignore` ile dışlandı. | Çözüldü |
| `WL-BUG-043` | **P3** | `script-src` CSP içinde `'unsafe-inline'` ve satır içi betikler/`onclick=` | Satır içi betikler `bootstrap.js` ve `desktop-auth.js` dosyalarına taşındı; sunucu HTML rotalarına istek bazlı `'nonce-...'` eklendi ve `script-src` içinden `'unsafe-inline'` tamamen kaldırıldı (`server.py`, `vercel.json`). | Çözüldü (`v134`) |
| `WL-BUG-045` | **P3** | Çoklu RTT Redis `RateLimiter` ve Vercel `ADMIN_SECRET` eksikliği | `security.py` `RateLimiter.hit()` tek-RTT atomik Lua `EVAL` (`INCR`+`PEXPIRE`+`PTTL`) yapısına geçirildi; Vercel `Production`/`Preview`/`Development` ortamlarına CSPRNG `ADMIN_SECRET` tanımlandı. | Çözüldü (`v134`) |

---

## 3. Çalışma Zamanı Güvenlik ve Sınır Testi Sonuçları (Doğrulanmış Çıktılar)

| Güvenlik Testi / Vektör | Beklenen Davranış | Gerçekleşen Sonuç | Durum |
| :--- | :--- | :--- | :---: |
| `POST /api/rooms/create` bozuk JSON (`{bad_json`) | `400` + Stack trace sızmaması | `HTTP 400`, `safe: true` | **GEÇTİ** |
| `POST /api/rooms/{id}/sync` yetkisiz `close_room` (`h_attacker99`) | Odanın kapanmaması (`roomClosed: false`) | `HTTP 200`, `blocked: true` | **GEÇTİ** |
| `GET /api/rave/stream?u=http://127.0.0.1:22/` (Loopback SSRF) | `400` Engelleme | `HTTP 400`, `blocked: true` | **GEÇTİ** |
| `GET /api/rave/stream?u=http://169.254.169.254/latest/meta-data/` (Cloud Metadata SSRF) | `400` Engelleme | `HTTP 400`, `blocked: true` | **GEÇTİ** |
| `GET /api/rave/stream?u=file:///C:/Windows/win.ini` (`file://` LFI) | `400` Engelleme | `HTTP 400`, `blocked: true` | **GEÇTİ** |
| `GET /api/rave/stream?u=http://[::1]:80/` (IPv6 Loopback SSRF) | `400` Engelleme | `HTTP 400`, `blocked: true` | **GEÇTİ** |
| `POST /api/upload` kimliksiz SVG/HTML yükleme | `401 Unauthorized` | `HTTP 401` | **GEÇTİ** |
| `POST /api/upload` kimlikli `.mp4` uzantılı gizlenmiş `<svg onload=...>` | `415 Unsupported Media Type` | `HTTP 415` | **GEÇTİ** |
| `POST /api/auth/login` SQLi yükü (`' OR 1=1 --`) | `401` + Parametreli sorgu koruması | `HTTP 401`, `blocked: true` | **GEÇTİ** |
| `POST /api/auth/logout` sonrası aynı `Bearer` jetonla `/api/auth/me` | `authenticated: false` | `authenticated: false` | **GEÇTİ** |
| `GET /r/{locked_id}?r_tok=...` şifresiz istekte `r_tok` sızıntısı | HTML içinde `r_tok=` bulunmaması | Sızıntı yok (`NotIn`) | **GEÇTİ** |
| `POST /api/rave/analytics` yetkisiz `gaMeasurementId` yazma | `403 Forbidden` | `HTTP 403` | **GEÇTİ** |
| Arama ve sohbet alanlarına `<img src=x onerror="window.__xssTriggered=true">` | DOM düğümü olarak metinleştirme (`xssTriggered: false`) | 4 tarayıcıda `false` | **GEÇTİ** |

---

## 4. Üretim Ortamı Güvenlik Durumu (`v134` Faz-2 Tamamlandı)

1. **Üretim Ortam Sırları Doğrulandı (`VORTEX_SECRET`, `ADMIN_SECRET`, `KV_REST_API_URL`, `REDIS_URL`):** Vercel üretim, önizleme ve geliştirme ortamlarında yüksek entropili `VORTEX_SECRET`, `ADMIN_SECRET` ve Upstash Redis bağlantı sırlarının tamamı aktif ve doğrulanmıştır.
2. **Sıkı `script-src` CSP (`'unsafe-inline'` Kaldırıldı):** Hem Vercel Edge (`vercel.json`) hem de Starlette (`server.py` `SecurityHeaders`) katmanında `script-src` içerisinden `'unsafe-inline'` tamamen çıkarılmış; dinamik sunucu sayfalarında (`/r/{id}`, `/contact`, `/dmca`, `/stats`, `/api/rave/browser-proxy`) istek başına üretilen kriptografik `'nonce-...'` ve `no-store` önbellek koruması devreye alınmıştır (`0` CSP ihlali).
3. **Atomik Küresel Hız Sınırlama (`RateLimiter` Lua `EVAL`):** Dağıtık sunucusuz örnekler arasında tek HTTP turunda (`1 RTT`) atomik sayaç artırma ve milisaniye bazlı TTL (`PEXPIRE`/`PTTL`) garantisi sağlanmıştır.
