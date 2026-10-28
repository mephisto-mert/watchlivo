# Watchlivo — Bulgular Raporu (Türkçe)

**Kapsam:** `watchlivo` (web / Python-Starlette), `watchlivo_android` (WebView uygulaması), `watchlivo_windows` (masaüstü uygulaması)
**Test edilen:** `https://watchlivo.online` + yerel kopya (aynı kod, port 8791)
**Tarih:** 28 Ekim 2026

**Sonuç:** Yayına hazır değil. 7 kritik, 10 yüksek, 11 orta, 8 düşük bulgu var. En ağırı: şifreli odaların şifresi tamamen atlatılabiliyor. Bunu canlı sitede denedim, çalıştı.

---

## Kısa özet (üç madde)

1. **Oda şifresi koruması işlemiyor.** "Odayı kuran kişinin kimliği" (`creatorId`) herkese açık ve şifre kontrolü bu kimlik eşleşince atlanıyor. Canlı sitede yanlış şifreyle odaya girdim.
2. **Netflix/Disney+ "hesap doğrulama" sahte.** Sunucu hiçbir platforma bağlanmıyor. Uydurma Gmail + uydurma şifre "doğrulandı" dönüyor. Kullanıcılar gerçek premium şifrelerini boşuna yazıyor.
3. **Telefon doğrulama kodu, API yanıtının içinde düz metin geliyor.** Yani telefon doğrulaması hiçbir güvenlik sağlamıyor.

---

## Nasıl test ettim

| Yöntem | Sonuç |
|---|---|
| Python sözdizimi derlemesi | Sorun yok |
| `pyflakes` (statik uyarılar) | 6 bulgu (§6) |
| `pytest tests` | Hata: testler toplanamıyor |
| Yerel canlı sunucu + 5 ayrı sızma betiği | Kritik bulguların çoğu burada kanıtlandı |
| Canlı site (okuma + 1 test odası) | Şifre atlatma kanıtlandı |
| Projenin kendi güvenlik testi | "20/22 geçti" diyor ama gerçek 5 saldırıyı kaçırıyor |

Not: `godseye` ve `mirofish` araçları çağrıldı, ikisi de bu projeyle ilgisiz, önbellekte kalmış başka bir uygulamanın (`org.contentarcade.apps.logomaker`) verisini döndürdü. Bu yüzden denetimi doğrudan kod okuması ve canlı denemeyle yaptım.

---

## KRİTİK — hemen düzeltilmeli

### 1. Şifreli odalara şifresiz giriş (canlı sitede kanıtlandı)

**Yer:** `rooms.py:1469`

Şifre kontrolü şöyle:
```python
if room["password"] and data.get("pwd", "") != room["password"] \
   and data.get("uid") != room.get("creatorId") and cid not in room["participants"]:
    return JSONResponse({"error": "password_required"}, status_code=403)
```

Yani "gönderdiğin kimlik, odanın kurucusunun kimliğiyle aynıysa şifre sorma" diyor. Ama o kimlik gizli değil: `serialize()` fonksiyonu `creatorId` alanını herkese döndürüyor (`rooms.py:457`).

**Kanıt (canlı site):**
```
Oda oluştur: 200  kimlik: audit-test-3f7e1  şifre var mı: Evet
Yanlış şifre + kurucunun kimliği -> 200, hata yok, odaya girdim
GET /api/rooms/audit-test-3f7e1 -> "creatorId": "u_wl_audit_test", "hasPassword": true
```

**Etki:** Özel oda özelliği tamamen dekoratif. Yabancı biri odaya girer, yayını ele alır, sohbeti okur, oda liderliğini devralır.

**Çözüm:** `uid` karşılaştırmasını sil. Odaya giriş için sunucunun ürettiği, süreli, imzalı bir "giriş bileti" kullan (oda kimliği + istemci kimliği + son kullanma zamanı). Şifreyi odada düz metin tutma, özetini (hash) tut ve sabit zamanlı karşılaştır.

---

### 2. İstemci kimliğini istemci kendisi seçiyor → oda liderliği devralınıyor

