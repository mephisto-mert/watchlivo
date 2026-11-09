// Watchlivo Institutional Footer, On-Page SEO Hub, FAQ Accordion, Legal Modals & Contact/DMCA Engine (v125)
import { h, popup, toast, openDownloadModal } from '../ui.js?v=20261109_v158';
import { api } from '../api.js?v=20261109_v158';
import { state } from '../store.js?v=20261109_v158';

export const OFFICIAL_CONTACT_EMAIL = 'jokallame0@gmail.com';

export const FAQ_ITEMS = [
  {
    q: 'Watchlivo nedir ve nasıl çalışır?',
    a: 'Watchlivo, arkadaşlarınla veya sevgilinle mesafeleri ortadan kaldırarak aynı anda, saliselik senkronizasyonla film, dizi, anime, YouTube videoları ve 7/24 canlı TV kanalları izleyebileceğin yeni nesil bir birlikte izleme (watch party) platformudur. Oda kurduğunda veya bir odaya katıldığında video oynatma, duraklatma ve ileri/geri sarma işlemleri odadaki herkes için anında eşitlenir.',
  },
  {
    q: 'Watchlivo ücretli mi, izlemek için üyelik gerekiyor mu?',
    a: 'Watchlivo tamamen ücretsizdir. Hiçbir ücret ödemeden veya zorunlu kayıt olmadan tek tıkla misafir olarak odalara katılabilir ve kendi sinema odanı kurabilirsin. Dilersen ücretsiz hesap oluşturarak arkadaş listeni, özel mesajlarını (DM) ve izleme geçmişini tüm cihazlarında senkronize tutabilirsin.',
  },
  {
    q: 'Arkadaşlarımla aynı anda nasıl film, dizi veya anime izlerim?',
    a: 'Ana sayfadaki arama çubuğundan veya Sinema+, Dizi ve Anime vitrininden istediğin yapımı seçip tıklaman yeterlidir; sistem otomatik olarak sana özel bir izleme odası açar. Sağ üstteki "Davet Et" butonundan oda bağlantısını kopyalayıp WhatsApp, Discord veya Telegram üzerinden arkadaşına gönderebilirsin.',
  },
  {
    q: 'Odada sesli sohbet (mikrofon) ve kamera nasıl açılır?',
    a: 'İzleme odasına girdiğinde sağ paneldeki "Sesliye Katıl" butonuna tıklayarak düşük gecikmeli WebRTC sesli sohbete bağlanabilirsin. Film sesini kısmadan arkadaşlarınla net şekilde konuşabilir, yazılı sohbetten anlık emoji reaksiyonları ve sesli notlar gönderebilirsin.',
  },
  {
    q: 'Telefonda (iPhone / Android) ve bilgisayarda uygulama olarak nasıl kullanılır?',
    a: 'Watchlivo kurulum gerektirmeden tüm mobil ve masaüstü tarayıcılarda çalışır. Ayrıca üst menüdeki "APK İndir (v2.0.2)" butonuyla Android yerel uygulamasını indirebilir, iPhone (Safari) veya bilgisayarında "Ana Ekrana Ekle / Uygulamayı Yükle" seçeneğiyle tam ekran PWA olarak kullanabilirsin.',
  },
  {
    q: 'Telif hakkı (DMCA), içerik kaldırma ve hata bildirimleri nereye yapılır?',
    a: `Watchlivo kendi sunucularında hiçbir video veya medya dosyası barındırmaz (non-hosting player); içerikler üçüncü taraf açık kaynaklardan ve resmi embed servislerinden senkronize edilir. Telif hakkı bildirimleri, içerik kaldırma talepleri veya çalışmayan bölüm raporları için sayfanın altındaki "Film/Dizi İste & Hata Bildir" formunu kullanabilir ya da doğrudan ${OFFICIAL_CONTACT_EMAIL} adresine e-posta gönderebilirsiniz.`,
  },
];

