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
