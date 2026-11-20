import test from 'node:test';
import assert from 'node:assert/strict';

import { handleAutonomousEdge } from '../workers/ha-gateway/edge_autonomous.js';
import { WatchlivoRoomDO } from '../workers/ha-gateway/edge_rooms.js';

function createMockRoomDoNamespace(envRef) {
  const instances = new Map();
  return {
    idFromName(name) { return String(name); },
    get(id) {
      const key = String(id);
      if (!instances.has(key)) {
        const backing = new Map();
        const state = {
          storage: {
            async get(k) { return backing.has(k) ? structuredClone(backing.get(k)) : undefined; },
            async put(k, v) { backing.set(k, structuredClone(v)); },
            async delete(k) { backing.delete(k); },
          },
        };
        instances.set(key, new WatchlivoRoomDO(state, envRef));
      }
      return instances.get(key);
    },
  };
}

function createQuotaExhaustedKv(seedMap = {}) {
  const store = new Map(Object.entries(seedMap));
  return {
    putCalls: 0,
    async get(k, mode) {
      if (!store.has(k)) return null;
      const v = store.get(k);
      if (mode === 'json' || mode?.type === 'json') {
        return typeof v === 'string' ? JSON.parse(v) : v;
      }
      return typeof v === 'string' ? v : JSON.stringify(v);
    },
    async put() {
      this.putCalls += 1;
      throw new Error('KV PUT failed: your account has reached the free usage limit for this operation for today [code: 10048]');
    },
    async delete() {
      throw new Error('KV DELETE failed: free usage limit reached [code: 10048]');
    },
  };
}

