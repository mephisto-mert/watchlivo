import test from "node:test";
import assert from "node:assert/strict";
import {
  WatchlivoRoomDO,
  handleEdgeRoomCreate,
  handleEdgeRoomSync,
  handleEdgeRoomVoiceRelay,
} from "../workers/ha-gateway/edge_rooms.js";

function makeMemEnv() {
  const kvStore = new Map();
  const doInstances = new Map();
  const env = {
    ROOM_TOKEN_SECRET: "test_secret_watchlivo_v224_rooms",
    WATCHLIVO_KV: {
      async get(k, type) {
        const v = kvStore.get(k);
        if (v === undefined) return null;
        return type === "json" ? JSON.parse(v) : v;
      },
      async put(k, v) { kvStore.set(k, String(v)); },
      async delete(k) { kvStore.delete(k); },
    },
    ROOM_DO: {
      idFromName(name) { return name; },
      get(id) {
        if (!doInstances.has(id)) {
          const storageMap = new Map();
          const state = {
            storage: {
              async get(k) { return storageMap.has(k) ? structuredClone(storageMap.get(k)) : undefined; },
              async put(k, v) { storageMap.set(k, structuredClone(v)); },
              async delete(k) { storageMap.delete(k); },
            },
          };
          const inst = new WatchlivoRoomDO(state, env);
          doInstances.set(id, {
            fetch(input, init) {
              const req = input instanceof Request ? input : new Request(String(input), init);
              return inst.fetch(req);
            },
          });
        }
        return doInstances.get(id);
      },
    },
  };
  return env;
}

const jsonResp = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

