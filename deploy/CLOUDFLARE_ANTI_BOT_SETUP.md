# Watchlivo — Cloudflare WAF, Bot & Telif Kalkanı Kurulum Kılavuzu

Bu belge, Watchlivo'yu telif tarama botlarından, DMCA örümceklerinden ve otomatik kazıyıcılardan (scrapers) Cloudflare seviyesinde tam korumaya almak için hazırlanmıştır.

---

### 1. Cloudflare WAF Özel Kuralı (Managed Challenge & ASN Blokajı)
Cloudflare Dashboard > **Security** > **WAF** > **Custom Rules** > **Create Rule**:

- **Kural Adı:** `Watchlivo - Block Scrapers & Datacenter Bots`
- **İfade (Expression):**
  ```text
  (cf.bot_management.score lt 30) or 
  (ip.geoip.asnum in {16509 14618 16276 24940 14061 51167 63949}) or
  (http.user_agent contains "Scrapy") or
  (http.user_agent contains "Bytespider") or
  (http.user_agent contains "PetalBot") or
  (http.user_agent contains "AhrefsBot") or
  (http.user_agent contains "SemrushBot")
  ```
- **Aksiyon:** `Managed Challenge` (veya `Block`)

---

### 2. Cloudflare Transform Rules (HTTP Yanıt Başlıkları)
Cloudflare Dashboard > **Rules** > **Transform Rules** > **Modify Response Header**:

- **Kural Adı:** `Watchlivo - Force NoIndex Edge Shield`
- **Koşul:** `All incoming requests`
- **Başlık Ekle:**
  - **Operator:** `Set Dynamic` veya `Set Static`
  - **Header Name:** `X-Robots-Tag`
  - **Value:** `noindex, nofollow, noarchive, nosnippet, noimageindex, nocache`

---

### 3. Hotlink & Cross-Site Koruması
Cloudflare Dashboard > **Security** > **WAF** > **Custom Rules**:

- **Kural Adı:** `Watchlivo - Stream Hotlink Protection`
- **İfade:**
  ```text
  (http.request.uri.path contains "/api/rave/stream" or http.request.uri.path contains "/api/rave/resolve-catalog") and 
  (http.request.headers["sec-fetch-site"][0] eq "cross-site")
  ```
- **Aksiyon:** `Block`

---

### 4. Bot Fight Mode
Cloudflare Dashboard > **Security** > **Bots**:
- **Bot Fight Mode:** `ON`