test('Google OAuth, Register, Login, Profile, Logout, and Delete succeed with ZERO KV writes when Cloudflare KV hits code 10048 daily limit', async () => {
  const exhaustedKv = createQuotaExhaustedKv();
  const env = {
    WATCHLIVO_KV: exhaustedKv,
    PROXY_SECRET: 'test_secret_key_for_wl2_hmac_signing_123456',
  };
  env.ROOM_DO = createMockRoomDoNamespace(env);

  // Mock Google Firebase accounts:lookup for OAuth test
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    const s = String(u);
    if (s.includes('identitytoolkit.googleapis.com/v1/accounts:lookup')) {
      const body = JSON.parse(init?.body || '{}');
      if (body.idToken === 'valid_google_token_1') {
        return new Response(JSON.stringify({
          users: [{
            email: 'dagdakiailesi@gmail.com',
            emailVerified: true,
            displayName: 'Mert Mobile',
            providerUserInfo: [{ providerId: 'google.com', email: 'dagdakiailesi@gmail.com' }],
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { message: 'INVALID_ID_TOKEN' } }), { status: 400 });
    }
    return origFetch(u, init);
  };

  try {
    // 1. Google OAuth login (exact flow failing on mobile for 10 minutes!)
    const oauthReq = new Request('https://watchlivo.online/api/auth/oauth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X)' },
      body: JSON.stringify({ provider: 'google', idToken: 'valid_google_token_1', email: 'dagdakiailesi@gmail.com', name: 'Mert Mobile' }),
    });
    const oauthResp = await handleAutonomousEdge(oauthReq, new URL(oauthReq.url), '/api/auth/oauth', env);
    assert.equal(oauthResp.status, 200);
    const oauthData = await oauthResp.json();
    assert.equal(oauthData.ok, true);
    assert.ok(oauthData.authToken.startsWith('wl2.'), 'must issue wl2 HMAC token');
    assert.equal(oauthData.user.email, 'dagdakiailesi@gmail.com');
    assert.equal(exhaustedKv.putCalls, 0, 'must not burn any WATCHLIVO_KV put() calls');

    // 2. Verify session via /api/auth/me
    const meReq = new Request('https://watchlivo.online/api/auth/me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${oauthData.authToken}` },
    });
    const meResp = await handleAutonomousEdge(meReq, new URL(meReq.url), '/api/auth/me', env);
    assert.equal(meResp.status, 200);
    const meData = await meResp.json();
    assert.equal(meData.authenticated, true);
    assert.equal(meData.user.email, 'dagdakiailesi@gmail.com');

    // 3. Profile update persists in DO SQLite
    const profReq = new Request('https://watchlivo.online/api/auth/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${oauthData.authToken}` },
      body: JSON.stringify({ name: 'Mert Yeni İsim', bio: 'Sinema zamanı' }),
    });
    const profResp = await handleAutonomousEdge(profReq, new URL(profReq.url), '/api/auth/profile', env);
    assert.equal(profResp.status, 200);
    const profData = await profResp.json();
    assert.equal(profData.user.name, 'Mert Yeni İsim');

    // 4. Logout revokes wl2 token immediately
    const loReq = new Request('https://watchlivo.online/api/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${oauthData.authToken}` },
    });
    const loResp = await handleAutonomousEdge(loReq, new URL(loReq.url), '/api/auth/logout', env);
    assert.equal(loResp.status, 200);

    const meAfterLo = await handleAutonomousEdge(meReq, new URL(meReq.url), '/api/auth/me', env);
    assert.equal(meAfterLo.status, 401);

    // 5. Email Register + Login + Delete works with 0 KV writes
    const regReq = new Request('https://watchlivo.online/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'mobile2@outlook.com', password: 'StrongPassword123!', name: 'Ali Mobil' }),
    });
    const regResp = await handleAutonomousEdge(regReq, new URL(regReq.url), '/api/auth/register', env);
    assert.equal(regResp.status, 200);
    const regData = await regResp.json();
    assert.equal(regData.ok, true);

    const loginReq = new Request('https://watchlivo.online/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'mobile2@outlook.com', password: 'StrongPassword123!' }),
    });
    const loginResp = await handleAutonomousEdge(loginReq, new URL(loginReq.url), '/api/auth/login', env);
    assert.equal(loginResp.status, 200);
    const loginData = await loginResp.json();
    assert.equal(loginData.ok, true);

    const delReq = new Request('https://watchlivo.online/api/auth/account', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginData.authToken}` },
      body: JSON.stringify({ password: 'StrongPassword123!' }),
    });
    const delResp = await handleAutonomousEdge(delReq, new URL(delReq.url), '/api/auth/account', env);
    assert.equal(delResp.status, 200);

    // Deleted account token must be rejected even though it is a signed wl2 token
    const meAfterDel = await handleAutonomousEdge(
      new Request('https://watchlivo.online/api/auth/me', { headers: { Authorization: `Bearer ${loginData.authToken}` } }),
      new URL('https://watchlivo.online/api/auth/me'),
      '/api/auth/me',
      env,
    );
    assert.equal(meAfterDel.status, 401);
    assert.equal(exhaustedKv.putCalls, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Legacy WATCHLIVO_KV accounts transparently migrate on read and stay deleted after tombstone', async () => {
  const legacyUser = {
    id: 'u_legacy123456',
    uid: 'u_legacy123456',
    email: 'eskihesap@gmail.com',
    name: 'Eski Üye',
    username: 'Eski Üye',
    handle: 'eskiuye',
    color: '#00f5d4',
    authProvider: 'google',
    verified: true,
    passwordSet: false,
    isGuest: false,
  };
  const exhaustedKv = createQuotaExhaustedKv({
    'acct:eskihesap@gmail.com': JSON.stringify({ user: legacyUser, passHash: '', sv: 0 }),
  });
  const env = {
    WATCHLIVO_KV: exhaustedKv,
    PROXY_SECRET: 'test_secret_key_for_wl2_hmac_signing_123456',
  };
  env.ROOM_DO = createMockRoomDoNamespace(env);

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (u) => {
    if (String(u).includes('identitytoolkit.googleapis.com/v1/accounts:lookup')) {
      return new Response(JSON.stringify({
        users: [{
          email: 'eskihesap@gmail.com',
          emailVerified: true,
          displayName: 'Eski Üye',
          providerUserInfo: [{ providerId: 'google.com', email: 'eskihesap@gmail.com' }],
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return origFetch(u);
  };
  try {
    const resp = await handleAutonomousEdge(
      new Request('https://watchlivo.online/api/auth/oauth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'google', idToken: 'tok_legacy', email: 'eskihesap@gmail.com' }),
      }),
      new URL('https://watchlivo.online/api/auth/oauth'),
      '/api/auth/oauth',
      env,
    );
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.user.uid, 'u_legacy123456');
    assert.equal(data.user.handle, 'eskiuye');

    // Delete legacy account -> tombstone must block legacy KV from resurrecting it
    const delResp = await handleAutonomousEdge(
      new Request('https://watchlivo.online/api/auth/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.authToken}` },
        body: JSON.stringify({}),
      }),
      new URL('https://watchlivo.online/api/auth/account'),
      '/api/auth/account',
      env,
    );
    assert.equal(delResp.status, 200);

    const meAfter = await handleAutonomousEdge(
      new Request('https://watchlivo.online/api/auth/me', { headers: { Authorization: `Bearer ${data.authToken}` } }),
      new URL('https://watchlivo.online/api/auth/me'),
      '/api/auth/me',
      env,
    );
    assert.equal(meAfter.status, 401);
  } finally {
    globalThis.fetch = origFetch;
  }
});