**Yer:** `rooms.py:1440` (kimlik istemciden alınıyor), `rooms.py:1488` (odaya ekleme), `rooms.py:1101-1134` (lider işlemleri)

**Kanıt (yerel, aynı kod):** Kurban `victimTab` kimliğiyle girdi. Saldırgan aynı kimlikle katıldı ve lider yetkisiyle işlem yaptı:
```
Saldırgan lider işlemi: 200, hata yok, oda adı "pwned" oldu
Gerçek şifreyle girmeye çalışan kullanıcı: 403 password_required
```
Oda adı değişti, şifre değişti, gerçek sahibi dışarıda kaldı.

**Çözüm:** İlk katılımda sunucu rastgele bir kimlik üretsin ve imzalı olarak istemciye versin. Sonraki isteklerde istemci bu imzalı kimliği göndersin. Lider işlemleri ayrıca katılımcıya özel gizli anahtar istesin.

---

### 3. Platform hesap doğrulaması sahte — gerçek şifreler toplanıyor

**Yer:** `server.py:3824-3893` ve `server.py:3913-3939`

Kod Netflix'e, Disney+'a, hiçbir yere bağlanmıyor. Sadece üç şeye bakıyor:
- e-posta biçimi doğru mu,
- e-postanın alan adı DNS'te var mı,
- şifre çok mu zayıf ("1234", "qwerty" gibi).

Bu üçü geçerse "doğrulandı" diyor:
```python
_ZK_ACCOUNT_SEALS[acct_key] = expected_seal
return True, "ok"
```

**Kanıt (iki farklı rastgele Gmail, uydurma şifreler):**
```
ahmet.yilmaz.9931@gmail.com / Sifre123456 -> 200, doğrulandı
zeynep.kaya.4417@gmail.com / BaskaSifre99  -> 200, doğrulandı
```

Arayüz bunu kullanıcıya "🔒 Netflix hesabınız şifreli olarak bağlandı!" diye gösteriyor (`static/js/accounts.js:285`) ve "uçtan uca şifreli olarak doğrulanıyor" yazıyor (`accounts.js:263`). Oysa şifre sunucuya düz metin gidiyor.

**Etki:**
- Kullanıcı gerçek Netflix/Disney+ şifresini gereksiz yere sunucuya veriyor.
- Sahte güven veriliyor.
- KVKK/GDPR açısından amaçsız kimlik bilgisi toplama — ciddi hukuki risk.
- `AUTH_SECRET` sızarsa, saklanan mühür üzerinden şifre çevrimdışı denenebilir.

**Çözüm:** Ya özelliği tamamen kaldır, ya gerçek OAuth/partner API'ye bağla. Hiç kontrol yapılmıyorsa "doğrulandı" yazısı kaldırılmalı. "Sıfır bilgi" ve "AES256" iddiaları da yanlış: tarayıcıda tutulan veri XOR ile gizleniyor, şifreleme değil (`accounts.js:8-32`).

---

### 4. Telefon doğrulama kodu yanıtın içinde geliyor

**Yer:** `auth_engine.py:581-586`

```python
"code": code,
"message": f"Onay kodu oluşturuldu: {code}",
```

**Kanıt:**
```
POST /api/auth/phone/send-code {"phone":"+905551112233"}
200 {"ok":true,"code":"323824","expiresIn":300,"message":"Onay kodu oluşturuldu: 323824"}
```

**Etki:** Telefon doğrulaması sıfır güvenlik. Herhangi bir numarayı doğrulayıp o numaranın hesabını ele geçirmek mümkün, çünkü kod yanıtta olduğu için doğrulama adımına anında gönderilebilir.

Ek sorun: kodlar sadece sunucu belleğinde tutuluyor. Birden fazla sunucu örneği çalışınca doğrulama rastgele başarısız olur.

**Çözüm:** Kodu yanıta koymayın. Özetini Redis/Upstash'e yazın, deneme sayacı ekleyin, SMS'i servis üzerinden gönderin.

---

