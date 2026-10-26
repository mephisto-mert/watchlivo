# Watchlivo — Birlikte Sinema, Dizi & Müzik Platformu

Watchlivo; arkadaşlarınızla gerçek zamanlı senkronize video izleme, müzik dinleme ve oda sohbeti sunan modern bir medya platformudur.

🌐 **Canlı Web Sitesi:** [watchlivo.online](https://watchlivo.online)  
📱 **Android APK:** [watchlivo.online/download/apk](https://watchlivo.online/download/apk)  
💻 **Windows İstemcisi:** [watchlivo.online/download/windows](https://watchlivo.online/download/windows)

---

## 🚀 Özellikler

* **44.000+ İçerik Kataloğu:** TMDB API ve çoklu yedek sunucu motoru (idsrc, idlink, utoembed) ile kesintisiz akış.
* **Ses & Görüntü Senkronizasyonu:** Hls.js PTS/Frame drift engelleme ve milisaniyelik oda senkronu.
* **Anti-Dropout Koruması:** Ağ dalgalanmalarında veya sunucu gecikmelerinde izlenen videonun yarıda kesilmesini önleyen akıllı tampon kilidi.
* **Çoklu Platform:** Web (PWA), Android APK (OTA güncellemeli WebView) ve Windows Masaüstü (WebView2).
* **Güvenli Kimlik Doğrulama:** Firebase Phone Auth ve Google OAuth (WebView 403 bypass korumalı).

---

## 🛠️ Kurulum & Yerel Çalıştırma

### Gereksinimler
* Python 3.10+
* Node.js 18+ (İsteğe bağlı)

### Adımlar

1. Depoyu klonlayın:
   `ash
   git clone https://github.com/mephisto-mert/watchlivo.git
   cd watchlivo
   `

2. Gereksinimleri yükleyin:
   `ash
   pip install -r requirements.txt
   `

3. Çevre değişkenlerini ayarlayın:
   `ash
   cp .env.example .env
   `

4. Yerel sunucuyu başlatın:
   `ash
   python server.py
   `

---

## 🔒 Güvenlik
Hassas API anahtarları ve sırlar .env üzerinden yönetilir. Depoda hiçbir özel anahtar veya yetkisiz kimlik bilgisi tutulmaz.