const LEGAL_SECTIONS = {
  about: {
    title: 'ℹ️ Hakkımızda — Watchlivo Sinema & Medya Platformu',
    url: '/about',
    html: `
      <p><b>Watchlivo (watchlivo.online)</b>, insanların fiziksel olarak ayrı olsalar bile aynı koltukta oturuyormuş gibi birlikte sinema, dizi, anime, canlı televizyon ve müzik deneyimi yaşaması için geliştirilmiş gerçek zamanlı bir sosyal medya ve senkronize izleme platformudur.</p>
      <h4>🌟 Neden Watchlivo?</h4>
      <ul>
        <li><b>Milisaniyelik Senkronizasyon Motoru:</b> Odadaki herkes videonun tam olarak aynı saniyesini görür. Duraklatma, sarma ve bölüm geçişleri anında eşitlenir.</li>
        <li><b>Kristal Netliğinde WebRTC Sesli Sohbet:</b> Harici bir uygulamaya ihtiyaç duymadan oda içinde mikrofonla konuşabilir, sesli not ve canlı tepkiler gönderebilirsiniz.</li>
        <li><b>Zengin Türkçe Dublaj & Altyazı Seçenekleri:</b> Binlerce film, dizi ve anime içeriğinde Türkçe dublaj, Türkçe altyazı ve orijinal dil alternatifleri tek tıkla değiştirilebilir.</li>
        <li><b>Her Cihazda Kesintisiz Deneyim:</b> Web tarayıcısı, Android Native APK (v2.0.2), iOS Tam Ekran Web Uygulaması (PWA) ve Windows masaüstü desteğiyle her ekranda yanınızdadır.</li>
      </ul>
      <p>Resmi İletişim & İşbirliği: <a href="mailto:${OFFICIAL_CONTACT_EMAIL}" style="color:#27dcc8;font-weight:700;">${OFFICIAL_CONTACT_EMAIL}</a></p>
    `,
  },
  privacy: {
    title: '🔒 Gizlilik Politikası & KVKK Aydınlatma Metni',
    url: '/privacy',
    html: `
      <p>Son Güncelleme: <b>Kasım 2026</b> · Veri Sorumlusu İletişim: <a href="mailto:${OFFICIAL_CONTACT_EMAIL}" style="color:#27dcc8;">${OFFICIAL_CONTACT_EMAIL}</a></p>
      <p><b>Watchlivo (watchlivo.online)</b> olarak kullanıcılarımızın gizliliğine ve 6698 sayılı Kişisel Verilerin Korunması Kanunu (KVKK) ile GDPR standartlarına en üst düzeyde önem veriyoruz.</p>
      <h4>1. Toplanan Veriler ve Kullanım Amacı</h4>
      <ul>
        <li><b>Misafir ve Üye Profil Bilgileri:</b> Kayıtsız misafir kullanıcılar için yalnızca geçici bir rumuz oluşturulur. Üye olan kullanıcılarımızın e-posta adresi, kullanıcı adı (@handle) ve profil tercihleri güvenli şifreleme ile yalnızca oturum doğrulaması ve arkadaş listesi senkronizasyonu amacıyla saklanır.</li>
        <li><b>Sesli ve Görüntülü Sohbet Güvenliği (WebRTC):</b> Oda içi sesli sohbet akışları anlık olarak iletilir ve sunucularımızda <b>kesinlikle kaydedilmez veya depolanmaz</b>.</li>
        <li><b>İzleme Geçmişi ve Tercihler:</b> Kaldığınız yerden devam edebilmeniz için izleme geçmişiniz ve tema/altyazı ayarlarınız tarayıcınızın yerel belleğinde (localStorage) ve hesabınızda tutulur; dilediğiniz an tek tıkla silebilirsiniz.</li>
        <li><b>Anonim Analitik (Google Analytics 4):</b> Platform performansını iyileştirmek ve anlık yoğunluğu ölçmek amacıyla anonimleştirilmiş ziyaret istatistikleri işlenir.</li>
      </ul>
      <h4>2. Üçüncü Taraflarla Paylaşım</h4>
      <p>Kişisel verileriniz hiçbir koşulda üçüncü taraf reklam ağlarına satılmaz veya pazarlama amacıyla paylaşılmaz. Hesap silme ve veri bilgi talepleriniz için <a href="mailto:${OFFICIAL_CONTACT_EMAIL}" style="color:#27dcc8;">${OFFICIAL_CONTACT_EMAIL}</a> adresine yazabilirsiniz.</p>
    `,
  },
  terms: {
    title: '📜 Kullanım Koşulları & Topluluk Kuralları',
    url: '/terms',
    html: `
      <p><b>watchlivo.online</b> platformuna erişerek ve izleme odalarını kullanarak aşağıdaki koşulları kabul etmiş sayılırsınız:</p>
      <h4>1. Hizmetin Niteliği</h4>
      <p>Watchlivo, kullanıcıların internet üzerindeki açık medya akışlarını, video bağlantılarını ve gömülü (embed) oynatıcıları arkadaşlarıyla senkronize şekilde izlemesini sağlayan interaktif bir web uygulamasıdır.</p>
      <h4>2. Topluluk ve Oda Kuralları</h4>
      <ul>
        <li>Herkese açık (Public) odalarda diğer izleyicilere yönelik hakaret, nefret söylemi, taciz, spam veya yasa dışı bağlantı paylaşımı kesinlikle yasaktır.</li>
        <li>Oda kurucuları (Host), kendi odalarındaki düzeni sağlamak adına katılımcıları sessize alma, odadan çıkarma veya odayı şifreli/gizli moda alma yetkisine sahiptir.</li>
        <li>Platformun güvenliğini tehlikeye atacak otomatik bot, saldırı veya tersine mühendislik girişimlerinde bulunan IP adresleri sistem tarafından otomatik olarak engellenir.</li>
      </ul>
      <h4>3. Sorumluluk Sınırları</h4>
      <p>Üçüncü taraf video sağlayıcılarından kaynaklanan kesintilerden veya kullanıcıların sohbet alanında paylaştığı bireysel mesajlardan ilgili kullanıcı sorumludur. Şikayet bildirimlerinizi oda içi raporlama aracından veya <a href="mailto:${OFFICIAL_CONTACT_EMAIL}" style="color:#27dcc8;">${OFFICIAL_CONTACT_EMAIL}</a> üzerinden iletebilirsiniz.</p>
    `,
  },
  dmca: {
    title: '⚖️ Telif Hakkı (DMCA) & İçerik Kaldırma Bildirimi',
    url: '/dmca',
    html: `
      <p><b>Watchlivo (watchlivo.online)</b>, 5651 sayılı Kanun ve uluslararası Dijital Binyıl Telif Hakkı Yasası (DMCA - 17 U.S.C. § 512) kapsamında <b>"Yer Sağlayıcı / İçerik Barındırmayan Senkronize Oynatıcı (Non-Hosting Index & Watch-Party Tool)"</b> statüsünde hizmet vermektedir.</p>
      <h4>1. Medya Barındırmama Beyanı</h4>
      <p>Watchlivo sunucularında hiçbir film, dizi, video veya ses dosyası fiziksel olarak barındırılmamaktadır. Platformda görüntülenen tüm videolar YouTube, herkese açık harici video sunucuları ve üçüncü taraf embed servisleri üzerinden anlık olarak çağrılmaktadır.</p>
      <h4>2. Uyar-Kaldır (Notice and Takedown) Prosedürü</h4>
      <p>Telif hakkı kendisine ait olan bir yapımın indeksimizden veya katalog bağlantılarımızdan kaldırılmasını talep eden hak sahipleri ya da yetkili vekilleri, aşağıdaki bilgilerle birlikte resmi bildirimde bulunabilir:</p>
      <ul>
        <li>Hak sahibi olunduğunu gösteren belge veya yetki beyanı,</li>
        <li>İlgili içeriğin Watchlivo üzerindeki başlığı veya bağlantısı,</li>
        <li>İletişim kurulabilecek ad, soyad, telefon ve e-posta adresi.</li>
      </ul>
      <p>Geçerli telif bildirimleri en geç <b>24 saat içerisinde</b> incelenerek ilgili bağlantı platform dizininden kalıcı olarak kaldırılır. Resmi DMCA Başvuru Adresi: <a href="mailto:${OFFICIAL_CONTACT_EMAIL}" style="color:#27dcc8;font-weight:700;">${OFFICIAL_CONTACT_EMAIL}</a></p>
    `,
  },
  cookies: {
    title: '🍪 Çerez (Cookie) ve Yerel Depolama Politikası',
    url: '/privacy',
    html: `
      <p>Watchlivo, size kesintisiz ve hızlı bir izleme deneyimi sunmak için zorunlu tarayıcı çerezleri ve yerel depolama (localStorage / sessionStorage) teknolojilerini kullanır:</p>
      <ul>
        <li><b>Zorunlu Oturum Verileri:</b> Odaya girdiğinizde bağlantınızın kopmaması, rumuzunuzun hatırlanması ve sesli sohbet eşleşmesi için kullanılır.</li>
        <li><b>Kişiselleştirme Verileri:</b> Seçtiğiniz sinema teması, ses seviyesi, altyazı boyutu ve kaldığınız film/dizi dakikası cihazınızda saklanır.</li>
        <li><b>Performans ve Analitik:</b> Google Analytics 4 aracılığıyla hangi sayfaların ve içeriklerin popüler olduğu anonim olarak ölçülür.</li>
      </ul>
      <p>Tarayıcı ayarlarınızdan çerezleri dilediğiniz zaman temizleyebilirsiniz.</p>
    `,
  },
};