### 5. `AUTH_SECRET` sabit yedek değer → herkes adına oturum üretilebiliyor

**Yer:** `auth_engine.py:31-35`, `auth_engine.py:264-295`

```python
AUTH_SECRET = (os.environ.get("AUTH_SECRET") or b"watchlivo_supabase_cloud_auth_secret_v2_2026")
```

Yedek değer kodda açık. Kullanıcı kimliği de e-postadan hesaplanabildiği için (`auth_engine.py:330`: `sha256(email)` ilk 12 karakter), tek bilinmeyen sır bu değer.

**Kanıt (yerel, ortam değişkeni yokken):** Kendi ürettiğim oturum anahtarı kabul edildi:
```
GET /api/auth/me?token=<uydurma> -> 200 {"authenticated": true, "user": {...}}
```

**Canlı site:** Bu saldırı çalışmadı, yani canlıda `AUTH_SECRET` gerçekten tanımlı. Ama yedek değer kodda duruyor: yerel geliştirme, test ortamı, kendi sunucunda kurulum veya ortam değişkeninin silinmesi = tam hesap ele geçirme.

**Çözüm:** Sır yoksa uygulama hiç açılmasın (başlangıçta hata versin). Geliştirme için rastgele sır üretilsin ve uyarı basılsın.

---

### 6. `SYNC_SECRET` yedek değeri + oda eşitleme anahtarı → oda devralma

**Yer:** `rooms.py:20`, `rooms.py:243-369` (özellikle `342-346`), `rooms.py:1449`

Oda eşitleme anahtarının imzası doğruysa, içindeki veri doğrudan odaya yazılıyor. Sürüm numarası yüksekse şifre, oda lideri ve kurucu dahil her şey değişiyor:
```python
for k in ("name", "privacy", "playMode", "voipMode", "password", "creator", "creatorId", "host_id", ...):
    if k in snap: room[k] = snap[k]
```

**Kanıt (yerel, yedek sırla imzalanmış anahtar):**
```
Odaya yazıldı: STOLEN ROOM | şifre: attacker-pw | lider: atkTab | yayın: https://evil.example/x.m3u8
```

Ayrıca aynı anahtar `serialize()` içinde `KeyError: 'rate'` hatası verdi (`rooms.py:406`). Bu hata yakalanmadığı için o oda sürekli 500 hatası döndürür; yani bir oda kalıcı olarak kullanılamaz hale getirilebilir.

Ek sorun: bu anahtarın içinde oda şifresi düz metin taşınıyor (`rooms.py:227`). Sadece imzalanıyor, şifrelenmiyor; herkes okuyabilir.

**Çözüm:** Şifre ve kurucu kimliği bu veriye hiç girmesin. Birleştirme sadece yayın durumu, sohbet gibi zararsız alanlarla sınırlansın. `serialize()` eksik alanları varsayılan değerle tamamlasın.

---

### 7. Yayın vekil sunucusunun imza anahtarı TMDB anahtarından türetiliyor → açık vekil

**Yer:** `server.py:56`

```python
_PROXY_SECRET = (os.environ.get("VORTEX_SECRET") or hashlib.sha256(
    f"watchlivo-proxy-v1:{os.environ.get('TMDB_API_KEY') or '4f042878...'}".encode()).hexdigest()).encode()
```

`VORTEX_SECRET` tanımlı değilse anahtar, kodda açık duran TMDB anahtarından hesaplanıyor. Yani imza üretmek için gereken sır herkesin elinde.

**Kanıt:**
```
GET /api/rave/stream-proxy?url=https://www.google.com/robots.txt&sig=<uydurma> -> 200
"User-agent: *\nUser-agent: Yandex\n..."
```

İç ağ adresleri engelli (`server.py:3997`), yani sunucunun iç ağına doğrudan erişim yok. Ama sonuç şu: sınırsız, ücretsiz açık vekil. Bant genişliği hırsızlığı, IP itibarının kirlenmesi, önbellek şişmesi.

