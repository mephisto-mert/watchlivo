import test from 'node:test';
import assert from 'node:assert/strict';

import { handleAutonomousEdge } from '../workers/ha-gateway/edge_autonomous.js';
import { WatchlivoRoomDO, resetRoomDoQuotaGuardForTests } from '../workers/ha-gateway/edge_rooms.js';

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

    // Passwordless OAuth delete must reject empty {} with 400 and keep account active
    const delRejectResp = await handleAutonomousEdge(
      new Request('https://watchlivo.online/api/auth/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.authToken}` },
        body: JSON.stringify({}),
      }),
      new URL('https://watchlivo.online/api/auth/account'),
      '/api/auth/account',
      env,
    );
    assert.equal(delRejectResp.status, 400);

    const meStillActive = await handleAutonomousEdge(
      new Request('https://watchlivo.online/api/auth/me', { headers: { Authorization: `Bearer ${data.authToken}` } }),
      new URL('https://watchlivo.online/api/auth/me'),
      '/api/auth/me',
      env,
    );
    assert.equal(meStillActive.status, 200);

    // Delete legacy passwordless account with explicit confirmDelete: true -> tombstone must block legacy KV from resurrecting it
    const delResp = await handleAutonomousEdge(
      new Request('https://watchlivo.online/api/auth/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.authToken}` },
        body: JSON.stringify({ confirmDelete: true }),
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

test('Rooms create/sync/info succeed with ZERO 503 when BOTH Durable Objects free tier AND KV daily write limit are exhausted', async () => {
  let doCalls = 0;
  const quotaExceededDo = {
    idFromName(name) { return name; },
    get() {
      return {
        async fetch() {
          doCalls += 1;
          throw new Error('Exceeded allowed volume of requests in Durable Objects free tier.');
        },
      };
    },
  };
  const exhaustedKv = createQuotaExhaustedKv();
  const env = {
    ROOM_DO: quotaExceededDo,
    WATCHLIVO_KV: exhaustedKv,
    PROXY_SECRET: 'test_secret_key_for_do_quota_failover_999999',
  };

  // 1. POST /api/rooms succeeds with 200 OK instead of 503!
  const createResp = await handleAutonomousEdge(
    new Request('https://watchlivo.online/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Game of Thrones Odası',
        privacy: 'public',
        creator: 'Mert',
        media: { title: 'Game of Thrones', url: '/api/rave/stream?sid=got&ext=.m3u8', provider: 'hls' },
      }),
    }),
    new URL('https://watchlivo.online/api/rooms'),
    '/api/rooms',
    env,
  );
  assert.equal(createResp.status, 200);
  const created = await createResp.json();
  assert.equal(created.ok, true);
  assert.ok(created.room?.id);
  assert.ok(created.clientToken);
  assert.ok(created.room?.syncToken, 'Fallback room must emit signed syncToken');
  const rid = created.room.id;

  // 2. Subsequent room sync (play/chat/poll) succeeds with 200 OK and short-circuits DO!
  const callsAfterCreate = doCalls;
  const syncResp = await handleAutonomousEdge(
    new Request(`https://watchlivo.online/api/rooms/${rid}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'chat',
        clientId: created.clientId,
        clientToken: created.clientToken,
        syncToken: created.room.syncToken,
        username: 'Mert',
        text: 'Selam',
      }),
    }),
    new URL(`https://watchlivo.online/api/rooms/${rid}/sync`),
    `/api/rooms/${rid}/sync`,
    env,
  );
  assert.equal(syncResp.status, 200);
  const synced = await syncResp.json();
  assert.equal(synced.ok, true);
  assert.equal(doCalls, callsAfterCreate, 'Quota circuit breaker must skip failing DO calls during cooldown');

  // 3. GET /api/rooms/:id info returns 200 OK from in-isolate memory fallback!
  const infoResp = await handleAutonomousEdge(
    new Request(`https://watchlivo.online/api/rooms/${rid}`),
    new URL(`https://watchlivo.online/api/rooms/${rid}`),
    `/api/rooms/${rid}`,
    env,
  );
  assert.equal(infoResp.status, 200);
  const info = await infoResp.json();
  assert.equal(info.ok, true);
  assert.equal(info.room?.id, rid);
});