export function openLegalModal(initialTab = 'about') {
  const activeKey = LEGAL_SECTIONS[initialTab] ? initialTab : 'about';
  const bodyBox = h('div', { class: 'wl-legal-modal-body' });
  const tabsRow = h('div', { class: 'wl-legal-tabs' });

  const tabDefs = [
    ['about', 'ℹ️ Hakkımızda'],
    ['privacy', '🔒 Gizlilik & KVKK'],
    ['terms', '📜 Kullanım Koşulları'],
    ['dmca', '⚖️ DMCA & Telif'],
    ['cookies', '🍪 Çerezler'],
  ];

  const selectTab = (key) => {
    const sec = LEGAL_SECTIONS[key] || LEGAL_SECTIONS.about;
    tabsRow.querySelectorAll('.wl-legal-tab-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === key);
    });
    bodyBox.innerHTML = `
      <div class="wl-legal-sec-head">
        <h3>${sec.title}</h3>
        <a class="wl-legal-ext-link" href="${sec.url}" target="_blank" rel="noopener">🔗 Tam Sayfa Görünümü (${sec.url})</a>
      </div>
      <div class="wl-legal-prose">${sec.html}</div>
    `;
  };

  for (const [k, label] of tabDefs) {
    tabsRow.appendChild(
      h('button', {
        type: 'button',
        class: `wl-legal-tab-btn ${k === activeKey ? 'active' : ''}`,
        'data-tab': k,
        onclick: () => selectTab(k),
      }, label)
    );
  }
  selectTab(activeKey);

  let legalModalRef = null;
  const wrap = h('div', { class: 'wl-legal-modal-wrap' },
    tabsRow,
    bodyBox,
    h('div', { class: 'wl-legal-footer-bar' },
      h('span', { class: 'wl-legal-mail-note' }, `📩 Resmi İletişim & Hukuk: ${OFFICIAL_CONTACT_EMAIL}`),
      h('button', {
        type: 'button',
        class: 'btn sm primary',
        onclick: () => {
          const curTab = tabsRow.querySelector('.wl-legal-tab-btn.active')?.dataset?.tab || activeKey;
          legalModalRef?.close?.();
          openContactModal(curTab === 'dmca' ? 'dmca' : 'contact');
        },
      }, '✉️ Bize Yazın / Başvuru Yapın'))
  );

  legalModalRef = popup({
    title: 'Watchlivo — Kurumsal & Yasal Bilgiler',
    content: wrap,
    options: [{ label: 'Kapat', primary: true }],
  });
}