async function syncPost(env, roomId, body) {
  const req = new Request(`https://watchlivo.online/api/rooms/${roomId}/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await handleEdgeRoomSync(roomId, req, env, jsonResp);
  return { status: res.status, data: await res.json() };
}

test("room voice/camera/screen/inCall state persists across polls, chat, and heartbeats", async () => {
  const env = makeMemEnv();
  const createRes = await handleEdgeRoomCreate(
    new Request("https://watchlivo.online/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test Odası", username: "HostAli", clientId: "h_host01" }),
    }),
    env,
    jsonResp
  );
  const created = await createRes.json();
  assert.equal(created.ok, true);
  const roomId = created.room.id;
  const hostCid = created.clientId;
  const hostTok = created.clientToken;

  // Peer 2 joins
  const p2Init = await syncPost(env, roomId, { type: "init", clientId: "h_peer02", username: "Veli" });
  const p2Cid = p2Init.data.clientId;
  const p2Tok = p2Init.data.clientToken;

  // Host enables camera + mic + screen + inCall
  const vs1 = await syncPost(env, roomId, {
    type: "voice_state",
    clientId: hostCid,
    clientToken: hostTok,
    username: "HostAli",
    inCall: true,
    muted: false,
    speaking: true,
    cam: true,
    screen: true,
    deafened: false,
  });
  assert.equal(vs1.status, 200);
  let hostP = vs1.data.room.participants.find((p) => p.id === hostCid);
  assert.equal(hostP.cam, true);
  assert.equal(hostP.screen, true);
  assert.equal(hostP.muted, false);
  assert.equal(hostP.inCall, true);
  assert.equal(hostP.speaking, true);

  // Subsequent poll WITHOUT cam/screen/inCall/speaking MUST NOT wipe voice/camera state!
  const poll1 = await syncPost(env, roomId, { type: "poll", clientId: hostCid, clientToken: hostTok, username: "HostAli" });
  hostP = poll1.data.room.participants.find((p) => p.id === hostCid);
  assert.equal(hostP.cam, true, "poll must preserve cam=true");
  assert.equal(hostP.screen, true, "poll must preserve screen=true");
  assert.equal(hostP.muted, false, "poll must preserve muted=false");
  assert.equal(hostP.inCall, true, "poll must preserve inCall=true");
  assert.equal(hostP.speaking, true, "poll must preserve speaking=true");

  // Chat message & heartbeat also MUST preserve cam/screen/mic/inCall
  await syncPost(env, roomId, { type: "chat", clientId: hostCid, clientToken: hostTok, username: "HostAli", text: "Selam!" });
  const hb = await syncPost(env, roomId, { type: "heartbeat", clientId: hostCid, clientToken: hostTok, username: "HostAli", currentTime: 42 });
  hostP = hb.data.room.participants.find((p) => p.id === hostCid);
  assert.equal(hostP.cam, true);
  assert.equal(hostP.screen, true);
  assert.equal(hostP.inCall, true);

  // Peer 2 sees HostAli's active voice/cam/screen state
  const p2Poll = await syncPost(env, roomId, { type: "poll", clientId: p2Cid, clientToken: p2Tok, username: "Veli" });
  const hostSeenByP2 = p2Poll.data.room.participants.find((p) => p.id === hostCid);
  assert.equal(hostSeenByP2.cam, true);
  assert.equal(hostSeenByP2.screen, true);
  assert.equal(hostSeenByP2.inCall, true);
  assert.equal(hostSeenByP2.muted, false);
});

test("rich chat (gif, snapshot, audioNote, replyTo), msg_react, live polls, and clear_chat work end-to-end", async () => {
  const env = makeMemEnv();
  const created = await (await handleEdgeRoomCreate(
    new Request("https://watchlivo.online/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Chat Odası", username: "HostAli", clientId: "h_host01" }),
    }),
    env,
    jsonResp
  )).json();
  const roomId = created.room.id;
  const hostCid = created.clientId;
  const hostTok = created.clientToken;

  // 1. GIF with empty text
  const gifRes = await syncPost(env, roomId, {
    type: "chat",
    clientId: hostCid,
    clientToken: hostTok,
    username: "HostAli",
    text: "",
    gif: "https://media.giphy.com/media/abc123/giphy.gif",
  });
  assert.equal(gifRes.data.room.chat.length, 1);
  assert.equal(gifRes.data.room.chat[0].gif, "https://media.giphy.com/media/abc123/giphy.gif");

  // 2. Voice note with empty text
  const vnRes = await syncPost(env, roomId, {
    type: "chat",
    clientId: hostCid,
    clientToken: hostTok,
    username: "HostAli",
    text: "",
    audioNote: { url: "/api/rave/voice-note/vn_12345678", mime: "audio/webm", duration: 3.4, peaks: [0.2, 0.8] },
  });
  assert.equal(vnRes.data.room.chat.length, 2);
  assert.equal(vnRes.data.room.chat[1].audioNote.url, "/api/rave/voice-note/vn_12345678");

  // 3. Snapshot + replyTo + videoTime
  const snapRes = await syncPost(env, roomId, {
    type: "chat",
    clientId: hostCid,
    clientToken: hostTok,
    username: "HostAli",
    text: "Bu sahne efsane",
    snapshot: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/",
    videoTime: 125,
    replyTo: { id: gifRes.data.room.chat[0].id, user: "HostAli", text: "GIF Gönderdi", color: "#27DCC8" },
  });
  assert.equal(snapRes.data.room.chat.length, 3);
  assert.equal(snapRes.data.room.chat[2].videoTime, 125);
  assert.equal(snapRes.data.room.chat[2].replyTo.id, gifRes.data.room.chat[0].id);

  // 4. msg_react emits msg_reacted with Name#tail
  const msgId = snapRes.data.room.chat[2].id;
  const reactRes = await syncPost(env, roomId, {
    type: "msg_react",
    clientId: hostCid,
    clientToken: hostTok,
    username: "HostAli",
    msgId,
    emoji: "🔥",
  });
  const reactEv = reactRes.data.room.events.find((e) => e.type === "msg_reacted");
  assert.ok(reactEv, "msg_reacted event must be emitted");
  assert.deepEqual(reactEv.reactions["🔥"], [`HostAli#${hostCid.slice(-4)}`]);

  // 5. Live Poll create & vote
  const pollCreateRes = await syncPost(env, roomId, {
    type: "poll_create",
    clientId: hostCid,
    clientToken: hostTok,
    username: "HostAli",
    question: "Ne izleyelim?",
    options: ["Gassal", "Interstellar"],
  });
  assert.equal(pollCreateRes.data.room.polls.length, 1);
  const pollId = pollCreateRes.data.room.polls[0].id;
  assert.ok(pollCreateRes.data.room.chat.some((m) => m.pollId === pollId), "poll must create chat card message");

  const pollVoteRes = await syncPost(env, roomId, {
    type: "poll_vote",
    clientId: hostCid,
    clientToken: hostTok,
    username: "HostAli",
    pollId,
    optionIndex: 0,
  });
  assert.equal(pollVoteRes.data.room.polls[0].options[0].votes.length, 1);
  assert.ok(pollVoteRes.data.room.events.some((e) => e.type === "poll_updated"));

  // 6. clear_chat clears both chat and polls and emits chat_cleared
  const clearRes = await syncPost(env, roomId, {
    type: "clear_chat",
    clientId: hostCid,
    clientToken: hostTok,
    username: "HostAli",
  });
  assert.equal(clearRes.data.room.chat.length, 0);
  assert.equal(clearRes.data.room.polls.length, 0);
  assert.ok(clearRes.data.room.events.some((e) => e.type === "chat_cleared"));
});