test('v236 cross-device D1 ROOMS_DB sync: Host A (Isolate 1) and Friend B (Isolate 2) see each other immediately even when DO + KV quotas are both exhausted', async () => {
  resetRoomDoQuotaGuardForTests();
  const d1Rooms = new Map();
  const d1Kv = new Map();
  let roomWriteCount = 0;
  const mockD1 = {
    prepare(sql) {
      const s = String(sql || '').trim();
      const exec = (params) => ({
        async run() {
          if (s.startsWith('CREATE TABLE')) return { success: true };
          if (s.startsWith('INSERT INTO edge_rooms')) {
            const isClose = s.includes("VALUES (?, '{}', 1");
            if (isClose) {
              d1Rooms.set(params[0], { data: '{}', closed: 1, updated_at: params[1] });
            } else {
              if (params[0] !== '__public_index__') roomWriteCount += 1;
              d1Rooms.set(params[0], { data: params[1], closed: 0, updated_at: params[2] });
            }
            return { success: true };
          }
          if (s.startsWith('DELETE FROM edge_rooms')) {
            const cur = d1Rooms.get(params[0]);
            if (cur && cur.closed === 1) d1Rooms.delete(params[0]);
            return { success: true };
          }
          if (s.startsWith('INSERT INTO edge_kv')) {
            const isDel = s.includes('VALUES (?, NULL, 0, 1)');
            if (isDel) d1Kv.set(params[0], { v: null, exp: 0, deleted: 1 });
            else d1Kv.set(params[0], { v: params[1], exp: params[2], deleted: 0 });
            return { success: true };
          }
          if (s.startsWith('DELETE FROM edge_kv')) {
            d1Kv.delete(params[0]);
            return { success: true };
          }
          return { success: true };
        },
        async first() {
          if (s.includes('FROM edge_rooms WHERE id = ?')) {
            return d1Rooms.get(params[0]) || null;
          }
          if (s.includes('FROM edge_kv WHERE k = ?')) {
            return d1Kv.get(params[0]) || null;
          }
          return null;
        },
      });
      return {
        bind(...params) { return exec(params); },
        run() { return exec([]).run(); },
        first() { return exec([]).first(); },
      };
    },
  };

  const quotaExceededDo = {
    idFromName(name) { return name; },
    get() {
      return {
        async fetch() { throw new Error('Exceeded allowed volume of requests in Durable Objects free tier.'); },
      };
    },
  };
  const env = {
    ROOM_DO: quotaExceededDo,
    WATCHLIVO_KV: createQuotaExhaustedKv(),
    ROOMS_DB: mockD1,
    PROXY_SECRET: 'test_secret_key_for_v236_d1_sync_123456',
  };

  // 1. Host A (PC, Isolate #1) creates a room
  const createResp = await handleAutonomousEdge(
    new Request('https://watchlivo.online/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Arkadaş Odası',
        privacy: 'public',
        creator: 'HostAli',
        media: { title: 'Inception', url: '/api/rave/stream?sid=inc&ext=.m3u8', provider: 'hls' },
      }),
    }),
    new URL('https://watchlivo.online/api/rooms'),
    '/api/rooms',
    env,
  );
  assert.equal(createResp.status, 200);
  const created = await createResp.json();
  const rid = created.room.id;
  assert.equal(created.room.participants.length, 1);

  // 2. Simulate Friend B hitting a COMPLETELY DIFFERENT Worker isolate / POP (empty local RAM!)
  resetRoomDoQuotaGuardForTests();

  // Friend B checks /api/rooms/:id/info -> MUST return 200 OK (NOT 404!)
  const bInfoResp = await handleAutonomousEdge(
    new Request(`https://watchlivo.online/api/rooms/${rid}/info`),
    new URL(`https://watchlivo.online/api/rooms/${rid}/info`),
    `/api/rooms/${rid}/info`,
    env,
  );
  assert.equal(bInfoResp.status, 200);

  // Friend B joins room via /sync init (no syncToken!)
  const bInitResp = await handleAutonomousEdge(
    new Request(`https://watchlivo.online/api/rooms/${rid}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'init', username: 'ArkadasVeli', uid: 'uid_veli' }),
    }),
    new URL(`https://watchlivo.online/api/rooms/${rid}/sync`),
    `/api/rooms/${rid}/sync`,
    env,
  );
  assert.equal(bInitResp.status, 200);
  const bInit = await bInitResp.json();
  assert.equal(bInit.room.media.title, 'Inception', 'Friend B must receive Host A movie');
  const bNames = bInit.room.participants.map((p) => p.name).sort();
  assert.deepEqual(bNames, ['ArkadasVeli', 'HostAli'], 'Friend B must immediately see Host A AND themselves');

  // 3. Friend B sends a chat message from Isolate #2
  await handleAutonomousEdge(
    new Request(`https://watchlivo.online/api/rooms/${rid}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'chat',
        clientId: bInit.clientId,
        clientToken: bInit.clientToken,
        username: 'ArkadasVeli',
        text: 'Selam kanka geldim!',
      }),
    }),
    new URL(`https://watchlivo.online/api/rooms/${rid}/sync`),
    `/api/rooms/${rid}/sync`,
    env,
  );

  // 4. Host A polls from Isolate #1 -> MUST see BOTH users & Friend B chat (no stale RAM split-brain!)
  const writesBeforePoll = roomWriteCount;
  const aPollResp = await handleAutonomousEdge(
    new Request(`https://watchlivo.online/api/rooms/${rid}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'poll',
        clientId: created.clientId,
        clientToken: created.clientToken,
        username: 'HostAli',
      }),
    }),
    new URL(`https://watchlivo.online/api/rooms/${rid}/sync`),
    `/api/rooms/${rid}/sync`,
    env,
  );
  assert.equal(aPollResp.status, 200);
  const aPoll = await aPollResp.json();
  const aNames = aPoll.room.participants.map((p) => p.name).sort();
  assert.deepEqual(aNames, ['ArkadasVeli', 'HostAli'], 'Host A must immediately see Friend B');
  assert.ok(aPoll.room.chat.some((m) => m.text === 'Selam kanka geldim!'), 'Host A must receive Friend B chat');
  assert.equal(roomWriteCount, writesBeforePoll, 'Unchanged poll within 12s must NOT execute redundant D1 writes');

  // 5. Public room list GET /api/rooms must surface the room globally from D1
  const listResp = await handleAutonomousEdge(
    new Request('https://watchlivo.online/api/rooms'),
    new URL('https://watchlivo.online/api/rooms'),
    '/api/rooms',
    env,
  );
  assert.equal(listResp.status, 200);
  const listData = await listResp.json();
  assert.ok(listData.rooms.some((r) => r.id === rid && r.participantCount === 2), 'Public lobby list must show room with 2 participants');
  resetRoomDoQuotaGuardForTests();
});

test('v237 WatchlivoRoomDO heartbeat throttles steady-state storage writes and broadcasts WebSocket sync on host buffer drift (>= 1.8s)', async () => {
  let storagePuts = 0;
  const backing = new Map();
  const state = {
    storage: {
      async get(k) { return backing.has(k) ? structuredClone(backing.get(k)) : undefined; },
      async put(k, v) { storagePuts += 1; backing.set(k, structuredClone(v)); },
      async delete(k) { backing.delete(k); },
    },
  };
  const env = { PROXY_SECRET: 'test_secret_key_for_v237_hb_do_123456' };
  const roomDo = new WatchlivoRoomDO(state, env);

  // 1. Create room with playing media at t=100s
  const createResp = await roomDo.fetch(new Request('https://do.local/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Room-Id': 'wl-hb-test' },
    body: JSON.stringify({
      name: 'HB Test',
      creator: 'HostMert',
      media: { title: 'You S1E5', url: '/api/rave/stream?sid=you5', provider: 'hls', playing: true, currentTime: 100 },
    }),
  }));
  const created = await createResp.json();
  assert.equal(created.ok, true);

  // Attach a mock Guest WebSocket subscriber on the DO
  const guestMsgs = [];
  const mockGuestWs = {
    readyState: 1,
    send(payload) { guestMsgs.push(JSON.parse(payload)); },
  };
  roomDo.sockets.set(mockGuestWs, { cid: 'guest_1', uname: 'Arkadas' });

  // 2. First steady-state heartbeat right after creation (drift < 0.5s) -> saves once (initial _lastHbSave), NO sync broadcast spam
  const putsAfterCreate = storagePuts;
  const hb1 = await roomDo.fetch(new Request('https://do.local/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Room-Id': 'wl-hb-test' },
    body: JSON.stringify({
      type: 'heartbeat',
      clientId: created.clientId,
      clientToken: created.clientToken,
      currentTime: 100.1,
      playing: true,
    }),
  }));
  assert.equal(hb1.status, 200);
  const putsAfterHb1 = storagePuts;
  assert.equal(putsAfterHb1, putsAfterCreate + 1, 'First heartbeat records initial _lastHbSave');
  assert.equal(guestMsgs.length, 0, 'Steady-state heartbeat with <1.8s drift must NOT spam WebSocket sync events');

  // 3. Second steady-state heartbeat immediately after (drift < 0.3s, <20s elapsed) -> ZERO storage write, ZERO WS spam!
  const hb2 = await roomDo.fetch(new Request('https://do.local/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Room-Id': 'wl-hb-test' },
    body: JSON.stringify({
      type: 'heartbeat',
      clientId: created.clientId,
      clientToken: created.clientToken,
      currentTime: 100.2,
      playing: true,
    }),
  }));
  assert.equal(hb2.status, 200);
  assert.equal(storagePuts, putsAfterHb1, 'Steady-state heartbeat within 20s window must throttle DO storage writes');
  assert.equal(guestMsgs.length, 0);

  // 4. Host stalls/buffers for 4s (reported currentTime lags expected by 4s >= 1.8s) -> MUST persist & broadcast sync to Guest WS!
  const hbDrift = await roomDo.fetch(new Request('https://do.local/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Room-Id': 'wl-hb-test' },
    body: JSON.stringify({
      type: 'heartbeat',
      clientId: created.clientId,
      clientToken: created.clientToken,
      currentTime: 95.5,
      playing: true,
    }),
  }));
  assert.equal(hbDrift.status, 200);
  assert.equal(storagePuts, putsAfterHb1 + 1, 'Significant drift >= 1.8s must flush DO storage');
  assert.equal(guestMsgs.length, 1, 'Significant drift >= 1.8s must broadcast sync event over WebSocket to Guests');
  assert.equal(guestMsgs[0].type, 'sync');
  assert.equal(guestMsgs[0].action, 'heartbeat');
  assert.equal(guestMsgs[0].currentTime, 95.5);
});