export function openContactModal(initialType = 'request') {
  const self = state.self || {};
  const typeSelect = h('select', { class: 'input wl-contact-select', id: 'wl-contact-type' },
    h('option', { value: 'request', selected: initialType === 'request' }, '🎬 Film / Dizi / Anime İsteği'),
    h('option', { value: 'bug', selected: initialType === 'bug' }, '🐞 Video / Altyazı / Ses Hatası Bildirimi'),
    h('option', { value: 'contact', selected: initialType === 'contact' }, '💡 Genel İletişim, Öneri & İşbirliği'),
    h('option', { value: 'dmca', selected: initialType === 'dmca' }, '⚖️ Telif Hakkı (DMCA) & İçerik Kaldırma Talebi')
  );
  const nameInput = h('input', {
    class: 'input',
    id: 'wl-contact-name',
    placeholder: 'Adınız veya Kullanıcı Adınız',
    value: self.name && !self.isGuest ? self.name : '',
  });
  const emailInput = h('input', {
    class: 'input',
    id: 'wl-contact-email',
    type: 'email',
    placeholder: 'Yanıt alacağınız e-posta adresiniz (Örn: adiniz@gmail.com)',
    value: self.email || '',
  });
  const subjectInput = h('input', {
    class: 'input',
    id: 'wl-contact-subject',
    placeholder: initialType === 'dmca' ? 'İlgili içerik başlığı veya URL bağlantısı' : 'Film/Dizi adı veya konu başlığı (Örn: Interstellar 4K / 3. Bölüm Altyazı)',
  });
  const msgInput = h('textarea', {
    class: 'input wl-contact-textarea',
    id: 'wl-contact-msg',
    rows: '4',
    placeholder: 'Detayları buraya yazabilirsiniz... Ekibimiz en kısa sürede inceleyip dönüş yapacaktır.',
  });
  const statusEl = h('div', { class: 'wl-contact-status', id: 'wl-contact-status' });

  const formWrap = h('div', { class: 'wl-contact-form-wrap' },
    h('div', { class: 'wl-contact-direct-banner' },
      h('div', {},
        h('div', { style: { fontWeight: '700', color: '#f8fafc', fontSize: '0.86rem' } }, '📬 Doğrudan Resmi E-Posta Adresimiz'),
        h('a', { href: `mailto:${OFFICIAL_CONTACT_EMAIL}`, style: { color: '#27dcc8', fontWeight: '800', fontSize: '0.92rem', textDecoration: 'none' } }, OFFICIAL_CONTACT_EMAIL)),
      h('button', {
        type: 'button',
        class: 'btn sm',
        onclick: () => {
          navigator.clipboard?.writeText(OFFICIAL_CONTACT_EMAIL).catch(() => {});
          toast(`📋 E-posta kopyalandı: ${OFFICIAL_CONTACT_EMAIL}`);
        },
      }, '📋 Kopyala')),
    h('label', { class: 'wl-contact-lbl', for: 'wl-contact-type' }, 'Konu Kategorisi'),
    typeSelect,
    h('div', { class: 'wl-contact-row2' },
      h('div', {}, h('label', { class: 'wl-contact-lbl', for: 'wl-contact-name' }, 'Adınız / Rumuz'), nameInput),
      h('div', {}, h('label', { class: 'wl-contact-lbl', for: 'wl-contact-email' }, 'E-Posta Adresiniz'), emailInput)),
    h('label', { class: 'wl-contact-lbl', for: 'wl-contact-subject' }, 'İçerik Adı / Başlık'),
    subjectInput,
    h('label', { class: 'wl-contact-lbl', for: 'wl-contact-msg' }, 'Mesajınız'),
    msgInput,
    statusEl
  );

  popup({
    title: '✉️ Bize Ulaşın · Film/Dizi İste & Hata Bildir',
    content: formWrap,
    options: [
      {
        label: '🚀 Hemen Gönder',
        primary: true,
        onClick: async () => {
          const category = typeSelect.value;
          const name = nameInput.value.trim() || self.name || 'Misafir';
          const email = emailInput.value.trim();
          const subject = subjectInput.value.trim();
          const message = msgInput.value.trim();
          if (subject.length < 2 && message.length < 3) {
            statusEl.style.color = '#f87171';
            statusEl.textContent = '⚠️ Lütfen bir başlık veya mesaj yazın.';
            subjectInput.focus();
            return true;
          }
          statusEl.style.color = '#27dcc8';
          statusEl.textContent = 'Gönderiliyor...';
          try {
            const res = await api('/api/rave/contact', {
              method: 'POST',
              body: { category, name, email, subject, message },
            });
            if (res?.ok) {
              window.vortexSendAnalytics?.('contact_submit', { title: `${category}: ${subject}` });
              toast('✅ Mesajınız Watchlivo ekibine başarıyla iletildi!');
              return false;
            }
            statusEl.style.color = '#f87171';
            statusEl.textContent = res?.error || '⚠️ Mesaj iletilemedi, lütfen tekrar deneyin.';
            return true;
          } catch (err) {
            statusEl.style.color = '#f87171';
            statusEl.textContent = err?.data?.error || '⚠️ Bağlantı hatası oluştu, lütfen tekrar deneyin.';
            return true;
          }
        },
      },
      {
        label: `📧 E-Posta Uygulamasıyla Gönder (${OFFICIAL_CONTACT_EMAIL})`,
        onClick: () => {
          const subj = encodeURIComponent(`[Watchlivo ${typeSelect.value.toUpperCase()}] ${subjectInput.value.trim() || 'İletişim'}`);
          const body = encodeURIComponent(`Gönderen: ${nameInput.value.trim()}\nE-Posta: ${emailInput.value.trim()}\n\n${msgInput.value.trim()}`);
          window.open(`mailto:${OFFICIAL_CONTACT_EMAIL}?subject=${subj}&body=${body}`, '_self');
          return true;
        },
      },
      { label: 'Kapat' },
    ],
  });
}