test("queue, voting, skip_votes, break_request, stage mode, hand_raise, WebRTC 60-signal buffer, and DO voice-relay", async () => {
  const env = makeMemEnv();
  const created = await (await handleEdgeRoomCreate(
    new Request("https://watchlivo.online/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Sahne Odası", username: "HostAli", clientId: "h_host01" }),
    }),
    env,
    jsonResp
  )).json();
  const roomId = created.room.id;
  const hostCid = created.clientId;
  const hostTok = created.clientToken;

  const p2 = (await syncPost(env, roomId, { type: "init", clientId: "h_peer02", username: "Veli" })).data;
  const p2Cid = p2.clientId;
  const p2Tok = p2.clientToken;

  // Queue add + vote + play
  const q1 = await syncPost(env, roomId, {
    type: "queue_add",
    clientId: p2Cid,
    clientToken: p2Tok,
    username: "Veli",
    item: { title: "Film A", url: "https://example.com/a.m3u8", provider: "hls" },
  });
  assert.equal(q1.data.room.queue.length, 1);
  const qItemId = q1.data.room.queue[0].id;

  const qVote = await syncPost(env, roomId, {
    type: "vote_video",
    clientId: p2Cid,
    clientToken: p2Tok,
    username: "Veli",
    index: 0,
    id: qItemId,
  });
  assert.deepEqual(qVote.data.room.queue[0].votes, [p2Cid]);

  const qPlay = await syncPost(env, roomId, {
    type: "queue_play_index",
    clientId: hostCid,
    clientToken: hostTok,
    username: "HostAli",
    index: 0,
    id: qItemId,
  });
  assert.equal(qPlay.data.room.queue.length, 0);
  assert.equal(qPlay.data.room.media.title, "Film A");

  // Break request from peer 2
  const brk = await syncPost(env, roomId, {
    type: "break_request",
    clientId: p2Cid,
    clientToken: p2Tok,
    username: "Veli",
    actionId: "brk_test_1",
    videoTime: 77,
  });
  const brkEv = brk.data.room.events.find((e) => e.type === "break_request" && e.id === "brk_test_1");
  assert.ok(brkEv);
  assert.equal(brkEv.user, "Veli");

  // Stage mode toggle -> peer 2 raises hand -> host grants stage speaker -> peer 2 can unmute
  const stgOn = await syncPost(env, roomId, {
    type: "host_action",
    action: "toggle_stage_mode",
    clientId: hostCid,
    clientToken: hostTok,
    username: "HostAli",
  });
  assert.equal(stgOn.data.room.voipMode, "stage");

  // Peer 2 tries to unmute before stage grant -> server blocks muted=true
  const p2TryUnmute = await syncPost(env, roomId, {
    type: "voice_state",
    clientId: p2Cid,
    clientToken: p2Tok,
    username: "Veli",
    muted: false,
    cam: true,
    inCall: true,
  });
  const p2Blocked = p2TryUnmute.data.room.participants.find((p) => p.id === p2Cid);
  assert.equal(p2Blocked.muted, true);
  assert.equal(p2Blocked.cam, false);

  // Peer 2 raises hand
  const hr = await syncPost(env, roomId, {
    type: "hand_raise",
    clientId: p2Cid,
    clientToken: p2Tok,
    username: "Veli",
    raised: true,
  });
  assert.equal(hr.data.room.participants.find((p) => p.id === p2Cid).handRaised, true);
  assert.ok(hr.data.room.events.some((e) => e.type === "hand_raised" && e.user === "Veli"));

  // Host grants stage speaker
  const grant = await syncPost(env, roomId, {
    type: "host_action",
    action: "toggle_stage_speaker",
    targetId: p2Cid,
    clientId: hostCid,
    clientToken: hostTok,
    username: "HostAli",
  });
  const p2Granted = grant.data.room.participants.find((p) => p.id === p2Cid);
  assert.equal(p2Granted.isStageSpeaker, true);
  assert.equal(p2Granted.handRaised, false);

  // Now peer 2 CAN unmute and open camera!
  const p2NowSpeak = await syncPost(env, roomId, {
    type: "voice_state",
    clientId: p2Cid,
    clientToken: p2Tok,
    username: "Veli",
    muted: false,
    cam: true,
    inCall: true,
  });
  assert.equal(p2NowSpeak.data.room.participants.find((p) => p.id === p2Cid).muted, false);
  assert.equal(p2NowSpeak.data.room.participants.find((p) => p.id === p2Cid).cam, true);

  // Host sets playMode=autoplay and voipMode=all
  const privRes = await syncPost(env, roomId, {
    type: "host_action",
    action: "set_privacy",
    playMode: "autoplay",
    voipMode: "all",
    clientId: hostCid,
    clientToken: hostTok,
    username: "HostAli",
  });
  assert.equal(privRes.data.room.playMode, "autoplay");
  assert.equal(privRes.data.room.voipMode, "all");

  // WebRTC signaling buffer: send 1 offer + 55 ICE candidates -> offer MUST still be retained!
  await syncPost(env, roomId, {
    type: "webrtc_offer",
    signalId: "sg_offer_keep",
    clientId: hostCid,
    clientToken: hostTok,
    targetId: p2Cid,
    sdp: { type: "offer", sdp: "v=0" },
  });
  const iceItems = Array.from({ length: 55 }, (_, i) => ({
    type: "webrtc_ice",
    signalId: `sg_ice_${i}`,
    targetId: p2Cid,
    candidate: { candidate: `cand-${i}` },
  }));
  await syncPost(env, roomId, { type: "batch", clientId: hostCid, clientToken: hostTok, items: iceItems });
  const p2SigPoll = await syncPost(env, roomId, { type: "poll", clientId: p2Cid, clientToken: p2Tok, username: "Veli" });
  assert.ok(p2SigPoll.data.room.signals.some((s) => s.id === "sg_offer_keep"), "WebRTC offer must not be evicted by 55 ICE candidates");
  assert.equal(p2SigPoll.data.room.signals.length, 56);

  // DO Voice Relay round-trip
  const vrPost = await handleEdgeRoomVoiceRelay(
    roomId,
    new Request(`https://watchlivo.online/api/rave/voice-relay/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: hostCid, clientToken: hostTok, seq: 1, mime: "audio/wav", b64: "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=" }),
    }),
    env,
    jsonResp
  );
  assert.equal(vrPost.status, 200);
  const vrGet = await handleEdgeRoomVoiceRelay(
    roomId,
    new Request(`https://watchlivo.online/api/rave/voice-relay/${roomId}?clientId=${p2Cid}&clientToken=${encodeURIComponent(p2Tok)}&sinceTs=0`, { method: "GET" }),
    env,
    jsonResp
  );
  assert.equal(vrGet.status, 200);
  const vrData = await vrGet.json();
  assert.equal(vrData.packets.length, 1);
  assert.equal(vrData.packets[0].fromId, hostCid);
});

