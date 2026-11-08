# Security & Credential Safety Audit Report: Max Integration & Watchlivo Platform

**Date:** 2026-11-08  
**Auditor:** Subagent 8 (max-security-auditor)  
**Target Codebase:** `c:\Users\pc\Documents\projelerim\rave_web_platform`  
**Classification:** Confidential / Defensive Security Audit  

---

## 1. Executive Summary

This audit evaluates the Max (formerly HBO Max) integration and related streaming/account subsystems across the Watchlivo web platform (`rave_web_platform`). The assessment covered client-side credential handling (`static/js/accounts.js`, `static/js/views/selection.js`), server-side catalog resolution and account endpoints (`server.py`, `rooms.py`, `security.py`), and media routing proxies (`server.py`, `workers/stream-proxy/worker.js`).

### Audit Verdict Overview
- **Item 1: Password Safety & Zero-Exposure:** **PASS (HIGH ASSURANCE)**
- **Item 2: Local Account Storage & Email Masking:** **PASS (HIGH ASSURANCE)**
- **Item 3: Endpoint Privacy & Rate Limiting:** **PARTIAL PASS / ACTION REQUIRED (Rate Limiting Missing)**
- **Item 4: DMCA Compliance & Zero-Piracy Posture:** **PASS (STRICT ZERO-EGRESS/ZERO-DRM-CIRCUMVENTION)**

---

## 2. In-Depth Technical Verification

### 2.1 Password Safety (Console, Storage & Wire Transmission)
- **Source Files Inspected:** `static/js/accounts.js` (lines 153-276), `server.py` (lines 7500-7590).
- **Verification Details:**
  1. **Zero Console Logging:** User input passwords in `openProviderLoginModal` are never passed to `console.log`, `console.info`, or error tracking routines.
  2. **Zero Plaintext Storage in LocalStorage:** In `accounts.js` (lines 255-263), when the user clicks `"✓ 2. Adım: Şifreyi Doğrula & Bağla"`, only the following dictionary is committed to localStorage under `vortex_accounts_v7:<uid>`:
     ```javascript
     local[p.id] = {
       loginSatisfied: true,
       userAuthenticated: true,
       accountEmail: maskAccountEmail(em),
       profileName: pr,
       updatedAt: Date.now(),
     };
     ```
     The variable `pw` (`pwInp.value`) is discarded immediately and **never written to localStorage**.
  3. **Zero Plaintext Wire Transmission:** The frontend never dispatches network requests containing the provider password. The server endpoint `/api/rave/accounts/login` is a fail-closed stub (`501 unsupported`) that refuses credentials and directs users to official browser sign-in. Furthermore, `SecurityHeaders` middleware in `server.py` enforces `Strict-Transport-Security: max-age=31536000; includeSubDomains`.

---

### 2.2 Local Account Storage & Session References (`accounts.js`)
- **Source Files Inspected:** `static/js/accounts.js` (lines 6-37, 87-133).
- **Verification Details:**
  1. **Deterministic Email Masking:** `maskAccountEmail(raw)` masks all email addresses to `ab***@domain.com` (e.g. `us***@gmail.com`). Masking is enforced twice: on write (`maskAccountEmail(em)`) and defensively on read (`getAccount()`).
  2. **User-Scoped Storage Keys:** Local storage keys are partitioned per authenticated user (`vortex_accounts_v7:<uid>`), isolating account links between distinct users on shared devices.
  3. **Zero-Knowledge Session Scrubbing:** `fetchAccounts()` automatically strips any legacy `cookies` or `yRaveHeader` keys from local storage. `cookieCount: 0` and `cookies: []` are hardcoded.
  4. **Cookie Display Lockdown:** `openSiteDataModal()` prevents cookie display and displays: `"Güvenlik nedeniyle çerez paylaşımı ve gösterimi devre dışı bırakıldı."`

---

### 2.3 Endpoint Data Isolation & Rate Limiting (`/api/rave/*`)
- **Source Files Inspected:** `server.py` (lines 6630-6710, 7556-7647), `rooms.py` (lines 478-585).
- **Verification Details:**
  1. **Zero Cookie / Token Exposure to Room Members:**
     - `/api/rave/resolve-catalog` returns media and playlist metadata (`id`, `provider`, `title`, `url`, `servers`, `subtitleTracks`, `audioTracks`). It does not return or accept cookies, tokens, or session credentials.
     - `rooms.py:clean_media()` sanitizes all media objects sent across WebSocket/SSE sync channels, strictly allowing only benign playback fields (`provider`, `url`, `duration`, `title`, `thumbnail`). Internal cookies or headers are never broadcast to other room participants.
     - `/api/rave/accounts/*` endpoints always return empty cookie arrays (`cookies: []`) with `"zeroKnowledge": True`.
  2. **Rate Limiting Finding (Vulnerability / Gap):**
     - **GAP IDENTIFIED:** `/api/rave/resolve-catalog` lacks an IP-based `RateLimiter.hit()` invocation. Although protected by in-memory deduplication locks (`_RESOLVE_LOCKS`) and response caching (`_RESOLVE_RESP_CACHE`), uncached queries can trigger concurrent TMDB and upstream calls without request throttling.
     - **GAP IDENTIFIED:** `/api/rave/accounts/*` endpoints (`rave_get_accounts`, `rave_login_account`, `rave_browser_login`, `rave_logout_account`) lack explicit rate limiters.

---

### 2.4 DMCA / Zero-Piracy Posture (Max Proprietary Media)
- **Source Files Inspected:** `server.py` (lines 81-107, 5372-5415, 8872-8925), `security.py` (lines 498-526), `workers/stream-proxy/worker.js`.
- **Verification Details:**
  1. **No DRM Circumvention:** Max copyrighted content is encrypted under Widevine DRM (CENC). Watchlivo contains zero Widevine CDM keys, license spoofers, or decryptors.
  2. **Zero Download / Permanent Storage:** Watchlivo servers contain no download workers, disk storage routines, or video files (`.mp4`, `.mkv`) for Max content.
  3. **No Proxying of Official Max Streams:**
     - `stream_proxy` requires a cryptographically valid HMAC-SHA256 signature (`_proxy_sig_ok`).
     - The signature generator `_proxy_u` is only invoked for whitelisted third-party fallback streams and public archives. It is **never** invoked for `*.max.com`, `*.hbomax.com`, or WarnerMedia CDNs.
  4. **Transient Sync Ring-Buffer Only:** `_SEGMENT_CACHE` is an ephemeral memory ring-buffer (max 96 chunks, 90s TTL) dedicated solely to live playback synchronization of approved HLS segments across room participants. No copyrighted streams are archived.

---

## 3. Remediation Recommendations

1. **Add Strict Rate Limiting on Catalog Resolution:**
   Add `_RESOLVE_CATALOG_LIMIT = RateLimiter(60, 60.0, name="resolve_catalog")` in `server.py` and invoke `allowed, retry_after = _RESOLVE_CATALOG_LIMIT.hit(client_ip(request))` at the start of `resolve_catalog`.
2. **Add Rate Limiting on Accounts Endpoints:**
   Add `_ACCOUNTS_LIMIT = RateLimiter(30, 60.0, name="rave_accounts")` protecting `/api/rave/accounts/*` against automated brute-force or denial-of-service attempts.
3. **Client-side Memory Hygiene in `accounts.js`:**
   In `openProviderLoginModal` (inside the `onClick` handler of the confirm button), clear `pwInp.value = ""` immediately after reading to eliminate residual credentials in DOM properties.

---
**Audit Status:** Complete & Verified.