export function initCookieConsentBanner() {
  try {
    if (localStorage.getItem('wl_cookie_consent_v1') === '1') return;
    if (document.getElementById('wl-cookie-banner')) return;
    const banner = h('div', { class: 'wl-cookie-banner', id: 'wl-cookie-banner', role: 'region', 'aria-label': 'Çerez Bildirimi' },
      h('div', { class: 'wl-cookie-text' },
        '🍪 Watchlivo, senkronize oda deneyimi, tema tercihleri ve anonim performans analitiği için çerezleri kullanır. ',
        h('button', {
          type: 'button',
          class: 'wl-cookie-link',
          onclick: () => openLegalModal('cookies'),
        }, 'Gizlilik & KVKK Detayları')),
      h('div', { class: 'wl-cookie-actions' },
        h('button', {
          type: 'button',
          class: 'btn sm primary wl-cookie-ok-btn',
          id: 'wl-cookie-accept-btn',
          onclick: () => {
            try { localStorage.setItem('wl_cookie_consent_v1', '1'); } catch (_) {}
            banner.remove();
          },
        }, 'Anladım'))
    );
    const footerEl = document.getElementById('wl-institutional-footer') || document.getElementById('wl-site-footer-wrap');
    if (footerEl) {
      footerEl.insertBefore(banner, footerEl.firstChild);
    } else {
      document.body.appendChild(banner);
    }
  } catch (_) {}
}