function createFakeWsPairClass() {
  return class FakeWebSocketPair {
    constructor() {
      const makeEnd = () => {
        const listeners = new Map();
        return {
          accepted: false,
          closed: false,
          closeCode: 0,
          closeReason: "",
          peer: null,
          accept() { this.accepted = true; },
          addEventListener(ev, fn) {
            if (!listeners.has(ev)) listeners.set(ev, new Set());
            listeners.get(ev).add(fn);
          },
          _emit(ev, payload) {
            for (const fn of listeners.get(ev) || []) fn(payload);
          },
          send(data) {
            if (this.closed || !this.peer || this.peer.closed) return;
            this.peer._emit("message", { data });
          },
          close(code = 1000, reason = "") {
            if (this.closed) return;
            this.closed = true;
            this.closeCode = code;
            this.closeReason = reason;
            this._emit("close", { code, reason });
          },
        };
      };
      const client = makeEnd();
      const server = makeEnd();
      client.peer = server;
      server.peer = client;
      this[0] = client;
      this[1] = server;
    }
  };
}

test("v225 audit fixes: friends privacy, customName rename, voteEndsAt countdown, WS kick eject, transferred WS close_room, scoped attachRoom", async () => {
  const origWsPair = globalThis.WebSocketPair;
  const OrigResponse = globalThis.Response;
  globalThis.WebSocketPair = createFakeWsPairClass();
  globalThis.Response = class extends OrigResponse {
    constructor(body, init) {
      if (init && init.status === 101 && init.webSocket) {
        return { status: 101, ok: true, webSocket: init.webSocket, headers: new Headers(init.headers || {}) };
      }
      super(body, init);
    }
  };
  try {
    const env = makeMemEnv();
    // 1. friends privacy preserved on create
    const cr = await (await handleEdgeRoomCreate(
      new Request("https://watchlivo.online/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Arkadas Sinema", username: "HostA", clientId: "h_hostA", privacy: "friends" }),
      }),
      env,
      jsonResp
    )).json();
    assert.equal(cr.room.privacy, "friends", "friends privacy must not downgrade to public");
    const roomId = cr.room.id;
    const hostCid = cr.clientId;
    const hostTok = cr.clientToken;

    // 2. Rename sets customName=true, whitespace-only password clears password cleanly
    const ren = await syncPost(env, roomId, {
      type: "host_action",
      action: "set_privacy",
      name: "Özel Film Gecesi",
      password: "   ",
      playMode: "vote",
      clientId: hostCid,
      clientToken: hostTok,
    });
    assert.equal(ren.data.room.name, "Özel Film Gecesi");
    assert.equal(ren.data.room.customName, true);
    assert.equal(ren.data.room.hasPassword, false, "whitespace-only password must not set password");
    assert.equal(ren.data.room.playMode, "vote");

    // 3. vote playMode video_ended triggers 8-second voteEndsAt countdown
    await syncPost(env, roomId, {
      type: "queue_add",
      clientId: hostCid,
      clientToken: hostTok,
      item: { title: "Aday Film 1", url: "https://example.com/1.m3u8", provider: "hls" },
    });
    const endedRes = await syncPost(env, roomId, {
      type: "video_ended",
      clientId: hostCid,
      clientToken: hostTok,
    });
    assert.ok(endedRes.data.room.voteEndsAt > Date.now() / 1000, "vote mode video_ended must set voteEndsAt countdown");
    assert.ok(endedRes.data.room.events.some((e) => e.type === "vote_updated"));

    // 4. WS connections: host + guest1 (no pre-existing token) + guest2 (to be kicked)
    const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(roomId));
    const wsHostRes = await stub.fetch(`https://do.local/ws?roomId=${roomId}&clientId=${hostCid}&clientToken=${encodeURIComponent(hostTok)}&username=HostA`, { headers: { Upgrade: "websocket" } });
    const wsGuest1Res = await stub.fetch(`https://do.local/ws?roomId=${roomId}&clientId=h_guest1&username=Guest1`, { headers: { Upgrade: "websocket" } });
    const wsGuest2Res = await stub.fetch(`https://do.local/ws?roomId=${roomId}&clientId=h_guest2&username=Guest2`, { headers: { Upgrade: "websocket" } });
    const hostSock = wsHostRes.webSocket;
    const g1Sock = wsGuest1Res.webSocket;
    const g2Sock = wsGuest2Res.webSocket;

    const hostInbox = [];
    const g1Inbox = [];
    const g2Inbox = [];
    hostSock.addEventListener("message", (e) => hostInbox.push(JSON.parse(e.data)));
    g1Sock.addEventListener("message", (e) => g1Inbox.push(JSON.parse(e.data)));
    g2Sock.addEventListener("message", (e) => g2Inbox.push(JSON.parse(e.data)));

    // Promote guest2 to co-host then kick guest2 -> guest2 receives kicked + socket closes + cannot re-insert!
    hostSock.send(JSON.stringify({ type: "host_action", action: "promote", targetId: "h_guest2" }));
    await new Promise((r) => setTimeout(r, 15));
    // Verify attachRoom broadcast kept hostSock's viewer-scoped isHost=true!
    const hostPromoteEvt = hostInbox.find((m) => m.type === "host_action" && m.subAction === "promote");
    assert.equal(hostPromoteEvt?.room?.isHost, true, "attachRoom WS broadcast must preserve viewer-scoped isHost for host");

    hostSock.send(JSON.stringify({ type: "host_action", action: "kick", targetId: "h_guest2" }));
    await new Promise((r) => setTimeout(r, 15));
    assert.ok(g2Inbox.some((m) => m.type === "kicked"), "kicked WS user must receive kicked event");
    // Attempt to send message on kicked socket -> must NOT re-add to participants
    g2Sock.send(JSON.stringify({ type: "chat", text: "I should be blocked" }));
    await new Promise((r) => setTimeout(r, 15));
    const afterKickPoll = await syncPost(env, roomId, { type: "poll", clientId: hostCid, clientToken: hostTok });
    assert.ok(!afterKickPoll.data.room.participants.some((p) => p.id === "h_guest2"), "kicked user must stay ejected");

    // 5. Transfer host to guest1 (who joined WS without pre-existing token) -> guest1 CAN close_room over WS!
    hostSock.send(JSON.stringify({ type: "host_action", action: "transfer_host", targetId: "h_guest1" }));
    await new Promise((r) => setTimeout(r, 15));
    const g1TransferEvt = g1Inbox.find((m) => m.type === "host_action" && m.subAction === "transfer_host");
    assert.equal(g1TransferEvt?.room?.isHost, true, "new host must see isHost=true on transfer_host broadcast");

    g1Sock.send(JSON.stringify({ type: "close_room" }));
    await new Promise((r) => setTimeout(r, 20));
    const afterClose = await syncPost(env, roomId, { type: "poll", clientId: hostCid, clientToken: hostTok });
    assert.equal(afterClose.status, 410, "transferred WS host must be able to close_room cleanly");
  } finally {
    if (origWsPair === undefined) delete globalThis.WebSocketPair;
    else globalThis.WebSocketPair = origWsPair;
    globalThis.Response = OrigResponse;
  }
});