Ek teknik risk: adres kontrolü bir kez DNS çözüyor, `urllib` tekrar çözüyor. Bu arada alan adı değiştirilirse iç ağa erişim (DNS rebinding) teorik olarak mümkün.

**Çözüm:** Ayrı ve rastgele bir `PROXY_SECRET` kullan, yoksa uygulama açılmasın. İmzaya son kullanma zamanı ekle. İzinli alan adları listesi tut.

---

## YÜKSEK

### 8. Giriş uçlarında hız sınırı yok
`/api/auth/login`, `/register`, `/phone/*`, `/rave/accounts/login` uçlarının hiçbirinde sınır yok. Arka arkaya 12 hatalı giriş denedim: hepsi 401 döndü, hiç 429 (çok fazla istek) gelmedi. Her istek 120.000 turlu şifre özeti hesapladığı için bu aynı zamanda işlemci yorma saldırısı.
**Çözüm:** IP ve hesap bazlı sınır (ör. 15 dakikada 5 deneme), `slowapi` veya Upstash Redis, hesap kilitleme.

### 9. Oturum anahtarında şifre özeti var, süresi yok
`auth_engine.py:264-276` — anahtarın içeriği: `{"uid":..., "pwh":"bf035b01a1b0af259ce71863", "iat":1793147752}`. Son kullanma alanı (`exp`) yok, doğrulama fonksiyonu da yaşa bakmıyor (`283-295`). Anahtar hiç eskimiyor. `pwh` sızarsa şifre özeti de sızmış olur.
Ayrıca `/api/auth/me?token=...` adres parametresi kabul ediyor; bu tür anahtarlar sunucu kayıtlarına ve yönlendiren adreslere düşer (kanıt: 200, `authenticated:true`).
**Çözüm:** `exp` ve tek kullanımlık kimlik (`jti`) ekle, iptal listesi tut, `pwh` alanını çıkar, sadece `Authorization` başlığını kabul et.

### 10. Kullanıcı kimliği ve tuz değeri tahmin edilebilir
`auth_engine.py:330-331`: kimlik = `sha256(e-posta)` ilk 12 karakter, tuz = `sha256(kimlik + ":wl_salt")`.
Sonuç: e-postası bilinen her kullanıcının kimliği hesaplanabilir (oda şifresi atlatma bunu bedava veriyor). Tuz da kişiye özel rastgele değil, bu yüzden önceden hesaplanmış tablolar avantaj sağlıyor.
**Çözüm:** `secrets.token_hex` ile rastgele kimlik, veritabanında kullanıcı başına rastgele tuz.

### 11. Şifre sıfırlama tahmin edilebilir şifre üretiyor
`auth_engine.py:648`: Firebase hesabı `"Wl_" + sha256(e-posta)` ilk 12 karakter ile açılıyor. Şifre e-postadan herkesçe hesaplanabildiği için saldırgan kurbanın hesabını önceden sahiplenebilir.
**Çözüm:** Rastgele tek kullanımlık şifre ve e-posta ile sıfırlama bağlantısı. Hiçbir koşulda türetilebilir şifre kullanma.

### 12. Dosya yükleme ucunda kimlik doğrulama yok, sınır 1 GB
`server.py:4998-5021`: giriş kontrolü yok, dosya başına sınır 1 GB (`server.py:80`), istek sayısı sınırsız. Disk doldurma saldırısı mümkün. Dosyalar `/uploads` altından herkese açık servis ediliyor (`server.py:5287`). Uzantı filtresi iyi (`.mp4/.mp3/...`), ama indirme başlığı (`Content-Disposition`) yok.
**Çözüm:** Giriş zorunluluğu, kullanıcı ve toplam disk kotası, yüklemeleri ayrı alan adına taşıma.

### 13. OpenAI/Suno anahtarı anonim kullanıma açık
`server.py:5112-5180`: `/api/rave/ai-chat` giriş istemiyor. İstemci kendi anahtarını göndermezse sunucunun `OPENAI_API_KEY` değeri kullanılıyor. Canlıda anahtar tanımlı (`sk-proj-****`). İsteyen herkes ücretli kotayı tüketebilir.
**Çözüm:** Giriş zorunluluğu, kullanıcı başına günlük kota, anonim istekte sunucu anahtarını asla kullanma.