test('v239 M1 auth/security: fail-closed wl2 (401 missing acct, 503 storage failure), SVG avatar block + 2048 cap, passwordless set, prefs/export/sessions/claim-guest, guest recovery, allowInvites & watchMinutes', async () => {
  resetRoomDoQuotaGuardForTests();
  const mapStore = new Map();
  const memKv = {
    async get(k, mode) {
      if (!mapStore.has(k)) return null;
      const v = mapStore.get(k);
      if (mode === 'json' || mode?.type === 'json') return typeof v === 'string' ? JSON.parse(v) : v;
      return typeof v === 'string' ? v : JSON.stringify(v);
    },
    async put(k, v) { mapStore.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
    async delete(k) { mapStore.delete(k); },
  };
  const env = {
    WATCHLIVO_KV: memKv,
    PROXY_SECRET: 'test_secret_key_for_v239_m1_auth_suite_1234',
  };

  // 1. Register user A and user B
  const regA = await (await handleAutonomousEdge(
    new Request('https://watchlivo.online/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0)' },
      body: JSON.stringify({ email: 'alpha@watchlivo.online', password: 'Password123!', name: 'Alpha', handle: 'alpha_user' }),
    }),
    new URL('https://watchlivo.online/api/auth/register'),
    '/api/auth/register',
    env,
  )).json();
  assert.equal(regA.ok, true);
  assert.ok(regA.authToken.startsWith('wl2.'));

  const regB = await (await handleAutonomousEdge(
    new Request('https://watchlivo.online/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'beta@watchlivo.online', password: 'Password123!', name: 'Beta', handle: 'beta_user' }),
    }),
    new URL('https://watchlivo.online/api/auth/register'),
    '/api/auth/register',
    env,
  )).json();
  assert.equal(regB.ok, true);

  // 2. Fail-closed wl2: deleted/missing acct:<email> returns 401 (NO fallbackUser!)
  mapStore.delete('acct:alpha@watchlivo.online');
  const meMissing = await handleAutonomousEdge(
    new Request('https://watchlivo.online/api/auth/me', { headers: { Authorization: `Bearer ${regA.authToken}` } }),
    new URL('https://watchlivo.online/api/auth/me'),
    '/api/auth/me',
    env,
  );
  assert.equal(meMissing.status, 401);

  // 3. Fail-closed wl2: when ALL persistent backends throw on read -> 503 storage_unavailable
  const brokenKv = {
    async get() { throw new Error('KV read timeout'); },
    async put() { throw new Error('KV write timeout'); },
    async delete() { throw new Error('KV delete timeout'); },
  };
  const brokenDo = {
    idFromName(n) { return n; },
    get() { return { async fetch() { throw new Error('DO down'); } }; },
  };
  const brokenD1 = {
    prepare() {
      const q = {
        bind() { return q; },
        async run() { throw new Error('D1 down'); },
        async first() { throw new Error('D1 down'); },
      };
      return q;
    },
  };
  const meStorageDown = await handleAutonomousEdge(
    new Request('https://watchlivo.online/api/auth/me', { headers: { Authorization: `Bearer ${regB.authToken}` } }),
    new URL('https://watchlivo.online/api/auth/me'),
    '/api/auth/me',
    { WATCHLIVO_KV: brokenKv, ROOM_DO: brokenDo, ROOMS_DB: brokenD1, PROXY_SECRET: env.PROXY_SECRET },
  );
  assert.equal(meStorageDown.status, 503);

  // 4. Avatar sanitization: block SVG variants, allow 1000+ char HTTPS URL (<= 2048)
  for (const badAv of [
    'https://evil.com/xss.svg',
    'https://evil.com/xss.SVGZ?v=1',
    '/static/watchlivo-poster.svg',
    'https://cdn.example.com/img?fmt=image/svg+xml',
    'https://evil.com/a%2esvg',
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
  ]) {
    const rBad = await handleAutonomousEdge(
      new Request('https://watchlivo.online/api/auth/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${regB.authToken}` },
        body: JSON.stringify({ avatarUrl: badAv }),
      }),
      new URL('https://watchlivo.online/api/auth/profile'),
      '/api/auth/profile',
      env,
    );
    assert.equal(rBad.status, 400, `must reject SVG avatar: ${badAv}`);
  }
  const longHttpsAvatar = `https://cdn.example.com/avatars/${'a'.repeat(1100)}.webp`;
  const rGoodAv = await handleAutonomousEdge(
    new Request('https://watchlivo.online/api/auth/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${regB.authToken}` },
      body: JSON.stringify({ avatarUrl: longHttpsAvatar }),
    }),
    new URL('https://watchlivo.online/api/auth/profile'),
    '/api/auth/profile',
    env,
  );
  assert.equal(rGoodAv.status, 200);
  const goodAvData = await rGoodAv.json();
  assert.equal(goodAvData.user.avatarUrl.length, longHttpsAvatar.length);

  // 5. Passwordless Google OAuth: passwordSet === false and initial password set without oldPassword
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (u) => {
    if (String(u).includes('identitytoolkit.googleapis.com/v1/accounts:lookup')) {
      return new Response(JSON.stringify({
        users: [{ email: 'googleonly@gmail.com', emailVerified: true, displayName: 'GoogleOnly', providerUserInfo: [{ providerId: 'google.com', email: 'googleonly@gmail.com' }] }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return origFetch(u);
  };
  let gTok = '';
  try {
    const gResp = await (await handleAutonomousEdge(
      new Request('https://watchlivo.online/api/auth/oauth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'google', idToken: 'g_tok_1' }),
      }),
      new URL('https://watchlivo.online/api/auth/oauth'),
      '/api/auth/oauth',
      env,
    )).json();
    assert.equal(gResp.ok, true);
    assert.equal(gResp.user.passwordSet, false);
    gTok = gResp.authToken;

    const pwResp = await handleAutonomousEdge(
      new Request('https://watchlivo.online/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gTok}` },
        body: JSON.stringify({ newPassword: 'InitialPassword123!' }),
      }),
      new URL('https://watchlivo.online/api/auth/password'),
      '/api/auth/password',
      env,
    );
    assert.equal(pwResp.status, 200);
    const pwData = await pwResp.json();
    assert.equal(pwData.user.passwordSet, true);
    gTok = pwData.authToken;
  } finally {
    globalThis.fetch = origFetch;
  }

  // 6. /api/user/preferences, /api/auth/sessions, /api/auth/export, /api/user/watch-minutes
  const putPref = await handleAutonomousEdge(
    new Request('https://watchlivo.online/api/user/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gTok}` },
      body: JSON.stringify({ subSize: 'lg', notifSoundMuted: true, brightness: 0 }),
    }),
    new URL('https://watchlivo.online/api/user/preferences'),
    '/api/user/preferences',
    env,
  );
  assert.equal(putPref.status, 200);
  const prefJson = await putPref.json();
  assert.equal(prefJson.preferences.subSize, 'lg');
  assert.equal(prefJson.preferences.notifSoundMuted, true);
  assert.equal(prefJson.preferences.brightness, 0);

  const sessResp = await (await handleAutonomousEdge(
    new Request('https://watchlivo.online/api/auth/sessions', { headers: { Authorization: `Bearer ${gTok}` } }),
    new URL('https://watchlivo.online/api/auth/sessions'),
    '/api/auth/sessions',
    env,
  )).json();
  assert.equal(sessResp.ok, true);
  assert.ok(sessResp.sessions.length >= 1);
  assert.equal(sessResp.sessions[0].current, true);

  const wmResp = await (await handleAutonomousEdge(
    new Request('https://watchlivo.online/api/user/watch-minutes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gTok}` },
      body: JSON.stringify({ minutes: 35 }),
    }),
    new URL('https://watchlivo.online/api/user/watch-minutes'),
    '/api/user/watch-minutes',
    env,
  )).json();
  assert.equal(wmResp.watchMinutes, 35);
  assert.equal(wmResp.medal, '🥉 Bronz İzleyici');

  const expResp = await (await handleAutonomousEdge(
    new Request('https://watchlivo.online/api/auth/export', { headers: { Authorization: `Bearer ${gTok}` } }),
    new URL('https://watchlivo.online/api/auth/export'),
    '/api/auth/export',
    env,
  )).json();
  assert.equal(expResp.ok, true);
  assert.equal(expResp.preferences.subSize, 'lg');
  assert.equal(expResp.user.passHash, undefined);

  // 7. Guest 409 auto-recovery + claim-guest + allowInvites enforcement
  const guestBoot1 = await (await handleAutonomousEdge(
    new Request('https://watchlivo.online/api/rave/social/guest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Beta', handle: 'beta_user' }),
    }),
    new URL('https://watchlivo.online/api/rave/social/guest'),
    '/api/rave/social/guest',
    env,
  )).json();
  assert.equal(guestBoot1.ok, true);
  assert.notEqual(guestBoot1.handle, 'beta_user');
  assert.ok(guestBoot1.handle.startsWith('beta_user_'));

  // Add 10 watchMinutes to guest via presence, then claim-guest into Beta
  await handleAutonomousEdge(
    new Request('https://watchlivo.online/api/rave/social/presence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Guest-Token': guestBoot1.guestToken },
      body: JSON.stringify({ uid: guestBoot1.uid, state: 'watching', roomId: 'r1', watchMinutesDelta: 10 }),
    }),
    new URL('https://watchlivo.online/api/rave/social/presence'),
    '/api/rave/social/presence',
    env,
  );
  const claimResp = await (await handleAutonomousEdge(
    new Request('https://watchlivo.online/api/rave/social/claim-guest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${regB.authToken}` },
      body: JSON.stringify({ guestUid: guestBoot1.uid, guestToken: guestBoot1.guestToken, watchlist: [{ key: 'tmdb-movie-603', title: 'Matrix' }] }),
    }),
    new URL('https://watchlivo.online/api/rave/social/claim-guest'),
    '/api/rave/social/claim-guest',
    env,
  )).json();
  assert.equal(claimResp.ok, true);
  assert.equal(claimResp.claimed, true);
  assert.equal(claimResp.watchMinutes, 10);

  // allowInvites: "nobody" rejects invite with 403, "everyone" allows non-friend invite with 200
  await handleAutonomousEdge(
    new Request('https://watchlivo.online/api/rave/social/friends', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${regB.authToken}` },
      body: JSON.stringify({ action: 'privacy', allowInvites: 'nobody' }),
    }),
    new URL('https://watchlivo.online/api/rave/social/friends'),
    '/api/rave/social/friends',
    env,
  );
  const invNobody = await handleAutonomousEdge(
    new Request('https://watchlivo.online/api/rave/social/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gTok}` },
      body: JSON.stringify({ targetUid: regB.user.uid, roomId: 'wl-test-1', roomName: 'Test Oda' }),
    }),
    new URL('https://watchlivo.online/api/rave/social/invite'),
    '/api/rave/social/invite',
    env,
  );
  assert.equal(invNobody.status, 403);

  await handleAutonomousEdge(
    new Request('https://watchlivo.online/api/rave/social/friends', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${regB.authToken}` },
      body: JSON.stringify({ action: 'privacy', allowInvites: 'everyone' }),
    }),
    new URL('https://watchlivo.online/api/rave/social/friends'),
    '/api/rave/social/friends',
    env,
  );
  const invEveryone = await handleAutonomousEdge(
    new Request('https://watchlivo.online/api/rave/social/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gTok}` },
      body: JSON.stringify({ targetUid: regB.user.uid, roomId: 'wl-test-1', roomName: 'Test Oda' }),
    }),
    new URL('https://watchlivo.online/api/rave/social/invite'),
    '/api/rave/social/invite',
    env,
  );
  assert.equal(invEveryone.status, 200);
});

