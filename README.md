# Watchlivo — Birlikte Sinema, Dizi & Müzik Platformu

Watchlivo; arkadaşlarınızla gerçek zamanlı senkronize video izleme, müzik dinleme ve oda sohbeti sunan modern bir medya platformudur.

🌐 **Canlı Web Sitesi:** [watchlivo.online](https://watchlivo.online)
📱 **Android APK:** [watchlivo.online/download/apk](https://watchlivo.online/download/apk)
💻 **Windows İstemcisi:** [watchlivo.online/download/windows](https://watchlivo.online/download/windows)

---

## 🚀 Özellikler

Watchlivo, Rave modelinde çalışan bir birlikte izleme platformudur: herkes içeriği **kendi hesabıyla ve kendi cihazında** oynatır, Watchlivo yalnızca oynat / duraklat / ileri-geri sar komutlarını oda üyeleri arasında senkronize eder.

- **Kendi aboneliğinizle senkron izleme:** Netflix, Disney+, Prime Video, Max ve benzeri servisler uygulama içi tarayıcıda, her katılımcının kendi hesabıyla açılır. Watchlivo bu servislerin şifrelerini istemez, saklamaz ve video akışlarını hiçbir zaman proxy'lemez ya da yeniden yayınlamaz; yalnızca oynatma durumunu (konum, oynat/duraklat) eşitler. İçeriği izleyebilmek için her katılımcının ilgili servise kendi üyeliği olmalıdır.
- **Doğrudan oynatma:** YouTube, Vimeo, Twitch, Google Drive bağlantıları ve kendi yüklediğiniz videolar resmi oynatıcılarla ya da doğrudan dosyadan oynatılır.
- **Müzik & DJ:** Müzik arama ve keşif (iTunes/Deezer meta verisi), senkron şarkı sözleri, RaveDJ mashup ve ortak çalma listeleri.
- **Odalar:** Herkese açık, gizli veya şifreli odalar; Lider / Co-Host / oylama modları, sıra (queue), liderlik devri ve kopma sonrası konumu koruyan yeniden bağlanma.
- **Sohbet & ses:** Oda içi yazılı sohbet, emoji tepkileri, anketler, sesli notlar, canlı sesli sohbet, arkadaşlar, özel mesajlar ve oda davetleri.
- **Hassas senkron:** Saat (NTP benzeri) ofset düzeltmesi ve drift telafisiyle milisaniye düzeyinde oda senkronu; WebSocket kopunca HTTP polling'e otomatik geçiş.
- **Çoklu platform:** Web (PWA), Android APK (OTA güncellemeli), iOS ve Windows masaüstü istemcisi.
- **Kimlik doğrulama:** E-posta/şifre, Google OAuth ve (Twilio anahtarı varsa) telefon ile giriş.

---

## 🛠️ Kurulum & Yerel Çalıştırma

### Gereksinimler

- Python 3.10+
- Node.js 18+ (yalnızca masaüstü kabuğu için)

### Adımlar

1. Depoyu klonlayın:

   ```bash
   git clone <depo-adresi> watchlivo
   cd watchlivo
   ```

2. Gereksinimleri yükleyin:

   ```bash
   pip install -r requirements.txt
   ```

3. Çevre değişkenlerini ayarlayın:

   ```bash
   cp .env.example .env
   ```

   En az `AUTH_SECRET` (ve üretimde `VORTEX_SECRET`) tanımlayın. Tanımlanmazsa
   sunucu her başlangıçta rastgele bir sır üretir; bu durumda eski oturumlar ve
   imzalı bağlantılar geçersiz olur. Katı mod için `WATCHLIVO_STRICT_SECRETS=1`
   kullanın — bu modda sır yoksa sunucu başlamaz.

4. Yerel sunucuyu başlatın:

   ```bash
   python server.py
   ```

   Sunucu varsayılan olarak `http://127.0.0.1:8000` adresinde açılır.
   `HOST` ve `PORT` değişkenleriyle değiştirebilirsiniz.

---

## 🔒 Güvenlik

- Sırlar yalnızca `.env` / ortam değişkenlerinden okunur. Depoda anahtar
  tutulmaz; kod içinde gömülü yedek sır yoktur.
- Oda şifreleri PBKDF2-SHA256 (120.000 tur, hesap başına rastgele tuz) ile
  saklanır. Eski düz metin şifreler yalnızca okunur, yeniden yazılırsa hash'lenir.
- Oturum jetonları HMAC ile imzalanır, `exp` ve `jti` taşır; jeton içinde şifre
  özeti bulunmaz.
- Üçüncü taraf platform (Netflix, Disney+ vb.) şifreleri Watchlivo'ya **hiç
  gönderilmez ve saklanmaz**. Giriş, uygulama içi tarayıcıda platformun kendi
  sayfasında yapılır; sunucu yalnızca oda senkron komutlarını taşır.
- Yükleme ve yapay zeka uç noktaları doğrulanmış hesap ve hız sınırı ister.
- Sunucu üçüncü taraf video akışlarını proxy'lemez, çözümlemez veya yeniden
  yayınlamaz; keyfi URL çeken bir video vekili (SSRF yüzeyi) yoktur.
- Telif hakkı bildirimleri için `/dmca` sayfasındaki iletişim kanalı kullanılabilir.
- Telefon (SMS) ile giriş yalnızca `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
  `TWILIO_FROM_NUMBER` tanımlıysa çalışır. Aksi hâlde `501` döner.

---

## 📱 Android Derleme

Android uygulaması bu depoda değil, ayrı bir projede derlenir. İmzalama
parolası ortam değişkeninden (`WATCHLIVO_KEYSTORE_PASS`) okunur; kod içinde
tutulmaz. Derlenen APK `static/Watchlivo-v2.0.apk` olarak yayınlanır.

---

## ☁️ Cloudflare Kenar Ağ Geçidi

`workers/ha-gateway/` altındaki Worker'ın dağıtımı için bkz.
[`deploy/CLOUDFLARE.md`](deploy/CLOUDFLARE.md).