### 14. Veritabanı her açılışta tüm tabloyu siliyor
`server.py:98`: `conn.execute("DELETE FROM provider_accounts")`. Her bağlantıda çalışıyor. Hesap durumu hiç kalıcı olmuyor, çıkış işlemi fiilen anlamsız, eşzamanlı isteklerde veri kaybı var.
**Çözüm:** Satırı sil, eski kayıtları tarih alanına göre temizle.

### 15. Android: şifresiz trafik, karışık içerik, dosya erişimi, otomatik izin
- `AndroidManifest.xml:27` — `usesCleartextTraffic="true"` (HTTP trafiği açık)
- `MainActivity.java:112` — `MIXED_CONTENT_ALWAYS_ALLOW` (HTTPS sayfada HTTP içerik)
- `MainActivity.java:104` — `setAllowFileAccess(true)` (yerel dosya erişimi)
- `MainActivity.java:240-270` — izin isteği kullanıcıya sorulmadan `request.grant(...)` ile kamera ve mikrofon veriliyor

**Etki:** Ağ dinleme saldırısına açık, yerel dosya okuma riski var, kullanıcıya haber verilmeden kamera/mikrofon açılabiliyor.
**Çözüm:** Şifresiz trafiği kapat + güvenlik yapılandırma dosyası ekle, `MIXED_CONTENT_NEVER_ALLOW`, dosya erişimini kapat, izinleri `requestPermissions` ile sor, `allowBackup="false"`.

### 16. Windows uygulaması: yerel giriş köprüsünde herkese açık CORS
`watchlivo_windows/app.py:93, 111, 117, 125`: `Access-Control-Allow-Origin: *`. Durum doğrulaması (`state`) var, iyi; ama kaynak (Origin) kontrolü yok. Kullanıcının tarayıcısındaki herhangi bir sayfa, portu bulursa istek atabilir.
Ayrıca `ALLOW_FILE_URLS = True` (`app.py:195`) ve uygulama dosyası imzasız.
**Çözüm:** Sadece `https://watchlivo.online` kaynağına izin ver, `state` tek kullanımlık ve 60 saniye ömürlü olsun, dosya adreslerini kapat, kod imzalama sertifikası al.

