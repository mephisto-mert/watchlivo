// Watchlivo synchronous early bootstrap (ES2020 polyfills + zero-iframe GA4 native beacon).
// Externalized from index.html so script-src CSP runs strictly without 'unsafe-inline'.
(function () {
  if (!Element.prototype.replaceChildren) {
    Element.prototype.replaceChildren = function () {
      while (this.firstChild) this.removeChild(this.firstChild);
      for (var i = 0; i < arguments.length; i++) {
        var n = arguments[i];
        if (n === null || n === undefined || n === false) continue;
        this.appendChild(typeof n === 'string' || typeof n === 'number' ? document.createTextNode(String(n)) : n);
      }
    };
  }
  if (!Element.prototype.append) {
    Element.prototype.append = function () {
      for (var i = 0; i < arguments.length; i++) {
        var n = arguments[i];
        if (n === null || n === undefined || n === false) continue;
        this.appendChild(typeof n === 'string' || typeof n === 'number' ? document.createTextNode(String(n)) : n);
      }
    };
  }
  if (!String.prototype.replaceAll) {
    String.prototype.replaceAll = function (s, r) {
      return s instanceof RegExp ? this.replace(s, r) : this.split(s).join(r);
    };
  }
  if (!Array.prototype.at) {
    Array.prototype.at = function (n) {
      n = Math.trunc(n) || 0;
      if (n < 0) n += this.length;
      return (n < 0 || n >= this.length) ? undefined : this[n];
    };
  }
  if (!Array.prototype.flat) {
    Array.prototype.flat = function (d) {
      var depth = d === undefined ? 1 : Number(d);
      var res = [];
      (function fl(arr, dp) {
        for (var i = 0; i < arr.length; i++) {
          if (Array.isArray(arr[i]) && dp > 0) fl(arr[i], dp - 1);
          else res.push(arr[i]);
        }
      })(this, depth);
      return res;
    };
  }
  if (!Array.prototype.flatMap) {
    Array.prototype.flatMap = function (fn, thisArg) {
      return this.map(fn, thisArg).flat(1);
    };
  }
  if (!Object.fromEntries) {
    Object.fromEntries = function (iter) {
      var obj = {};
      if (!iter) return obj;
      var arr = Array.from ? Array.from(iter) : [];
      for (var i = 0; i < arr.length; i++) {
        if (arr[i] && arr[i].length >= 2) obj[arr[i][0]] = arr[i][1];
      }
      return obj;
    };
  }
  if (!Object.hasOwn) {
    Object.hasOwn = function (o, p) {
      return Object.prototype.hasOwnProperty.call(o, p);
    };
  }
})();

(function () {
  var origAppend = Element.prototype.appendChild;
  Element.prototype.appendChild = function (node) {
    try {
      if (node && node.tagName === 'IFRAME' && /sw_iframe|service_worker|googletagmanager/i.test(String(node.src || ''))) {
        return node;
      }
    } catch (_) {}
    return origAppend.call(this, node);
  };
  window.__WL_GA_ID = 'G-HQXSREQV3R';
  window.__wlGaLoadedId = 'G-HQXSREQV3R';
  window.dataLayer = window.dataLayer || [];
  var cidKey = 'wl_ga_cid_v1';
  var cid = '';
  try { cid = localStorage.getItem(cidKey) || ''; } catch (_) {}
  if (!cid) {
    cid = Math.floor(100000000 + Math.random() * 900000000) + '.' + Math.floor(Date.now() / 1000);
    try { localStorage.setItem(cidKey, cid); } catch (_) {}
  }
  var sid = String(Math.floor(Date.now() / 1000));
  var gaDisabled = false;
  function sendGaHit(tid, evName, params) {
    try {
      if (gaDisabled || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
      var p = params || {};
      var qs = new URLSearchParams({
        v: '2',
        tid: tid,
        cid: cid,
        sid: sid,
        sct: '1',
        seg: '1',
        _s: '1',
        _p: String(Date.now()),
        ul: (navigator.language || 'tr-tr').toLowerCase(),
        sr: (window.screen ? window.screen.width + 'x' + window.screen.height : '1920x1080'),
        dl: location.origin + location.pathname + (location.hash ? location.hash.split('?')[0] : ''),
        dt: p.page_title || document.title || 'Watchlivo',
        en: evName || 'page_view',
        _et: '15000',
        _ee: '1'
      }).toString();
      fetch('/api/rave/ga-collect/g/collect?' + qs, { method: 'POST', keepalive: true })
        .then(function (r) {
          if (r && (r.status === 404 || r.status === 410 || r.status === 501)) {
            gaDisabled = true;
          }
        })
        .catch(function () {});
    } catch (_) {}
  }
  function gtag(cmd, target, params) {
    window.dataLayer.push(arguments);
    if (cmd === 'config' && target) {
      if (!params || params.send_page_view !== false) {
        sendGaHit(target, 'page_view', params);
      }
    } else if (cmd === 'event' && target) {
      sendGaHit(window.__wlGaLoadedId || 'G-HQXSREQV3R', target, params);
      sendGaHit('G-3EGLLTB9J0', target, params);
    }
  }
  window.gtag = gtag;
  window.__initWatchlivoGA4 = function (gaId) {
    if (!gaId || !/^G-[A-Z0-9]{4,20}$/i.test(gaId)) return;
    window.__wlGaLoadedId = gaId;
    try { localStorage.setItem('wl_ga_id', gaId); } catch (_) {}
    sendGaHit(gaId, 'page_view', { page_title: document.title });
  };
})();
