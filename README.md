# Watchlivo — Birlikte Sinema, Dizi & Müzik Platformu

Watchlivo; arkadaşlarınızla gerçek zamanlı senkronize video izleme, müzik dinleme ve oda sohbeti sunan modern bir medya platformudur.

🌐 **Canlı Web Sitesi:** [watchlivo.online](https://watchlivo.online)
📱 **Android APK:** [watchlivo.online/download/apk](https://watchlivo.online/download/apk)
💻 **Windows İstemcisi:** [watchlivo.online/download/windows](https://watchlivo.online/download/windows)

---

## 🚀 Özellikler

- **44.000+ İçerik Kataloğu:** TMDB API ve çoklu yedek sunucu motoru ile kesintisiz akış.
- **Ses & Görüntü Senkronizasyonu:** Hls.js PTS/Frame drift engelleme ve milisaniyelik oda senkronu.
- **Anti-Dropout Koruması:** Ağ dalgalanmalarında izlenen videonun yarıda kesilmesini önleyen tampon kilidi.
- **Çoklu Platform:** Web (PWA), Android APK (OTA güncellemeli WebView) ve Windows Masaüstü (WebView2).
- **Kimlik Doğrulama:** Firebase Phone Auth (Twilio anahtarı varsa) ve Google OAuth.

---

## 🛠️ Kurulum & Yerel Çalıştırma

### Gereksinimler

- Python 3.10+
- Node.js 18+ (yalnızca masaüstü kabuğu için)

### Adımlar

1. Depoyu klonlayın:

   ```bash
   git clone https://github.com/mephisto-mert/watchlivo.git
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
- Üçüncü taraf platform (Netflix, Disney+ vb.) şifreleri **doğrulanmaz ve
  saklanmaz**. İlgili giriş uç noktası `501 unsupported` döner; oturumu platformun
  kendi sayfasında açmanız gerekir.
- Yükleme ve yapay zeka uç noktaları doğrulanmış hesap ve hız sınırı ister.
- Proxy ve poster bağlantıları süreli HMAC imzası taşır; imzasız istek reddedilir.
- Telefon (SMS) ile giriş yalnızca `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
  `TWILIO_FROM_NUMBER` tanımlıysa çalışır. Aksi hâlde `501` döner.

---

## 📱 Android Derleme

```powershell
$env:WATCHLIVO_KEYSTORE_PASS = "<keystore-sifresi>"
python build_apk.py
```

İmzalama parolası ortam değişkeninden okunur; kod içinde tutulmaz.
