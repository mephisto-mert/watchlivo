# Cloudflare Worker Dağıtımı (watchlivo-ha-gateway)

`workers/ha-gateway/` altındaki Worker, `watchlivo.online` alan adının önünde duran kenar (edge) ağ geçididir:

- **Origin yönlendirme / failover:** İstekleri birincil origin'e (Vercel) ya da ikincil origin'e (Render EU, `SECONDARY_ORIGIN`) iletir; biri kapalıysa diğerine geçer. `FORCE_SECONDARY = "1"` iken doğrudan Render kullanılır.
- **Oda senkronu:** `edge_rooms.js` içindeki `WatchlivoRoomDO` Durable Object'i, her iki origin de erişilemezse odaların oynat/duraklat/ileri sar senkronunu ve WebSocket bağlantılarını kenarda sürdürür.
- **Otonom yedek mod:** `edge_autonomous.js` origin'ler kapalıyken SPA'yı, statik dosyaları, KV tabanlı oturum açmayı ve oda listesini sunar. `edge_music.js` müzik meta verisini (iTunes/Deezer arama, LRCLIB şarkı sözleri) sağlar.
- **Cron:** 10 dakikada bir Render origin'ine `/api/health` isteği atarak uyanık tutar.

Worker hiçbir video akışını proxy'lemez veya yeniden yayınlamaz; abonelik servisleri kullanıcının kendi hesabıyla uygulama içi tarayıcıda oynatılır, sunucu yalnızca senkron komutlarını taşır.

## Gereksinimler

- Node.js 18+ ve Wrangler: `npm install -g wrangler` (veya `npx wrangler`)
- `watchlivo.online` zone'una erişimi olan bir Cloudflare hesabı: `wrangler login`
- `wrangler.toml` içindeki KV namespace (`WATCHLIVO_KV`) hesabınızda mevcut olmalı. Yoksa:
  `wrangler kv namespace create WATCHLIVO_KV` ve çıkan `id`'yi `wrangler.toml`'a yazın.

## 1. Statik dosya paketini oluşturma

Worker, `[assets]` ile `workers/ha-gateway/public/` klasörünü sunar (git'e eklenmez, `.gitignore`'da). Dağıtımdan önce oluşturun:

```bash
python scripts/build_edge_bundle.py
```

Bu betik `static/` klasörünü, `index.html`, manifest ve sürüm dosyalarını `public/` altına kopyalar ve `public/_edge/bootstrap.json` dosyasını (sürüm + doğrudan oynatılabilir hazır odalar) üretir. Yerel sunucu `http://127.0.0.1:8080` üzerinde çalışıyorsa hazır oda listesi oradan alınır; çalışmıyorsa önceki paket ya da Worker'daki varsayılan liste kullanılır.

## 2. Gizli değişkenler (secrets)

```bash
cd workers/ha-gateway
wrangler secret put ADMIN_SECRET          # /api/ha-status detayları ve admin işlemleri
wrangler secret put EDGE_ORIGIN_SECRET    # origin'e iletilen X-Watchlivo-Edge-Secret başlığı
wrangler secret put PROXY_SECRET          # oda / istemci token imzalama anahtarı
wrangler secret put GOOGLE_CLIENT_ID      # (isteğe bağlı) Google kimlik token'ı aud doğrulaması
wrangler secret put FIREBASE_WEB_API_KEY  # (isteğe bağlı) Firebase kimlik doğrulaması
```

İsteğe bağlı değişkenler (`[vars]` veya secret): `SECONDARY_ORIGIN`, `TERTIARY_ORIGIN`, `FORCE_SECONDARY`.

## 3. Dağıtım

```bash
cd workers/ha-gateway
wrangler deploy
```

İlk dağıtımda `[[migrations]]` bloğu `WatchlivoRoomDO` Durable Object sınıfını oluşturur.

## 4. Doğrulama

```bash
curl -s https://watchlivo.online/api/ha-status
curl -s https://watchlivo.online/api/health
```

Yanıt başlığındaki `X-Watchlivo-Origin` değeri isteğin hangi origin'den (`vercel-primary`, `render-eu-failover`, `render-eu-stateful`, `cf-autonomous-edge` ...) karşılandığını gösterir. Canlı logları izlemek için: `wrangler tail`.

## WAF / kötüye kullanım koruması

`deploy/cloudflare_waf_rules.json`, Cloudflare panelinde (Security → WAF) elle ya da API ile uygulanabilecek olağan kötüye kullanım kurallarını içerir: API'ye gelen düşük bot skorlu trafiğe challenge, giriş uç noktalarına ve genel API'ye IP başına hız sınırı.