export function renderSiteFooterSection({ onSelectCategory, onScrollToTv, onRandomMovie } = {}) {
  const trustCards = [
    ['⚡', 'Saliselik Senkronizasyon', 'Arkadaşlarınla aynı karede durdur, sar ve sıfır gecikmeyle birlikte izle.'],
    ['🎙️', 'Kristal Netliğinde Sesli Sohbet', 'Oda içi WebRTC düşük gecikmeli mikrofon, sesli not ve anlık emoji tepkileri.'],
    ['🇹🇷', '4K Türkçe Dublaj & Altyazı', 'Vizyon filmleri, popüler diziler, animeler, 7/24 canlı TV ve YouTube akışları.'],
    ['📱', 'Kurulumsuz Web, iOS & Android', 'Tarayıcıdan anında katıl veya PWA / Native APK v2.0.2 ile tam ekran izle.'],
  ];

  const faqBox = h('div', { class: 'wl-faq-list' },
    ...FAQ_ITEMS.map((item, idx) =>
      h('details', { class: 'wl-faq-item', open: idx === 0 ? true : undefined },
        h('summary', { class: 'wl-faq-question' },
          h('span', {}, item.q),
          h('span', { class: 'wl-faq-chevron', 'aria-hidden': 'true' }, '▾')),
        h('div', { class: 'wl-faq-answer' }, item.a))
    )
  );

  return h('section', { class: 'wl-site-footer-wrap', id: 'wl-site-footer-wrap', 'aria-label': 'Platform Bilgileri, SSS ve Kurumsal Bağlantılar' },
    h('div', { class: 'wl-trust-grid' },
      ...trustCards.map(([ico, title, desc]) =>
        h('div', { class: 'wl-trust-card' },
          h('div', { class: 'wl-trust-ico' }, ico),
          h('div', { class: 'wl-trust-meta' },
            h('h3', { class: 'wl-trust-title' }, title),
            h('p', { class: 'wl-trust-desc' }, desc)))
      )),

    h('div', { class: 'wl-faq-section', id: 'wl-faq-section' },
      h('div', { class: 'wl-sec-header' },
        h('h2', { class: 'wl-sec-title' }, '❓ Sıkça Sorulan Sorular (SSS)'),
        h('span', { class: 'wl-sec-sub' }, 'Watchlivo senkronize sinema odaları hakkında merak edilenler')),
      faqBox),

    h('article', { class: 'wl-seo-article-box' },
      h('h2', { class: 'wl-seo-title' }, 'Watchlivo — Arkadaşlarla Online Birlikte Film, Dizi, Anime ve YouTube İzleme Platformu'),
      h('p', { class: 'wl-seo-p' },
        'Watchlivo (watchlivo.online); uzaktaki arkadaşlarınla, sevgilinle veya topluluğunla aynı anda tek kare gecikmesiz sinema keyfi yaşaman için tasarlanmış Türkiye\'nin yeni nesil birlikte izleme (Watch Party) platformudur. Üyelik zorunluluğu olmadan saniyeler içinde herkese açık veya şifreli özel sinema odası kurabilir; Türkçe dublaj ve Türkçe altyazılı binlerce film, popüler yabancı ve yerli dizi, güncel anime bölümleri, 7/24 kesintisiz canlı televizyon kanalları ve YouTube videolarını senkronize olarak izleyebilirsin.'),
      h('p', { class: 'wl-seo-p' },
        'Rave, Teleparty ve Kosmi gibi uygulamalara kıyasla ekstra eklenti kurulumu gerektirmeyen Watchlivo; doğrudan Chrome, Brave, Safari, iOS, Android ve masaüstü tarayıcılarında çalışır. Oda içi düşük gecikmeli WebRTC sesli sohbet, sesli mesaj (voice note), gerçek zamanlı çeviri destekli yazılı sohbet ve akıllı TV kumanda navigasyonu ile sinema salonunu ekranına taşır.'),
      h('div', { class: 'wl-seo-tags' },
        ...['#BirlikteFilmİzle', '#WatchPartyTürkiye', '#ArkadaşlarlaDiziİzle', '#SevgiliyleFilmİzlemeSitesi', '#OnlineSinemaOdası', '#TürkçeDublajFilm', '#AnimeWatchParty', '#RaveAlternatif', '#CanlıTVOdaları'].map((tag) =>
          h('span', { class: 'wl-seo-tag' }, tag))),
      h('div', {
        class: 'wl-social-share-bar',
        style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', marginTop: '14px', paddingTop: '12px', borderTop: '1px solid rgba(148,163,184,0.14)' },
      },
        h('span', { style: { fontSize: '0.82rem', fontWeight: '700', color: '#e2e8f0', marginRight: '4px' } }, '🚀 Watchlivo\'yu Paylaş:'),
        ...[
          ['💬 WhatsApp', 'https://api.whatsapp.com/send?text=' + encodeURIComponent('🎬 Watchlivo — Arkadaşlarınla aynı anda, tek kare gecikmesiz birlikte film, dizi, anime ve canlı TV izle! https://watchlivo.online')],
          ['✈️ Telegram', 'https://t.me/share/url?url=' + encodeURIComponent('https://watchlivo.online') + '&text=' + encodeURIComponent('🎬 Watchlivo — Arkadaşlarınla senkronize film, dizi, anime ve sesli sohbet odaları!')],
          ['𝕏 X (Twitter)', 'https://twitter.com/intent/tweet?text=' + encodeURIComponent('🎬 Arkadaşlarla uzaktan aynı anda film, dizi, anime ve canlı TV izleme platformu: Watchlivo 🍿✨') + '&url=' + encodeURIComponent('https://watchlivo.online')],
          ['🔥 Reddit', 'https://www.reddit.com/submit?url=' + encodeURIComponent('https://watchlivo.online') + '&title=' + encodeURIComponent('Watchlivo — Arkadaşlarla Senkronize Film, Dizi, Anime & Sesli Sohbet Odaları (Rave Alternatifi)')],
        ].map(([lbl, href]) =>
          h('a', {
            href,
            target: '_blank',
            rel: 'noopener noreferrer',
            class: 'btn sm',
            style: { textDecoration: 'none', fontSize: '0.78rem', padding: '5px 10px' },
          }, lbl)
        ),
        h('button', {
          type: 'button',
          class: 'btn sm primary',
          style: { fontSize: '0.78rem', padding: '5px 10px' },
          onclick: () => {
            if (navigator.share) {
              navigator.share({
                title: 'Watchlivo — Birlikte Sinema, Dizi & Anime Odaları',
                text: 'Arkadaşlarınla aynı anda, tek kare gecikmesiz film, dizi, anime ve canlı TV izle!',
                url: 'https://watchlivo.online',
              }).catch(() => {});
            } else {
              navigator.clipboard?.writeText('https://watchlivo.online').catch(() => {});
              toast('📋 Bağlantı kopyalandı: https://watchlivo.online');
            }
          },
        }, '🔗 Davet Linkini Kopyala'))),

    h('footer', { class: 'wl-institutional-footer', id: 'wl-institutional-footer' },
      h('div', { class: 'wl-footer-cols' },
        h('div', { class: 'wl-footer-col brand-col' },
          h('div', { class: 'wl-footer-brand' },
            h('img', { src: '/static/watchlivo-logo.svg?v=20261109_v158', alt: 'Watchlivo', class: 'wl-footer-logo', width: '28', height: '28' }),
            h('span', { class: 'wl-footer-wordmark' }, 'WATCHLIVO')),
          h('p', { class: 'wl-footer-brand-desc' },
            'Arkadaşlarınla aynı anda, tek kare gecikmesiz birlikte sinema, dizi, anime, canlı TV ve müzik odaları.'),
          h('div', { class: 'wl-footer-status-pill' },
            h('span', { class: 'wl-status-dot' }),
            'Tüm Sunucular Aktif · 1080p/4K Senkron Motoru'),
          h('div', { class: 'wl-footer-mail-box' },
            h('span', { class: 'wl-footer-mail-lbl' }, '📩 Resmi İletişim & Destek E-Postası:'),
            h('div', { class: 'wl-footer-mail-row' },
              h('a', { href: `mailto:${OFFICIAL_CONTACT_EMAIL}`, class: 'wl-footer-mail-link', id: 'wl-footer-email-link' }, OFFICIAL_CONTACT_EMAIL),
              h('button', {
                type: 'button',
                class: 'wl-footer-copy-btn',
                title: 'E-posta adresini kopyala',
                onclick: () => {
                  navigator.clipboard?.writeText(OFFICIAL_CONTACT_EMAIL).catch(() => {});
                  toast(`📋 Kopyalandı: ${OFFICIAL_CONTACT_EMAIL}`);
                },
              }, 'Kopyala')))),

        h('div', { class: 'wl-footer-col' },
          h('h4', { class: 'wl-footer-heading' }, 'Keşfet & Kategoriler'),
          h('ul', { class: 'wl-footer-links' },
            h('li', {}, h('button', { type: 'button', class: 'wl-footer-link-btn', onclick: () => onSelectCategory?.('movie') }, '🎬 Vizyon & Trend Filmler')),
            h('li', {}, h('button', { type: 'button', class: 'wl-footer-link-btn', onclick: () => onSelectCategory?.('series') }, '📺 Popüler Diziler & Yeni Bölümler')),
            h('li', {}, h('button', { type: 'button', class: 'wl-footer-link-btn', onclick: () => onSelectCategory?.('anime') }, '⛩️ Anime Arşivi & Odaları')),
            h('li', {}, h('button', { type: 'button', class: 'wl-footer-link-btn', onclick: () => onScrollToTv?.() }, '📡 7/24 Canlı TV & Radyo')),
            h('li', {}, h('button', { type: 'button', class: 'wl-footer-link-btn', onclick: () => onRandomMovie?.() }, '🎲 Rastgele Film Öner')),
            h('li', {}, h('a', { href: '/r/cinema-club', class: 'wl-footer-link-btn' }, '🍿 7/24 Sinema Kulübü Odası')))),

        h('div', { class: 'wl-footer-col' },
          h('h4', { class: 'wl-footer-heading' }, 'Kurumsal & Yasal'),
          h('ul', { class: 'wl-footer-links' },
            h('li', {}, h('button', { type: 'button', class: 'wl-footer-link-btn', id: 'wl-btn-about', onclick: () => openLegalModal('about') }, 'ℹ️ Hakkımızda')),
            h('li', {}, h('button', { type: 'button', class: 'wl-footer-link-btn', id: 'wl-btn-privacy', onclick: () => openLegalModal('privacy') }, '🔒 Gizlilik Politikası & KVKK')),
            h('li', {}, h('button', { type: 'button', class: 'wl-footer-link-btn', id: 'wl-btn-terms', onclick: () => openLegalModal('terms') }, '📜 Kullanım Koşulları')),
            h('li', {}, h('button', { type: 'button', class: 'wl-footer-link-btn', id: 'wl-btn-dmca', onclick: () => openLegalModal('dmca') }, '⚖️ DMCA / Telif Hakkı Bildirimi')),
            h('li', {}, h('button', { type: 'button', class: 'wl-footer-link-btn', id: 'wl-btn-cookies', onclick: () => openLegalModal('cookies') }, '🍪 Çerez (Cookie) Politikası')),
            h('li', {}, h('a', { href: '/sitemap.xml', target: '_blank', class: 'wl-footer-link-btn' }, '🗺️ Site Haritası (Sitemap)')))),

        h('div', { class: 'wl-footer-col' },
          h('h4', { class: 'wl-footer-heading' }, 'İletişim, İstek & Uygulama'),
          h('div', { class: 'wl-footer-cta-stack' },
            h('button', {
              type: 'button',
              class: 'btn sm primary wl-footer-cta-btn',
              id: 'wl-btn-contact-request',
              onclick: () => openContactModal('request'),
            }, '🎬 Film/Dizi İste & Hata Bildir'),
            h('button', {
              type: 'button',
              class: 'btn sm wl-footer-cta-btn',
              id: 'wl-btn-contact-dmca',
              onclick: () => openContactModal('dmca'),
            }, '⚖️ Telif / İçerik Kaldırma Talebi'),
            h('button', {
              type: 'button',
              class: 'btn sm wl-footer-cta-btn',
              onclick: () => openDownloadModal(),
            }, '📲 Uygulamaları İndir (APK / iOS / PC)'),
            h('a', {
              href: '/stats',
              class: 'wl-footer-stats-link',
            }, '📈 Canlı Platform & SEO İstatistikleri')))),

      h('div', { class: 'wl-footer-bottom' },
        h('div', { class: 'wl-footer-copy' },
          '© 2026 Watchlivo (watchlivo.online) · Tüm hakları saklıdır. Watchlivo kendi sunucularında hiçbir medya dosyası barındırmaz (5651 & DMCA Uyumlu Yer Sağlayıcı / Senkronize Oynatıcı).'),
        h('div', { class: 'wl-footer-bottom-links' },
          h('a', { href: '/about' }, 'Hakkımızda'),
          h('span', {}, '·'),
          h('a', { href: '/privacy' }, 'Gizlilik & KVKK'),
          h('span', {}, '·'),
          h('a', { href: '/terms' }, 'Kullanım Şartları'),
          h('span', {}, '·'),
          h('a', { href: '/dmca' }, 'DMCA'),
          h('span', {}, '·'),
          h('a', { href: '/contact' }, 'İletişim'))))
  );
}