test('v239 M1 platform/catalog/search/episodes/seasons/subtitles: version routes, health, latest-episodes filter, bidirectional scifi, uniform ranking, OTT providers, supersearch YT, seasons specials & YT subtitles', async () => {
  const mapStore = new Map();
  const memKv = {
    async get(k, mode) {
      if (!mapStore.has(k)) return null;
      const v = mapStore.get(k);
      if (mode === 'json' || mode?.type === 'json') return typeof v === 'string' ? JSON.parse(v) : v;
      return typeof v === 'string' ? v : JSON.stringify(v);
    },
    async put(k, v) { mapStore.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
    async delete(k) { mapStore.delete(k); },
  };
  const bootPayload = JSON.stringify({
    version: '20261124_v239',
    catalog: [
      { id: 'fhd-zohan', tmdbId: '10661', mediaType: 'movie', title: "Zohan'a Bulaşma", originalTitle: "You Don't Mess with the Zohan", year: '2008', rating: 7.9, voteCount: 37535, categories: ['movies', 'comedy', 'dublaj'], provider: 'cinema' },
      { id: 'fhd-moana', tmdbId: '1108427', mediaType: 'movie', title: 'Moana', originalTitle: 'Moana', year: '2026', rating: 7.9, voteCount: 37910, categories: ['movies', 'animation'], provider: 'cinema' },
      { id: 'tr-gibi', tmdbId: '117581', mediaType: 'tv', title: 'Gibi', originalTitle: 'Gibi', origLang: 'tr', year: '2021', rating: 8.9, voteCount: 1500, categories: ['series', 'tr', 'comedy'], provider: 'exxen' },
    ],
    curatedRooms: [],
    newReleases: [],
    latestEpisodes: [],
  });
  const env = {
    WATCHLIVO_KV: memKv,
    PROXY_SECRET: 'test_secret_key_for_v239_m1_catalog_suite',
    ASSETS: {
      async fetch(req) {
        const u = new URL(typeof req === 'string' ? req : req.url);
        if (u.pathname === '/_edge/bootstrap.json') return new Response(bootPayload, { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (u.pathname === '/app_version.json') return new Response(JSON.stringify({ ok: true, versionCode: 27, versionName: '2.0.6-v206' }), { status: 200 });
        if (u.pathname === '/ios_version.json') return new Response(JSON.stringify({ ok: true, bundleId: 'online.watchlivo.app', versionName: '2.2.11', ipaUrl: 'https://watchlivo.online/download/ipa' }), { status: 200 });
        return new Response('Not Found', { status: 404 });
      },
    },
  };

  // 1. Native platform version routes + HEAD + /api/health
  const appVer = await handleAutonomousEdge(new Request('https://watchlivo.online/api/app/version'), new URL('https://watchlivo.online/api/app/version'), '/api/app/version', env);
  assert.equal(appVer.status, 200);
  assert.equal(appVer.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal((await appVer.json()).versionName, '2.0.6-v206');

  const plistHead = await handleAutonomousEdge(new Request('https://watchlivo.online/api/ios/manifest.plist', { method: 'HEAD' }), new URL('https://watchlivo.online/api/ios/manifest.plist'), '/api/ios/manifest.plist', env);
  assert.equal(plistHead.status, 200);
  assert.equal(plistHead.headers.get('Content-Type'), 'application/xml; charset=utf-8');
  assert.equal(await plistHead.text(), '');

  const plistGet = await handleAutonomousEdge(new Request('https://watchlivo.online/api/ios/manifest.plist'), new URL('https://watchlivo.online/api/ios/manifest.plist'), '/api/ios/manifest.plist', env);
  const plistXml = await plistGet.text();
  assert.ok(plistXml.includes('<string>2.2.11</string>'));
  assert.ok(plistXml.includes('<string>online.watchlivo.app</string>'));

  const healthJson = await (await handleAutonomousEdge(new Request('https://watchlivo.online/api/health'), new URL('https://watchlivo.online/api/health'), '/api/health', env)).json();
  assert.equal(healthJson.version, '20261124_v239');

  // 2. Mocked fetch for TMDB / YouTube / AnimeciX
  const seenDiscoverUrls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const u = String(typeof input === 'string' ? input : input?.url || '');
    if (u.includes('sinemacc.com')) return new Response('', { status: 503 });
    if (u.includes('animecix.tv/secure/last-episodes')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    if (u.includes('animecix.tv/secure/titles/13561')) {
      return new Response(JSON.stringify({
        title: { id: 13561, name: 'Test Anime', seasons: [{ number: 0, episodes_count: 2 }, { number: 1, episodes_count: 12 }], season: { episodes: [{ episode_number: 1, name: 'Ep 1', runtime: 24, release_date: '2026-01-01' }] } },
      }), { status: 200 });
    }
    if (u.includes('api.themoviedb.org/3/tv/on_the_air')) {
      return new Response(JSON.stringify({
        results: [
          { id: 1001, name: 'Talk Show', poster_path: '/t.jpg', vote_count: 500, popularity: 999, genre_ids: [10767], original_language: 'en' },
          { id: 1002, name: 'Gerçek Dizi', poster_path: '/g.jpg', vote_count: 300, popularity: 120, genre_ids: [18], original_language: 'tr' },
        ],
      }), { status: 200 });
    }
    if (u.includes('api.themoviedb.org/3/tv/1002?')) {
      return new Response(JSON.stringify({
        id: 1002, name: 'Gerçek Dizi', original_name: 'Gerçek Dizi', original_language: 'tr', poster_path: '/g.jpg', first_air_date: '2025-01-01', vote_average: 8.4, genres: [{ id: 18 }],
        last_episode_to_air: { season_number: 2, episode_number: 2, name: '2. Bölüm', air_date: new Date().toISOString().slice(0, 10) },
      }), { status: 200 });
    }
    if (u.includes('api.themoviedb.org/3/tv/1399?')) {
      return new Response(JSON.stringify({
        id: 1399, name: 'Game of Thrones', original_name: 'Game of Thrones', overview: 'Westeros', first_air_date: '2011-04-17', vote_average: 8.5, poster_path: '/p.jpg', backdrop_path: '/b.jpg', episode_run_time: [55],
        external_ids: { imdb_id: 'tt0944947' },
        seasons: [{ season_number: 0, episode_count: 10, name: 'Specials' }, { season_number: 1, episode_count: 10, name: 'Sezon 1' }],
      }), { status: 200 });
    }
    if (u.includes('api.themoviedb.org/3/tv/1399/season/0')) {
      return new Response(JSON.stringify({ episodes: [{ episode_number: 1, name: 'Special 1', overview: 'Behind the scenes', runtime: 30, air_date: '2011-04-10', still_path: '/s.jpg' }] }), { status: 200 });
    }
    if (u.includes('api.themoviedb.org/3/search/multi')) {
      if (u.includes('query=Matrix')) {
        return new Response(JSON.stringify({
          results: [{ id: 603, media_type: 'movie', title: 'The Matrix', original_title: 'The Matrix', overview: 'Simulation', poster_path: '/m.jpg', genre_ids: [28, 878], vote_average: 8.2, vote_count: 25000, release_date: '1999-03-31' }],
        }), { status: 200 });
      }
      if (u.includes('query=You')) {
        return new Response(JSON.stringify({
          results: [{ id: 78191, media_type: 'tv', name: 'You', original_name: 'You', overview: 'Obsession', poster_path: '/y.jpg', genre_ids: [18, 80], vote_average: 8.1, vote_count: 3500, first_air_date: '2018-09-09' }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (u.includes('api.themoviedb.org/3/discover/')) {
      seenDiscoverUrls.push(u);
      const isTv = u.includes('/discover/tv');
      const isNetflix = u.includes('with_watch_providers=8');
      const isDisney = u.includes('with_watch_providers=337');
      const items = isNetflix
        ? [{ id: 7001, [isTv ? 'name' : 'title']: 'Netflix Original', poster_path: '/nf.jpg', genre_ids: [18], vote_count: 500, original_language: 'en' }]
        : isDisney
          ? [{ id: 7002, [isTv ? 'name' : 'title']: 'Disney Original', poster_path: '/dp.jpg', genre_ids: [16], vote_count: 500, original_language: 'en' }]
          : [{ id: 7003, [isTv ? 'name' : 'title']: isTv ? 'Global TV' : 'Global Movie', poster_path: '/gl.jpg', genre_ids: [28], vote_count: 500, original_language: 'en' }];
      return new Response(JSON.stringify({ results: items, total_results: 100 }), { status: 200 });
    }
    if (u.includes('youtube.com/results') || u.includes('youtubei/v1/search')) {
      const mockYtHtml = 'var ytInitialData = {"contents":{"twoColumnSearchResultsRenderer":{"primaryContents":{"sectionListRenderer":{"contents":[{"itemSectionRenderer":{"contents":[{"videoRenderer":{"videoId":"dQw4w9WgXcQ","title":{"runs":[{"text":"Mock YT Result"}]},"ownerText":{"runs":[{"text":"YT Channel"}]}}}]}}]}}}}};</script>';
      return new Response(mockYtHtml, { status: 200 });
    }
    if (u.includes('youtubei/v1/player')) {
      return new Response(JSON.stringify({
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              { baseUrl: 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en', languageCode: 'en', name: { simpleText: 'English' } },
            ],
          },
        },
      }), { status: 200 });
    }
    return origFetch(input);
  };

  try {
    // 3. /api/rave/latest-episodes excludes 10767 talk show and cleans "2. Bölüm"
    const epResp = await (await handleAutonomousEdge(new Request('https://watchlivo.online/api/rave/latest-episodes?refresh=1'), new URL('https://watchlivo.online/api/rave/latest-episodes?refresh=1'), '/api/rave/latest-episodes', env)).json();
    assert.ok(!epResp.items.some((x) => x.title === 'Talk Show'), 'must exclude talk show genre 10767');
    const gercek = epResp.items.find((x) => x.tmdbId === '1002');
    assert.ok(gercek, 'must include Gerçek Dizi');
    assert.equal(gercek.episodeTitle, '', 'must strip generic "2. Bölüm"');
    assert.equal(gercek.streamReady, true);

    // 4. Bidirectional scifi + overview
    const scifiRes = await (await handleAutonomousEdge(new Request('https://watchlivo.online/api/rave/catalog?q=Matrix&category=scifi'), new URL('https://watchlivo.online/api/rave/catalog?q=Matrix&category=scifi'), '/api/rave/catalog', env)).json();
    assert.equal(scifiRes.items.length, 1);
    assert.equal(scifiRes.items[0].title, 'The Matrix');
    assert.equal(scifiRes.items[0].overview, 'Simulation');

    // 5. Symbol-only & meaningless 1-char return []
    const symRes = await (await handleAutonomousEdge(new Request('https://watchlivo.online/api/rave/catalog?q=%21%40%23%24'), new URL('https://watchlivo.online/api/rave/catalog?q=%21%40%23%24'), '/api/rave/catalog', env)).json();
    assert.equal(symRes.items.length, 0);
    const oneRes = await (await handleAutonomousEdge(new Request('https://watchlivo.online/api/rave/catalog?q=x'), new URL('https://watchlivo.online/api/rave/catalog?q=x'), '/api/rave/catalog', env)).json();
    assert.equal(oneRes.items.length, 0);

    // 6. Uniform ranking: "You" ranks You (2018) #1 ahead of "You Don't Mess with the Zohan"
    const youRes = await (await handleAutonomousEdge(new Request('https://watchlivo.online/api/rave/catalog?q=You'), new URL('https://watchlivo.online/api/rave/catalog?q=You'), '/api/rave/catalog', env)).json();
    assert.equal(youRes.items[0].tmdbId, '78191');

    // 7. OTT providers & dublaj/anime/all page 1
    const nfRes = await (await handleAutonomousEdge(new Request('https://watchlivo.online/api/rave/catalog?provider=netflix&page=1'), new URL('https://watchlivo.online/api/rave/catalog?provider=netflix&page=1'), '/api/rave/catalog', env)).json();
    assert.ok(nfRes.items.every((x) => x.id !== 'fhd-moana'), 'untagged bootstrap Moana must not bleed into Netflix');
    assert.ok(seenDiscoverUrls.some((u) => u.includes('with_watch_providers=8')));

    seenDiscoverUrls.length = 0;
    await handleAutonomousEdge(new Request('https://watchlivo.online/api/rave/catalog?category=dublaj&page=1'), new URL('https://watchlivo.online/api/rave/catalog?category=dublaj&page=1'), '/api/rave/catalog', env);
    assert.ok(!seenDiscoverUrls.some((u) => u.includes('with_original_language=tr')), 'dublaj must not force with_original_language=tr');

    seenDiscoverUrls.length = 0;
    await handleAutonomousEdge(new Request('https://watchlivo.online/api/rave/catalog?category=anime&page=1'), new URL('https://watchlivo.online/api/rave/catalog?category=anime&page=1'), '/api/rave/catalog', env);
    assert.ok(seenDiscoverUrls.some((u) => u.includes('/discover/movie') && u.includes('with_genres=16')), 'anime must include anime movies');

    // 8. supersearch populates youtube
    const ssRes = await (await handleAutonomousEdge(new Request('https://watchlivo.online/api/rave/supersearch?q=You'), new URL('https://watchlivo.online/api/rave/supersearch?q=You'), '/api/rave/supersearch', env)).json();
    assert.equal(ssRes.youtube.length, 1);
    assert.equal(ssRes.youtube[0].videoId, 'dQw4w9WgXcQ');

    // 9. /api/rave/seasons: season=0 sorted after Season 1, count+episodeCount, runtime, airDate, metadata, ac-* id
    const seaRes = await (await handleAutonomousEdge(new Request('https://watchlivo.online/api/rave/seasons?tmdbId=1399&season=0'), new URL('https://watchlivo.online/api/rave/seasons?tmdbId=1399&season=0'), '/api/rave/seasons', env)).json();
    assert.equal(seaRes.seasons[0].season, 1);
    assert.equal(seaRes.seasons[0].count, 10);
    assert.equal(seaRes.seasons[1].season, 0);
    assert.equal(seaRes.episodes[0].season, 0);
    assert.equal(seaRes.episodes[0].runtime, 30);
    assert.equal(seaRes.episodes[0].airDate, '2011-04-10');
    assert.equal(seaRes.imdbId, 'tt0944947');

    const acSea = await (await handleAutonomousEdge(new Request('https://watchlivo.online/api/rave/seasons?id=ac-13561&season=1'), new URL('https://watchlivo.online/api/rave/seasons?id=ac-13561&season=1'), '/api/rave/seasons', env)).json();
    assert.equal(acSea.seasons[0].season, 1);
    assert.equal(acSea.seasons[0].count, 12);
    assert.equal(acSea.episodes[0].runtime, 24);

    // 10. /api/rave/subtitles?videoId=... returns YouTube timedtext tracks (including >20-char YT URL in videoId)
    const ytSub = await (await handleAutonomousEdge(new Request('https://watchlivo.online/api/rave/subtitles?videoId=dQw4w9WgXcQ'), new URL('https://watchlivo.online/api/rave/subtitles?videoId=dQw4w9WgXcQ'), '/api/rave/subtitles', env)).json();
    assert.ok(ytSub.subtitleTracks.some((t) => t.source === 'youtube' && t.lang === 'en'));
    assert.ok(ytSub.subtitleTracks.some((t) => t.source === 'ai-tr' && t.lang === 'tr'));

    const longYtUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=share_extra_param';
    const ytSubLong = await (await handleAutonomousEdge(new Request(`https://watchlivo.online/api/rave/subtitles?videoId=${encodeURIComponent(longYtUrl)}`), new URL(`https://watchlivo.online/api/rave/subtitles?videoId=${encodeURIComponent(longYtUrl)}`), '/api/rave/subtitles', env)).json();
    assert.ok(ytSubLong.subtitleTracks.some((t) => t.source === 'youtube' && t.lang === 'en'));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('v239 M1 Iteration 2 regressions: multi-isolate soc:gclaim persistence & claim-guest guard, social/state 401 on invalid wl2, SVG %00/;v=1 block, anime Discover post-filter, latest-episodes lexicographic ranking, guest name collision & privacy sync', async () => {
  resetRoomDoQuotaGuardForTests();
  const d1Kv = new Map();
  const mockD1 = {
    prepare(sql) {
      const s = String(sql || '').trim();
      const exec = (params) => ({
        async run() {
          if (s.startsWith('INSERT INTO edge_kv')) {
            if (s.includes('VALUES (?, NULL, 0, 1)')) d1Kv.set(params[0], { v: null, exp: 0, deleted: 1 });
            else d1Kv.set(params[0], { v: params[1], exp: params[2], deleted: 0 });
          } else if (s.startsWith('DELETE FROM edge_kv')) {
            d1Kv.delete(params[0]);
          }
          return { success: true };
        },
        async first() {
          if (s.includes('FROM edge_kv WHERE k = ?')) return d1Kv.get(params[0]) || null;
          return null;
        },
      });
      return { bind(...p) { return exec(p); }, run() { return exec([]).run(); }, first() { return exec([]).first(); } };
    },
  };
  const rawStore = new Map();
  const rawKv = {
    async get(k, mode) {
      if (!rawStore.has(k)) return null;
      const v = rawStore.get(k);
      if (mode === 'json' || mode?.type === 'json') return typeof v === 'string' ? JSON.parse(v) : v;
      return typeof v === 'string' ? v : JSON.stringify(v);
    },
    async put(k, v) { rawStore.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
    async delete(k) { rawStore.delete(k); },
  };
  const sharedEnv = {
    WATCHLIVO_KV: rawKv,
    ROOMS_DB: mockD1,
    PROXY_SECRET: 'test_secret_key_for_v239_m1_iter2_regressions',
  };
  sharedEnv.ROOM_DO = createMockRoomDoNamespace(sharedEnv);

  // 1. Multi-isolate soc:gclaim persistence + claim-guest guard under ROOM_DO + ROOMS_DB
  const gBoot = await (await handleAutonomousEdge(
    new Request('https://watchlivo.online/api/rave/social/guest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'GuestVictim', handle: 'guestvictim' }),
    }),
    new URL('https://watchlivo.online/api/rave/social/guest'),
    '/api/rave/social/guest',
    sharedEnv,
  )).json();
  assert.equal(gBoot.ok, true);

  await handleAutonomousEdge(
    new Request('https://watchlivo.online/api/rave/social/presence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Guest-Token': gBoot.guestToken },
      body: JSON.stringify({ uid: gBoot.uid, state: 'watching', roomId: 'r9', watchMinutesDelta: 12 }),
    }),
    new URL('https://watchlivo.online/api/rave/social/presence'),
    '/api/rave/social/presence',
    sharedEnv,
  );

  const regAttacker = await (await handleAutonomousEdge(
    new Request('https://watchlivo.online/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alican@watchlivo.online', password: 'Password123!', name: 'Ali Can', handle: 'alican' }),
    }),
    new URL('https://watchlivo.online/api/auth/register'),
    '/api/auth/register',
    sharedEnv,
  )).json();
  assert.equal(regAttacker.ok, true);

  // Fresh isolate (separate _memEphemeralStore / _memPersistFallback) sharing ROOM_DO/ROOMS_DB/WATCHLIVO_KV
  const iso2 = await import(`../workers/ha-gateway/edge_autonomous.js?iso=${Date.now()}`);
  const envIso2 = {
    WATCHLIVO_KV: rawKv,
    ROOMS_DB: mockD1,
    ROOM_DO: sharedEnv.ROOM_DO,
    PROXY_SECRET: sharedEnv.PROXY_SECRET,
  };
  const hijackAttempt = await iso2.handleAutonomousEdge(
    new Request('https://watchlivo.online/api/rave/social/claim-guest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${regAttacker.authToken}` },
      body: JSON.stringify({ guestUid: gBoot.uid }),
    }),
    new URL('https://watchlivo.online/api/rave/social/claim-guest'),
    '/api/rave/social/claim-guest',
    envIso2,
  );
  assert.equal(hijackAttempt.status, 403, 'cross-isolate claim-guest without guestToken must return 403');

  // Even if soc:gclaim: is absent while soc:u:<guestUid> exists, claim-guest without guestToken must return 403
  const seededGuestUid = 'guest_seeded999';
  const doStub = sharedEnv.ROOM_DO.get(sharedEnv.ROOM_DO.idFromName('__watchlivo_auth_store_v1__'));
  const seedPut = await doStub.fetch(new Request('https://do.local/__kv', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'put', key: `soc:u:${seededGuestUid}`, value: JSON.stringify({ uid: seededGuestUid, name: 'Seeded', watchMinutes: 20 }), ttl: 86400 }),
  }));
  assert.equal(seedPut.status, 200);
  const seededHijack = await iso2.handleAutonomousEdge(
    new Request('https://watchlivo.online/api/rave/social/claim-guest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${regAttacker.authToken}` },
      body: JSON.stringify({ guestUid: seededGuestUid }),
    }),
    new URL('https://watchlivo.online/api/rave/social/claim-guest'),
    '/api/rave/social/claim-guest',
    envIso2,
  );
  assert.equal(seededHijack.status, 403, 'claim-guest on existing soc:u record without guestToken must return 403');

  // 2. Guest boot without b.handle when b.name ("Ali Can") matches registered handle ("alican") must auto-suffix and not overwrite soc:handle:alican
  const gNameCollide = await (await iso2.handleAutonomousEdge(
    new Request('https://watchlivo.online/api/rave/social/guest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ali Can' }),
    }),
    new URL('https://watchlivo.online/api/rave/social/guest'),
    '/api/rave/social/guest',
    envIso2,
  )).json();
  assert.equal(gNameCollide.ok, true);
  assert.notEqual(gNameCollide.handle, 'alican');
  assert.ok(gNameCollide.handle.startsWith('alican_'));

  // 3. sanitizeAvatarUrl rejects .svg%00.png and .svg;v=1, accepts /svg/pic.png, and syncs hideFriends/hideLocation
  for (const bypassUrl of [
    'https://evil.com/x.svg%00.png',
    'https://evil.com/x.svg;v=1',
    'https://evil.com/x.svg%3Bv=1',
  ]) {
    const rAv = await handleAutonomousEdge(
      new Request('https://watchlivo.online/api/auth/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${regAttacker.authToken}` },
        body: JSON.stringify({ avatarUrl: bypassUrl }),
      }),
      new URL('https://watchlivo.online/api/auth/profile'),
      '/api/auth/profile',
      sharedEnv,
    );
    assert.equal(rAv.status, 400, `must reject SVG bypass avatar: ${bypassUrl}`);
  }
  const rOkAv = await handleAutonomousEdge(
    new Request('https://watchlivo.online/api/auth/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${regAttacker.authToken}` },
      body: JSON.stringify({ avatarUrl: 'https://cdn.example.com/svg/pic.png', hideFriends: true, hideLocation: true }),
    }),
    new URL('https://watchlivo.online/api/auth/profile'),
    '/api/auth/profile',
    sharedEnv,
  );
  assert.equal(rOkAv.status, 200);

  const stateOk = await handleAutonomousEdge(
    new Request('https://watchlivo.online/api/rave/social/state', { headers: { Authorization: `Bearer ${regAttacker.authToken}` } }),
    new URL('https://watchlivo.online/api/rave/social/state'),
    '/api/rave/social/state',
    sharedEnv,
  );
  assert.equal(stateOk.status, 200);
  const stateJson = await stateOk.json();
  assert.equal(stateJson.privacy.hideFriends, true);
  assert.equal(stateJson.privacy.hideLocation, true);

  // 4. /api/rave/social/state returns 401 when wl2. account is deleted/tombstoned (and 200 when unauthenticated guest calls without token)
  const delAcc = await handleAutonomousEdge(
    new Request('https://watchlivo.online/api/auth/account', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${regAttacker.authToken}` },
      body: JSON.stringify({ password: 'Password123!' }),
    }),
    new URL('https://watchlivo.online/api/auth/account'),
    '/api/auth/account',
    sharedEnv,
  );
  assert.equal(delAcc.status, 200);

  const stateTomb = await handleAutonomousEdge(
    new Request('https://watchlivo.online/api/rave/social/state', { headers: { Authorization: `Bearer ${regAttacker.authToken}` } }),
    new URL('https://watchlivo.online/api/rave/social/state'),
    '/api/rave/social/state',
    sharedEnv,
  );
  assert.equal(stateTomb.status, 401, 'tombstoned wl2 token on /api/rave/social/state must fail closed with 401');

  const stateGuest = await handleAutonomousEdge(
    new Request('https://watchlivo.online/api/rave/social/state?uid=guest_anon123'),
    new URL('https://watchlivo.online/api/rave/social/state?uid=guest_anon123'),
    '/api/rave/social/state',
    sharedEnv,
  );
  assert.equal(stateGuest.status, 200);
  assert.equal((await stateGuest.json()).uid, 'guest_anon123');

  // 5. Anime Discover post-filter excludes live-action ja movie without genre 16 & latest-episodes ranks lexicographically
  const bootCat = JSON.stringify({
    version: '20261124_v239',
    catalog: [
      { id: 'fhd-7010', tmdbId: '7010', mediaType: 'tv', title: 'Playable Show', originalTitle: 'Playable Show', year: '2026', categories: ['series'] },
    ],
    curatedRooms: [],
    newReleases: [],
    latestEpisodes: [],
  });
  const catEnv = {
    WATCHLIVO_KV: rawKv,
    PROXY_SECRET: sharedEnv.PROXY_SECRET,
    ASSETS: {
      async fetch(req) {
        if (new URL(typeof req === 'string' ? req : req.url).pathname === '/_edge/bootstrap.json') {
          return new Response(bootCat, { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response('Not Found', { status: 404 });
      },
    },
  };
  const origFetch = globalThis.fetch;
  const todayStr = new Date().toISOString().slice(0, 10);
  globalThis.fetch = async (input) => {
    const u = String(typeof input === 'string' ? input : input?.url || '');
    if (u.includes('sinemacc.com')) return new Response('', { status: 503 });
    if (u.includes('animecix.tv/secure/last-episodes')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    if (u.includes('api.themoviedb.org/3/discover/movie')) {
      return new Response(JSON.stringify({
        results: [
          { id: 10002, title: 'Anime Film', original_title: 'Anime Film', poster_path: '/a.jpg', genre_ids: [16, 18], original_language: 'ja', vote_count: 100, release_date: '2024-01-01' },
          { id: 10003, title: 'Live Action JA', original_title: 'Live Action JA', poster_path: '/l.jpg', genre_ids: [18, 80], original_language: 'ja', vote_count: 200, release_date: '2024-01-01' },
        ],
        total_results: 2,
      }), { status: 200 });
    }
    if (u.includes('api.themoviedb.org/3/discover/tv')) {
      return new Response(JSON.stringify({ results: [], total_results: 0 }), { status: 200 });
    }
    if (u.includes('api.themoviedb.org/3/tv/on_the_air')) {
      return new Response(JSON.stringify({
        results: [
          { id: 7006, name: 'NonPlayable Mega Popular', poster_path: '/np.jpg', vote_count: 300, popularity: 900, genre_ids: [18], original_language: 'en' },
          { id: 7010, name: 'Playable Show', poster_path: '/pl.jpg', vote_count: 50, popularity: 10, genre_ids: [18], original_language: 'en' },
        ],
      }), { status: 200 });
    }
    if (u.includes('api.themoviedb.org/3/tv/7006?')) {
      return new Response(JSON.stringify({
        id: 7006, name: 'NonPlayable Mega Popular', original_name: 'NonPlayable Mega Popular', original_language: 'en', poster_path: '/np.jpg', vote_average: 7.5, genres: [{ id: 18 }],
        last_episode_to_air: { season_number: 1, episode_number: 3, name: 'Ep 3', air_date: todayStr },
      }), { status: 200 });
    }
    if (u.includes('api.themoviedb.org/3/tv/7010?')) {
      return new Response(JSON.stringify({
        id: 7010, name: 'Playable Show', original_name: 'Playable Show', original_language: 'en', poster_path: '/pl.jpg', vote_average: 8.2, genres: [{ id: 18 }],
        last_episode_to_air: { season_number: 1, episode_number: 2, name: 'Pilot', air_date: todayStr },
      }), { status: 200 });
    }
    return origFetch(input);
  };
  try {
    const iso3 = await import(`../workers/ha-gateway/edge_autonomous.js?iso3=${Date.now()}`);
    const animeRes = await (await iso3.handleAutonomousEdge(
      new Request('https://watchlivo.online/api/rave/catalog?category=anime&page=1'),
      new URL('https://watchlivo.online/api/rave/catalog?category=anime&page=1'),
      '/api/rave/catalog',
      catEnv,
    )).json();
    assert.ok(animeRes.items.some((x) => x.tmdbId === '10002'), 'anime movie with genre 16 must be included');
    assert.ok(!animeRes.items.some((x) => x.tmdbId === '10003'), 'live-action ja movie without genre 16 must be excluded from anime Discover');

    const latestRes = await (await iso3.handleAutonomousEdge(
      new Request('https://watchlivo.online/api/rave/latest-episodes?refresh=1'),
      new URL('https://watchlivo.online/api/rave/latest-episodes?refresh=1'),
      '/api/rave/latest-episodes',
      catEnv,
    )).json();
    const idxPlayable = latestRes.items.findIndex((x) => x.tmdbId === '7010');
    const idxNonPlayable = latestRes.items.findIndex((x) => x.tmdbId === '7006');
    assert.ok(idxPlayable >= 0 && idxNonPlayable >= 0, 'both series must be present');
    assert.ok(idxPlayable < idxNonPlayable, `catalog-playable 7010 (pop=10) must outrank non-playable 7006 (pop=900); got ${idxPlayable} vs ${idxNonPlayable}`);
  } finally {
    globalThis.fetch = origFetch;
  }
});