### 17. Keystore şifresi kodun içinde
`watchlivo_android/build_apk.py:127-128`: `-storepass watchlivo2026`, `-keypass watchlivo2026`. Keystore dosyası `watchlivo_android/watchlivo.keystore` (git'te yok ama proje klasöründe; herhangi bir zip/yedek ile sızar).
**Etki:** Anahtar sızarsa `online.watchlivo.app` adına sahte güncelleme imzalanabilir; cihaz ve mağaza güveni biter.
**Çözüm:** Şifreyi ortam değişkenine taşı, keystore'u yedeklerden çıkar, anahtarı yenile (rotate).

---

## ORTA

| # | Bulgu | Yer | Etki ve çözüm |
|---|---|---|---|
| 18 | Poster vekili imzasız, herkese açık | `server.py:4415-4428` | Herkes görsel vekilini bedava CDN gibi kullanabilir. İmza veya alan adı listesi ekle. |
| 19 | İndirme uçları repodan üretilemiyor | `server.py:5059-5082`, `vercel.json:60-80` | Yerelde 404, canlıda 200. Dosyalar repoda yok (`static/` içinde APK/EXE yok). Temiz kopyada indirme çalışmıyor. Artefaktları otomatik üret veya sürümlü yayına taşı. |
| 20 | README yanlış başlatma komutu | `README.md:47` | `python server.py` hiçbir şey başlatmıyor: dosyada `uvicorn` import'u ve `__main__` bloğu yok, `requirements.txt` içinde `uvicorn` da yok. |
| 21 | Masaüstü varsayılan adresi eski proje | `desktop/main.js:5` | `https://ravewebplatform.vercel.app` yazıyor; ortam değişkeni yoksa yanlış siteye bağlanır. `https://watchlivo.online` olmalı. |
| 22 | Güvenlik başlıkları zayıf | `server.py:125`, `vercel.json` | İçerik güvenlik politikası çok dar (`default-src`, `script-src` yok), HSTS başlığı hiç yok (projenin kendi testi de başarısız veriyor). |
| 23 | Adres yönlendirme çakışması | `server.py:5282` | Genel oda rotası özel rotayı yutuyor: `/api/rooms/list` → 404 "Bu oda artık mevcut değil". Özel rotalar önce tanımlanmalı. |
| 24 | Testler pytest ile çalışmıyor | `tests/test_api.py:26` | Dosya import edilirken ağ çağrısı yapıyor, bu yüzden tüm test takımı düşüyor. `tests/test_room_auth_host.py` ayrıca sabit `c:/Users/pc/.../rave_web_platform` yolu kullanıyor. |
| 25 | 1,1 MB veri dosyası her sunucu paketine giriyor | `main_sites_vault.json` (1.119.014 bayt) | Soğuk başlatma süresi ve paket boyutu artıyor. Sıkıştır veya sorguya göre parçala. |
| 26 | Poster önbelleği 250 MB'a çıkabilir | `server.py:4392-4412` | 250 kayıt × 1 MB. Bayt bazlı toplam sınır koy. |
| 27 | Projenin güvenlik testi yanlış "geçti" veriyor | `tests/security_pentest_live.py` | "Sahte imza reddedildi" testi rastgele imza deniyor, gerçek türetilmiş anahtarı denemiyor. "Netflix doğrulaması" testi sadece kendi kara listesindeki e-postaları deniyor. Bu yüzden 1, 3 ve 7 numaralı kritik açıklar testte "geçti" görünüyor. |
| 28 | Oda durumu bellek/Redis karışık | `rooms.py:707`, `/api/health` | Paylaşımlı depo kapalıyken birden fazla sunucuda oda durumu bölünür. Canlıda Redis var, yerelde sessizce bozulur. |

---

## DÜŞÜK

1. `sw.js` kendini kayıttan siliyor, ayrıca `Clear-Site-Data: "storage"` başlığı (`server.py:5034`) → çevrimdışı çalışma ve önbellek sürekli sıfırlanıyor.
2. `Vortex_PC_Uygulamasi.bat` sabit Chrome yolu kullanıyor ve `localhost:8765` adresini açıyor; o portu dinleyen bir şey yok.
3. `/api/rave/ai-status` model adlarını, uç adresleri ve sabit `status: "active"` döndürüyor (`server.py:5085-5109`). Bilgi ifşası; gerçek sağlık kontrolü değil.
4. `_SYNTHETIC_UNREGISTERED_ACCOUNTS` kara listesi (`server.py:3864-3876`) güvenlik değil, kozmetik.
5. `SYNC_SECRET`, `PROXY_SECRET` ve VORTEX anahtarı aynı ortam değişkenine bağlı (`server.py:56`, `rooms.py:20`). Anahtar ayrımı yok.
6. `desktop/main.js` içinde `contextIsolation` açıkça ayarlanmamış (`nodeIntegration: false` var, iyi). Kontrol edilmeli.
7. Kayıt akışı e-posta varlığını sızdırıyor olabilir; giriş mesajı iyi ama kayıt mesajı ayrıştırılmalı.
8. Sohbet `textContent` kullanıyor (XSS yok), sadece 3 yerde `innerHTML` var ve hepsi sabit şablon. Yine de ileride risk; kural olarak korunmalı.

---

## 6. Statik uyarılar ve bağımlılıklar

```
server.py      : kullanılmayan import 'secrets'
server.py:3010 : yer tutucusuz f-string
server.py:4320 : kullanılmayan değişken 'has_tr_aud'
rooms.py:477   : kullanılmayan değişken 'dur'
catalog_api.py : kullanılmayan import 'BaseHTTPMiddleware'
auth_engine.py : kullanılmayan import 'base64'
```

`requirements.txt` sadece iki satır ve sürüm sabitlenmemiş (`starlette>=0.37.0`, `python-multipart>=0.0.9`). `uvicorn` eksik.

---

## 7. Düzeltme sırası ve süre tahmini

| Sıra | İş | Süre |
|---|---|---|
| 1 | Oda şifresi atlatmasını kaldır, `creatorId` alanını yanıttan çıkar | 2 saat |
| 2 | İstemci kimliğini sunucu üretimli imzalı anahtara bağla | 4 saat |
| 3 | Sahte platform doğrulamasını kaldır veya gerçek OAuth'a bağla | 2 saat |
| 4 | Doğrulama kodunu yanıttan çıkar, Redis + deneme sınırı | 3 saat |
| 5 | Tüm yedek sırları kapat, sırları ayır (`AUTH`, `SYNC`, `PROXY`) | 3 saat |
| 6 | Giriş, yükleme ve yapay zekâ uçlarına kimlik + hız sınırı | 4 saat |
| 7 | Oturum anahtarına süre ekle, `pwh` çıkar, adres parametresini yasakla | 2 saat |
| 8 | Rastgele kimlik/tuz, tahmin edilebilir sıfırlama şifresini kaldır | 3 saat |
| 9 | Oda verisinde eksik alanları tamamla, şifreyi eşitleme anahtarından çıkar | 1 saat |
| 10 | Android yapılandırma ve izin sertleştirmesi | 3 saat |
| 11 | Windows kaynak izni + kod imzalama | 3 saat |
| 12 | Keystore yenileme + şifreyi ortam değişkenine taşıma | 1 saat + dış işlem |
| 13 | Testleri pytest uyumlu yap, gerçek saldırıları testlere ekle | 4 saat |
| 14 | README, `__main__`, `uvicorn`, sürüm sabitleme | 30 dakika |
| 15 | İndirme dosyaları + masaüstü adresi | 1 saat |

**Toplam yaklaşık 36 saat.** 1-5 arası tek günde biter ve siteyi büyütmek için asgari şart.

---

## 8. Doğrulanan ve doğrulanmayan noktalar

**Kanıtla doğrulandı:**
Oda şifresi atlatma (canlı), istemci kimliğiyle liderlik devralma (yerel), sahte platform doğrulaması (iki hesap), doğrulama kodu sızıntısı (yerel), oturum anahtarı üretme (yerel), vekil imza atlatma (yerel), eşitleme anahtarıyla oda devralma, `KeyError: 'rate'` 500 hatası, hız sınırı yokluğu (12 istek), indirme uçları (canlı 200 / yerel 404), `/api/rooms/list` 404, test toplama hatası, statik uyarılar.

**Doğrulanmadı veya yanlış çıktı:**
- Canlıda oturum anahtarı üretme çalışmadı (ortam değişkeni tanımlı).
- Keystore git geçmişinde yok; risk dosya sisteminde durması.
- Canlı indirme uçları çalışıyor; sorun repoda dosya olmaması.
- APK v2 imzalı; "imza yüzünden kurulmuyor" iddiası geçersiz.

**Yan etki:** Canlıda şifre atlatmayı kanıtlamak için `audit-test-3f7e1` adlı bir test odası oluşturdum. Silme ucu yok, boş kalınca temizlenmesi bekleniyor. Yerel sunucu (PID 5008) kapatıldı.

---

## 9. Şimdi ne yapılmalı

1. **Bugün:** `rooms.py:1469` satırındaki "kimlik eşleşirse şifre sorma" koşulunu kaldır. Oda şifresi o dakika gerçek olur.
2. **Bu hafta:** Sahte platform doğrulamasını kaldır. Kullanıcı gerçek Netflix şifresini boşuna veriyor; bu tek başına hukuki risk.
3. **Sonra:** Yedek sırları kapat ve bu beş saldırıyı güvenlik testine ekle; bir daha "20/22 geçti" yanılgısı olmasın.
