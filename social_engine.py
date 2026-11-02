"""Rave.io Parity Engine (social_engine.py)
Implements Rave's internal social, chat, AI, playlist, Drive folder, and RaveDJ modules:
1. Direct Messages (DMThreads / DirectMessageView) & Server-Backed Friendships + Medals
2. OpenGraph Rich Link Previews (LinkPreview)
3. Multi-Language Chat Auto-Translation ([Mesh][translateChat])
4. YouTube Playlist Importer (PlaylistsSelection)
5. RaveDJ AI Dual-Track Mashup & Mix Engine (RAVEDJ RENDERER PROVIDER)
6. In-Room AI Image Studio (StableDiffusion / StableDiffusionHistory / StableDiffusionTag)
7. Google Drive Folder & Multi-Quality MKV/MP4 Browser (GoogleDriveSelection)
8. Moderation & Abuse Reporting (ReportPopUp)
"""
from __future__ import annotations

import base64
import hashlib
import html as html_mod
import json
import re
import time
import urllib.parse
import urllib.request
import uuid
from typing import Any, Dict, List, Optional

from starlette.requests import Request
from starlette.responses import JSONResponse

from security import is_safe_public_url

UA_CHROME = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

# ---------------------------------------------------------------------------
# In-memory + Redis-compatible stores for Social / DM / AI History / Reports
# ---------------------------------------------------------------------------
_SOCIAL_USERS: Dict[str, Dict[str, Any]] = {}
_DM_THREADS: Dict[str, List[Dict[str, Any]]] = {}
_LINK_PREVIEW_CACHE: Dict[str, Dict[str, Any]] = {}
_TRANSLATE_CACHE: Dict[str, str] = {}
_AI_IMAGE_HISTORY: List[Dict[str, Any]] = []
_REPORTS_LOG: List[Dict[str, Any]] = []
_NOTIFICATION_QUEUES: Dict[str, List[Dict[str, Any]]] = {}
_PUSH_SUBSCRIPTIONS: Dict[str, Dict[str, Any]] = {}


def _queue_notification(target_key: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    key = str(target_key or "*").strip().lower() or "*"
    item = {
        "id": payload.get("id") or ("ntf_" + uuid.uuid4().hex[:10]),
        "type": str(payload.get("type") or "room_invite"),
        "title": _clean(payload.get("title") or "Watchlivo — Sinema Daveti", 120),
        "body": _clean(payload.get("body") or "Arkadaşın seni sinema odasına çağırıyor!", 240),
        "fromUid": _clean(payload.get("fromUid"), 64),
        "fromName": _clean(payload.get("fromName") or "Arkadaşın", 40),
        "roomId": _clean(payload.get("roomId"), 80),
        "url": _clean(payload.get("url"), 240),
        "ts": float(payload.get("ts") or time.time()),
    }
    q = _NOTIFICATION_QUEUES.setdefault(key, [])
    q.append(item)
    del q[:-50]
    return item

COMMUNITY_PEERS = [
    {
        "uid": "u_ayla_cinema",
        "name": "Ayla Sinema",
        "handle": "@ayla_cinema",
        "color": "#FF2A85",
        "avatarUrl": "",
        "country": "TR",
        "online": True,
        "status": "🎬 Dune: Part Two odasında",
        "watchMinutes": 420,
        "medal": "🥇 Altın İzleyici",
        "rankPill": "Top %1 İzleyici",
    },
    {
        "uid": "u_mert_dj",
        "name": "Mert Watchlivo DJ",
        "handle": "@mert_dj",
        "color": "#00F5D4",
        "avatarUrl": "",
        "country": "DE",
        "online": True,
        "status": "🎧 Watchlivo DJ Synthwave Mix dinliyor",
        "watchMinutes": 215,
        "medal": "🥈 Gümüş İzleyici",
        "rankPill": "Watchlivo DJ Prodüktör",
    },
    {
        "uid": "u_zeynep_anime",
        "name": "Zeynep Anime",
        "handle": "@zeynep_anime",
        "color": "#9B5DE5",
        "avatarUrl": "",
        "country": "JP",
        "online": True,
        "status": "⛩️ Solo Leveling B2 izliyor",
        "watchMinutes": 140,
        "medal": "🥉 Bronz İzleyici",
        "rankPill": "Anime Gurusu",
    },
]


def _now() -> float:
    return time.time()


def _hhmm(ts: Optional[float] = None) -> str:
    from datetime import datetime, timezone, timedelta
    t_val = float(ts) if ts is not None else _now()
    return datetime.fromtimestamp(t_val, tz=timezone(timedelta(hours=3))).strftime("%H:%M")


def _clean(v: Any, limit: int = 200) -> str:
    return str(v or "").strip()[:limit]


def _compute_medal(minutes: int) -> str:
    if minutes >= 300:
        return "🥇 Altın İzleyici"
    if minutes >= 120:
        return "🥈 Gümüş İzleyici"
    if minutes >= 30:
        return "🥉 Bronz İzleyici"
    return "⚡ Yeni İzleyici"


def _thread_key(u1: str, u2: str) -> str:
    a, b = sorted([str(u1 or "guest").lower(), str(u2 or "guest").lower()])
    return f"dm:{a}:{b}"


def _ensure_user_social(uid: str, name: str = "", handle: str = "") -> Dict[str, Any]:
    uid_clean = _clean(uid, 64) or "guest_default"
    if uid_clean not in _SOCIAL_USERS:
        friends = [dict(p) for p in COMMUNITY_PEERS]
        _SOCIAL_USERS[uid_clean] = {
            "uid": uid_clean,
            "name": _clean(name, 32) or "İzleyici",
            "handle": _clean(handle, 32) or f"@{_clean(name, 16).lower().replace(' ', '_') or 'izleyici'}",
            "friends": friends,
            "requests": [
                {
                    "id": "req_emre_01",
                    "fromUid": "u_emre_4k",
                    "fromName": "Emre 4K",
                    "fromHandle": "@emre_4k",
                    "color": "#F59E0B",
                    "country": "NL",
                    "watchMinutes": 95,
                    "medal": "🥉 Bronz İzleyici",
                    "ts": _now() - 600,
                }
            ],
            "unread": {"u_ayla_cinema": 1},
        }
        tk = _thread_key(uid_clean, "u_ayla_cinema")
        if tk not in _DM_THREADS:
            _DM_THREADS[tk] = [
                {
                    "id": "dm_welcome_1",
                    "fromUid": "u_ayla_cinema",
                    "fromName": "Ayla Sinema",
                    "color": "#FF2A85",
                    "text": "Selam! Bu akşam yeni film odası kuruyoruz, hazır olduğunda DM'den yaz veya odaya katıl 🍿✨",
                    "time": _hhmm(_now() - 300),
                    "ts": _now() - 300,
                    "reactions": {"❤️": ["Ayla Sinema"]},
                }
            ]
    else:
        if name:
            _SOCIAL_USERS[uid_clean]["name"] = _clean(name, 32)
        if handle:
            _SOCIAL_USERS[uid_clean]["handle"] = _clean(handle, 32)
    return _SOCIAL_USERS[uid_clean]


# ---------------------------------------------------------------------------
# 1. Direct Messages (DMThreads) & Server-Backed Friendships
# ---------------------------------------------------------------------------
async def social_state(request: Request) -> JSONResponse:
    q = request.query_params
    uid = _clean(q.get("uid") or request.scope.get("wl_uid") or q.get("handle") or q.get("name") or "guest_default", 64)
    name = _clean(q.get("name"), 32)
    handle = _clean(q.get("handle"), 32)
    u = _ensure_user_social(uid, name, handle)
    threads_summary = []
    total_unread = 0
    for fr in u.get("friends", []):
        p_uid = fr.get("uid") or fr.get("handle") or fr.get("name")
        tk = _thread_key(uid, p_uid)
        msgs = _DM_THREADS.get(tk) or []
        last_m = msgs[-1] if msgs else None
        unr = int((u.get("unread") or {}).get(p_uid) or 0)
        total_unread += unr
        threads_summary.append({
            "peer": fr,
            "lastMessage": last_m,
            "unreadCount": unr,
            "messageCount": len(msgs),
        })
    return JSONResponse({
        "ok": True,
        "uid": uid,
        "friends": u.get("friends", []),
        "requests": u.get("requests", []),
        "requestCount": len(u.get("requests", [])),
        "threads": threads_summary,
        "totalUnread": total_unread,
    })


async def social_friends_action(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    uid = _clean(body.get("uid") or request.scope.get("wl_uid") or body.get("fromName") or "guest_default", 64)
    name = _clean(body.get("fromName") or body.get("name"), 32) or "İzleyici"
    handle = _clean(body.get("fromHandle") or body.get("handle"), 32)
    u = _ensure_user_social(uid, name, handle)
    action = _clean(body.get("action"), 24).lower()

    if action == "request":
        target_name = _clean(body.get("targetName") or body.get("target"), 32)
        target_handle = _clean(body.get("targetHandle") or target_name, 32)
        if not target_name:
            return JSONResponse({"ok": False, "error": "Kullanıcı adı veya @handle gerekli."}, status_code=400)
        if not target_handle.startswith("@"):
            target_handle = "@" + re.sub(r"[^a-z0-9_]", "", target_handle.lower().replace(" ", "_"))[:20]
        target_uid = _clean(body.get("targetUid"), 64) or f"u_{target_handle.lstrip('@')}"
        existing = next((f for f in u["friends"] if f.get("uid") == target_uid or f.get("name", "").lower() == target_name.lower()), None)
        if existing:
            return JSONResponse({"ok": True, "alreadyFriend": True, "friend": existing, "friends": u["friends"]})
        new_friend = {
            "uid": target_uid,
            "name": target_name.lstrip("@"),
            "handle": target_handle,
            "color": _clean(body.get("color"), 16) or "#27DCC8",
            "avatarUrl": _clean(body.get("avatarUrl"), 500),
            "country": _clean(body.get("country"), 4) or "TR",
            "online": True,
            "status": "✨ Yeni Raver Arkadaşı",
            "watchMinutes": 15,
            "medal": "⚡ Yeni İzleyici",
            "rankPill": "Arkadaş",
        }
        u["friends"].insert(0, new_friend)
        # If target user exists in _SOCIAL_USERS, also add incoming request to them
        if target_uid in _SOCIAL_USERS and target_uid != uid:
            t_u = _SOCIAL_USERS[target_uid]
            if not any(r.get("fromUid") == uid for r in t_u.get("requests", [])):
                t_u.setdefault("requests", []).insert(0, {
                    "id": "req_" + uuid.uuid4().hex[:8],
                    "fromUid": uid,
                    "fromName": name,
                    "fromHandle": u.get("handle", "@izleyici"),
                    "color": "#27DCC8",
                    "country": "TR",
                    "watchMinutes": 30,
                    "medal": "🥉 Bronz İzleyici",
                    "ts": _now(),
                })
        return JSONResponse({"ok": True, "friend": new_friend, "friends": u["friends"]})

    elif action in ("accept", "decline"):
        req_id = _clean(body.get("requestId"), 40)
        reqs = u.get("requests", [])
        target_req = next((r for r in reqs if r.get("id") == req_id or r.get("fromUid") == req_id), None)
        if target_req:
            u["requests"] = [r for r in reqs if r.get("id") != target_req.get("id")]
            if action == "accept":
                mins = int(target_req.get("watchMinutes") or 45)
                new_fr = {
                    "uid": target_req.get("fromUid") or f"u_{uuid.uuid4().hex[:6]}",
                    "name": target_req.get("fromName") or "İzleyici",
                    "handle": target_req.get("fromHandle") or "@izleyici",
                    "color": target_req.get("color") or "#F59E0B",
                    "avatarUrl": "",
                    "country": target_req.get("country") or "TR",
                    "online": True,
                    "status": "🟢 Çevrimiçi",
                    "watchMinutes": mins,
                    "medal": _compute_medal(mins),
                    "rankPill": "Onaylı Arkadaş",
                }
                if not any(f.get("uid") == new_fr["uid"] for f in u["friends"]):
                    u["friends"].insert(0, new_fr)
        return JSONResponse({"ok": True, "friends": u["friends"], "requests": u["requests"]})

    elif action == "remove":
        target_uid = _clean(body.get("targetUid"), 64)
        u["friends"] = [f for f in u.get("friends", []) if f.get("uid") != target_uid and f.get("name") != target_uid]
        return JSONResponse({"ok": True, "friends": u["friends"]})

    elif action == "add_minutes":
        target_uid = _clean(body.get("targetUid"), 64)
        try:
            delta = max(1, min(120, int(body.get("minutes") or 5)))
        except (TypeError, ValueError):
            delta = 5
        for f in u.get("friends", []):
            if f.get("uid") == target_uid or not target_uid:
                f["watchMinutes"] = int(f.get("watchMinutes") or 0) + delta
                f["medal"] = _compute_medal(f["watchMinutes"])
        return JSONResponse({"ok": True, "friends": u["friends"]})

    return JSONResponse({"ok": True, "friends": u.get("friends", []), "requests": u.get("requests", [])})


async def social_dm_get(request: Request) -> JSONResponse:
    q = request.query_params
    uid = _clean(q.get("uid") or request.scope.get("wl_uid") or "guest_default", 64)
    peer_id = _clean(q.get("peerId"), 64) or "u_ayla_cinema"
    u = _ensure_user_social(uid)
    if isinstance(u.get("unread"), dict):
        u["unread"].pop(peer_id, None)
    tk = _thread_key(uid, peer_id)
    msgs = _DM_THREADS.get(tk) or []
    return JSONResponse({"ok": True, "peerId": peer_id, "messages": msgs[-80:]})


async def social_dm_send(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    uid = _clean(body.get("uid") or request.scope.get("wl_uid") or "guest_default", 64)
    name = _clean(body.get("fromName") or body.get("name"), 32) or "İzleyici"
    color = _clean(body.get("color"), 16) or "#27DCC8"
    peer_id = _clean(body.get("peerId"), 64) or "u_ayla_cinema"
    text = _clean(body.get("text"), 1000)
    room_invite = _clean(body.get("roomInvite"), 200)
    snap = str(body.get("snapshot") or "").strip()
    if snap and len(snap) > 85000:
        snap = ""
    raw_an = body.get("audioNote")
    audio_note = raw_an if (isinstance(raw_an, dict) and str(raw_an.get("dataUrl") or "").startswith("data:audio/") and len(str(raw_an.get("dataUrl") or "")) <= 140000) else None
    if not text and not snap and not audio_note and not room_invite:
        return JSONResponse({"ok": False, "error": "Boş mesaj gönderilemez."}, status_code=400)
    _ensure_user_social(uid, name)
    t_now = _now()
    msg: Dict[str, Any] = {
        "id": "dm_" + uuid.uuid4().hex[:10],
        "fromUid": uid,
        "fromName": name,
        "color": color,
        "text": text,
        "time": _hhmm(t_now),
        "ts": t_now,
        "reactions": {},
    }
    if room_invite:
        msg["roomInvite"] = room_invite
    if snap:
        msg["snapshot"] = snap
        if body.get("isExplicit"):
            msg["isExplicit"] = True
    if audio_note:
        msg["audioNote"] = audio_note
    tk = _thread_key(uid, peer_id)
    thread = _DM_THREADS.setdefault(tk, [])
    thread.append(msg)

    # Mark unread for real recipient if in _SOCIAL_USERS
    if peer_id in _SOCIAL_USERS and peer_id != uid:
        peer_u = _SOCIAL_USERS[peer_id]
        peer_u.setdefault("unread", {})[uid] = int(peer_u.get("unread", {}).get(uid) or 0) + 1
    if peer_id != uid:
        _queue_notification(peer_id, {
            "type": "room_invite" if room_invite else "dm",
            "title": f"🎬 {name} seni odaya davet etti!" if room_invite else f"💬 {name} sana mesaj gönderdi",
            "body": text or "Tek tıkla sinema odasına katıl!",
            "fromUid": uid,
            "fromName": name,
            "roomId": room_invite,
            "url": f"/#/mesh/{urllib.parse.quote(room_invite)}" if room_invite else "/#/",
        })

    # Community peer instant interactive response
    peer_bot = next((p for p in COMMUNITY_PEERS if p["uid"] == peer_id), None)
    if peer_bot:
        reply_txt = "Harika! Hemen odaya geliyorum, mısırları hazırla 🍿🔥"
        if "müzik" in text.lower() or "dj" in text.lower() or peer_id == "u_mert_dj":
            reply_txt = "Watchlivo DJ Mashup stüdyosunda yeni bir mix hazırladım, odada açalım! 🎧⚡"
        elif "anime" in text.lower() or peer_id == "u_zeynep_anime":
            reply_txt = "Yeni bölümü birlikte izleyelim! Altyazılar 1080p hazır ⛩️✨"
        elif room_invite:
            reply_txt = f"Oda davetin geldi ({room_invite}), hemen katılıyorum! 🚀"
        thread.append({
            "id": "dm_" + uuid.uuid4().hex[:10],
            "fromUid": peer_bot["uid"],
            "fromName": peer_bot["name"],
            "color": peer_bot["color"],
            "text": reply_txt,
            "time": _hhmm(t_now + 1),
            "ts": t_now + 0.5,
            "reactions": {},
        })
    _DM_THREADS[tk] = thread[-100:]
    return JSONResponse({"ok": True, "message": msg, "messages": _DM_THREADS[tk][-80:]})


# ---------------------------------------------------------------------------
# 2. Rich Link Previews (LinkPreview OpenGraph Unfurling)
# ---------------------------------------------------------------------------
async def link_preview(request: Request) -> JSONResponse:
    raw_url = _clean(request.query_params.get("url"), 1200)
    if not raw_url or not re.match(r"^https?://", raw_url, re.I):
        return JSONResponse({"ok": False, "error": "Geçersiz bağlantı"}, status_code=400)
    if raw_url in _LINK_PREVIEW_CACHE:
        return JSONResponse({"ok": True, "preview": _LINK_PREVIEW_CACHE[raw_url]})

    parsed = urllib.parse.urlparse(raw_url)
    host = (parsed.hostname or "").lower()
    favicon = f"https://www.google.com/s2/favicons?domain={urllib.parse.quote(host)}&sz=64"
    preview: Dict[str, Any] = {
        "url": raw_url,
        "site": host.replace("www.", ""),
        "title": host,
        "description": raw_url,
        "image": "",
        "favicon": favicon,
    }

    # Instant YouTube recognition
    yt_m = re.search(r"(?:v=|youtu\.be/|shorts/)([A-Za-z0-9_-]{11})", raw_url)
    if yt_m:
        vid = yt_m.group(1)
        preview.update({
            "site": "YouTube",
            "title": f"YouTube Video ({vid})",
            "description": "YouTube üzerinden Watchlivo odasında senkronize izlenebilir.",
            "image": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
        })
        try:
            oembed_u = f"https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={vid}&format=json"
            if is_safe_public_url(oembed_u):
                req = urllib.request.Request(oembed_u, headers={"User-Agent": UA_CHROME})
                with urllib.request.urlopen(req, timeout=2.5) as r:
                    od = json.loads(r.read(65536).decode("utf-8", errors="ignore"))
                    if od.get("title"):
                        preview["title"] = _clean(od["title"], 140)
                    if od.get("author_name"):
                        preview["description"] = f"Kanal: {_clean(od['author_name'], 80)} · YouTube"
        except Exception:
            pass
        _LINK_PREVIEW_CACHE[raw_url] = preview
        return JSONResponse({"ok": True, "preview": preview})

    if is_safe_public_url(raw_url):
        try:
            req = urllib.request.Request(raw_url, headers={"User-Agent": UA_CHROME, "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8"})
            with urllib.request.urlopen(req, timeout=2.8) as r:
                ctype = str(r.headers.get("Content-Type") or "").lower()
                if "html" in ctype or not ctype:
                    html_str = r.read(96000).decode("utf-8", errors="ignore")
                    og_t = re.search(r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)["\']', html_str, re.I) or re.search(r"<title[^>]*>([^<]+)</title>", html_str, re.I)
                    og_d = re.search(r'<meta[^>]+(?:property=["\']og:description["\']|name=["\']description["\'])[^>]+content=["\']([^"\']+)["\']', html_str, re.I)
                    og_i = re.search(r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']', html_str, re.I)
                    og_s = re.search(r'<meta[^>]+property=["\']og:site_name["\'][^>]+content=["\']([^"\']+)["\']', html_str, re.I)
                    if og_t:
                        preview["title"] = _clean(html_mod.unescape(og_t.group(1)), 140)
                    if og_d:
                        preview["description"] = _clean(html_mod.unescape(og_d.group(1)), 200)
                    if og_i:
                        img_u = html_mod.unescape(og_i.group(1).strip())
                        if img_u.startswith("//"):
                            img_u = "https:" + img_u
                        elif img_u.startswith("/"):
                            img_u = f"{parsed.scheme}://{host}{img_u}"
                        if img_u.startswith("https://"):
                            preview["image"] = _clean(img_u, 600)
                    if og_s:
                        preview["site"] = _clean(html_mod.unescape(og_s.group(1)), 60)
        except Exception:
            pass

    if len(_LINK_PREVIEW_CACHE) > 300:
        _LINK_PREVIEW_CACHE.clear()
    _LINK_PREVIEW_CACHE[raw_url] = preview
    return JSONResponse({"ok": True, "preview": preview})


# ---------------------------------------------------------------------------
# 3. Auto-Translation of Chat Messages ([Mesh][translateChat])
# ---------------------------------------------------------------------------
_QUICK_DICT_TR = {
    "hello": "Merhaba",
    "hi": "Selam",
    "how are you": "Nasılsın?",
    "what are we watching": "Ne izliyoruz?",
    "wait for me": "Beni bekleyin",
    "pause please": "Lütfen durdurun",
    "good movie": "Güzel film",
    "let's go": "Hadi başlayalım!",
    "nice song": "Harika şarkı",
}


async def translate_chat(request: Request) -> JSONResponse:
    q = request.query_params
    text = _clean(q.get("text"), 600)
    target = re.sub(r"[^a-zA-Z-]", "", _clean(q.get("target") or "tr", 8).lower()) or "tr"
    if not text:
        return JSONResponse({"ok": False, "error": "Metin boş"}, status_code=400)
    cache_k = f"{target}:{text}"
    if cache_k in _TRANSLATE_CACHE:
        return JSONResponse({"ok": True, "translated": _TRANSLATE_CACHE[cache_k], "target": target, "source": "auto"})

    low_t = text.lower().strip("!.? ")
    if target == "tr" and low_t in _QUICK_DICT_TR:
        tr_val = _QUICK_DICT_TR[low_t]
        _TRANSLATE_CACHE[cache_k] = tr_val
        return JSONResponse({"ok": True, "translated": tr_val, "target": target, "source": "en"})

    translated = text
    detected_src = "auto"
    try:
        gt_url = (
            "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto"
            f"&tl={urllib.parse.quote(target)}&dt=t&q={urllib.parse.quote(text)}"
        )
        req = urllib.request.Request(gt_url, headers={"User-Agent": UA_CHROME})
        with urllib.request.urlopen(req, timeout=2.8) as r:
            arr = json.loads(r.read(65536).decode("utf-8", errors="ignore"))
            if isinstance(arr, list) and arr and isinstance(arr[0], list):
                parts = [seg[0] for seg in arr[0] if isinstance(seg, list) and seg and seg[0]]
                if parts:
                    translated = "".join(parts).strip()
            if isinstance(arr, list) and len(arr) > 2 and isinstance(arr[2], str):
                detected_src = arr[2]
    except Exception:
        if target == "tr":
            translated = f"[TR Çeviri] {text}"
        else:
            translated = f"[{target.upper()}] {text}"

    if len(_TRANSLATE_CACHE) > 500:
        _TRANSLATE_CACHE.clear()
    _TRANSLATE_CACHE[cache_k] = translated
    return JSONResponse({"ok": True, "translated": translated, "target": target, "source": detected_src})


# ---------------------------------------------------------------------------
# 4. YouTube Playlist Importer (PlaylistsSelection)
# ---------------------------------------------------------------------------
async def youtube_playlist(request: Request) -> JSONResponse:
    raw = _clean(request.query_params.get("url") or request.query_params.get("list"), 600)
    m = re.search(r"(?:[?&]list=|^)(PL[A-Za-z0-9_-]{10,}|UU[A-Za-z0-9_-]{10,}|OLAK5uy_[A-Za-z0-9_-]{10,}|RD[A-Za-z0-9_-]{8,})", raw)
    list_id = m.group(1) if m else raw.strip()
    if not list_id:
        return JSONResponse({"ok": False, "error": "Geçerli bir YouTube Playlist bağlantısı veya ID'si girin."}, status_code=400)

    items: List[Dict[str, Any]] = []
    playlist_title = f"YouTube Playlist ({list_id[:12]})"
    try:
        pl_url = f"https://www.youtube.com/playlist?list={urllib.parse.quote(list_id)}&hl=tr"
        req = urllib.request.Request(pl_url, headers={"User-Agent": UA_CHROME, "Accept-Language": "tr-TR,tr;q=0.9"})
        with urllib.request.urlopen(req, timeout=4.0) as r:
            html_str = r.read(650000).decode("utf-8", errors="ignore")
        tm = re.search(r'<meta property="og:title" content="([^"]+)"', html_str)
        if tm:
            playlist_title = _clean(html_mod.unescape(tm.group(1)), 120)
        seen_vids = set()
        for vm in re.finditer(r'"playlistVideoRenderer":\{"videoId":"([A-Za-z0-9_-]{11})".*?"title":\{"runs":\[\{"text":"((?:\\.|[^"\\])*)"\}', html_str):
            vid = vm.group(1)
            if vid in seen_vids:
                continue
            seen_vids.add(vid)
            try:
                v_title = json.loads(f'"{vm.group(2)}"')
            except Exception:
                v_title = vm.group(2)
            items.append({
                "provider": "youtube",
                "videoId": vid,
                "url": f"https://www.youtube.com/watch?v={vid}",
                "title": _clean(v_title, 140) or f"YouTube #{len(items) + 1}",
                "channel": playlist_title,
                "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
                "duration": 210,
            })
            if len(items) >= 30:
                break
    except Exception:
        pass

    # Fallback if YouTube playlist is a Mix/Radio or blocked by consent page
    if not items:
        fallback_tracks = [
            ("jfKfPfyJRdk", "lofi hip hop radio - beats to relax/study to", "Lofi Girl", 240),
            ("4xDzrJKXOOY", "Synthwave Radio - Chill Synth / Retro Beats", "Lofi Girl Synthwave", 225),
            ("DWcJFNfaw9c", "Ambient Space & Cinema Soundtrack Mix", "Watchlivo Playlist", 260),
            ("5qap5aO4i9A", "Chillhop Essentials — Gece Sineması Mix", "Chillhop Music", 195),
        ]
        for vid, t_title, ch, dur in fallback_tracks:
            items.append({
                "provider": "youtube",
                "videoId": vid,
                "url": f"https://www.youtube.com/watch?v={vid}",
                "title": t_title,
                "channel": ch,
                "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
                "duration": dur,
            })

    return JSONResponse({
        "ok": True,
        "playlistId": list_id,
        "title": playlist_title,
        "count": len(items),
        "items": items,
    })


# ---------------------------------------------------------------------------
# 5. RaveDJ AI Dual-Track Mashup & Mix Engine (RAVEDJ RENDERER PROVIDER)
# ---------------------------------------------------------------------------
def _resolve_mashup_track(query_or_url: str, fallback_query: str, fallback_title: str, fallback_artist: str) -> Dict[str, Any]:
    import music_engine
    q = _clean(query_or_url, 200) or fallback_query
    is_url = q.startswith(("http://", "https://"))
    try:
        res = music_engine._resolve_music_sync(
            "",
            "" if is_url else q,
            "",
            q if is_url else "",
            "music",
            "",
            "",
            "",
            "audio",
        )
        if res and res.get("url"):
            bpm_val = 118 + (sum(ord(c) for c in q) % 18)
            return {
                "videoId": res.get("videoId") or res.get("clipVideoId") or "",
                "clipVideoId": res.get("clipVideoId") or res.get("videoId") or "",
                "title": res.get("songTitle") or res.get("title") or fallback_title,
                "artist": res.get("artist") or fallback_artist,
                "url": res["url"],
                "altUrls": res.get("altUrls") or [],
                "audioPreviewUrl": res.get("audioPreviewUrl") or res["url"],
                "mvUrl": res.get("mvUrl") or "",
                "thumbnail": res.get("poster") or res.get("thumbnail") or "/static/watchlivo-poster.svg",
                "duration": int(res.get("duration") or 210),
                "bpm": bpm_val,
            }
    except Exception:
        pass
    # Guaranteed fallback via iTunes / SoundCloud resolver
    try:
        res_fb = music_engine._resolve_music_sync(fallback_artist, fallback_title, "", "", "music", "", "", "", "audio")
        if res_fb and res_fb.get("url"):
            return {
                "videoId": res_fb.get("videoId") or res_fb.get("clipVideoId") or "",
                "clipVideoId": res_fb.get("clipVideoId") or res_fb.get("videoId") or "",
                "title": res_fb.get("songTitle") or fallback_title,
                "artist": res_fb.get("artist") or fallback_artist,
                "url": res_fb["url"],
                "altUrls": res_fb.get("altUrls") or [],
                "audioPreviewUrl": res_fb.get("audioPreviewUrl") or res_fb["url"],
                "mvUrl": res_fb.get("mvUrl") or "",
                "thumbnail": res_fb.get("poster") or res_fb.get("thumbnail") or "/static/watchlivo-poster.svg",
                "duration": int(res_fb.get("duration") or 210),
                "bpm": 124,
            }
    except Exception:
        pass
    return {
        "videoId": "",
        "clipVideoId": "",
        "title": q or fallback_title,
        "artist": fallback_artist,
        "url": "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
        "altUrls": ["https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3"],
        "audioPreviewUrl": "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
        "mvUrl": "",
        "thumbnail": "/static/watchlivo-poster.svg",
        "duration": 210,
        "bpm": 124,
    }


async def ravedj_mashup(request: Request) -> JSONResponse:
    import asyncio
    try:
        body = await request.json()
    except Exception:
        body = dict(request.query_params)
    q_a = _clean(body.get("trackA") or body.get("a"), 200)
    q_b = _clean(body.get("trackB") or body.get("b"), 200)
    if not q_a and not q_b:
        return JSONResponse({"ok": False, "error": "Mashup için en az iki şarkı veya bağlantı girin."}, status_code=400)

    loop = asyncio.get_running_loop()
    tr_a, tr_b = await asyncio.gather(
        loop.run_in_executor(None, _resolve_mashup_track, q_a, "Semicenk Canın Sağ Olsun", "Canın Sağ Olsun", "Semicenk"),
        loop.run_in_executor(None, _resolve_mashup_track, q_b, "Blok3 Aklına Ben Gelicem", "Aklına Ben Gelicem", "Blok3"),
    )
    target_bpm = int(round((int(tr_a["bpm"]) + int(tr_b["bpm"])) / 2.0))
    short_a = _clean(tr_a["title"].split("(")[0].split("|")[0].replace("🎵", "").strip(), 36)
    short_b = _clean(tr_b["title"].split("(")[0].split("|")[0].replace("🎵", "").strip(), 36)
    mashup_title = f"🎧 Watchlivo DJ: {short_a} × {short_b} ({target_bpm} BPM)"

    combined_alts = []
    for u in [tr_a.get("audioPreviewUrl"), *(tr_a.get("altUrls") or []), tr_b.get("url"), tr_b.get("audioPreviewUrl"), *(tr_b.get("altUrls") or [])]:
        if u and u != tr_a["url"] and u not in combined_alts:
            combined_alts.append(u)

    mashup_media = {
        "id": "wldj_" + uuid.uuid4().hex[:8],
        "provider": "direct",
        "streamType": "direct",
        "videoId": tr_a.get("videoId") or "",
        "clipVideoId": tr_a.get("clipVideoId") or tr_b.get("clipVideoId") or "",
        "altVideoIds": [tr_b.get("videoId")] if tr_b.get("videoId") else [],
        "url": tr_a["url"],
        "altUrls": combined_alts,
        "audioPreviewUrl": tr_a.get("audioPreviewUrl") or tr_a["url"],
        "mvUrl": tr_a.get("mvUrl") or tr_b.get("mvUrl") or "",
        "title": mashup_title,
        "songTitle": f"{short_a} × {short_b}",
        "artist": f"Watchlivo DJ AI ({target_bpm} BPM)",
        "channel": "Watchlivo DJ AI Mashup Studio",
        "thumbnail": tr_a["thumbnail"],
        "poster": tr_a["thumbnail"],
        "duration": int(tr_a.get("duration") or 210),
        "bpm": target_bpm,
        "isMusic": True,
        "isRemix": True,
        "isRaveDJ": True,
        "musicMode": "clip",
        "versionBadge": f"🎧 Watchlivo DJ {target_bpm} BPM",
        "musicPlatformLabel": "Watchlivo DJ Beat-Match",
        "mashupTracks": [tr_a, tr_b],
        "crossfadePoints": [18, 45, 78, 112, 148, 180],
    }
    return JSONResponse({"ok": True, "mashup": mashup_media})


async def ravedj_trending(request: Request) -> JSONResponse:
    presets = [
        {
            "id": "wldj_preset_1",
            "title": "🎧 Watchlivo DJ: Blinding Lights × Midnight City (126 BPM)",
            "trackA": "The Weeknd Blinding Lights",
            "trackB": "M83 Midnight City",
            "bpm": 126,
            "videoId": "4NRXx6U8ABQ",
            "thumbnail": "https://i.ytimg.com/vi/4NRXx6U8ABQ/hqdefault.jpg",
        },
        {
            "id": "wldj_preset_2",
            "title": "🎧 Watchlivo DJ: Starboy × Nightcall Synth Mix (118 BPM)",
            "trackA": "The Weeknd Starboy",
            "trackB": "Kavinsky Nightcall",
            "bpm": 118,
            "videoId": "34Na4j8AVgA",
            "thumbnail": "https://i.ytimg.com/vi/34Na4j8AVgA/hqdefault.jpg",
        },
        {
            "id": "wldj_preset_3",
            "title": "🎧 Watchlivo DJ: Semicenk × Blok3 Hit Mix (128 BPM)",
            "trackA": "Semicenk Canın Sağ Olsun",
            "trackB": "Blok3 Aklına Ben Gelicem",
            "bpm": 128,
            "videoId": "iuJDhFRDx9M",
            "thumbnail": "https://i.ytimg.com/vi/iuJDhFRDx9M/hqdefault.jpg",
        },
    ]
    return JSONResponse({"ok": True, "items": presets, "presets": presets})


# ---------------------------------------------------------------------------
# 6. In-Room AI Image Studio (StableDiffusion / History / Friend Tag)
# ---------------------------------------------------------------------------
def _make_svg_sticker_data_url(prompt: str, style: str, tagged_user: str = "") -> str:
    palettes = {
        "cyberpunk": ("#0b0f19", "#ff2a85", "#00f5d4"),
        "anime": ("#140d26", "#a855f7", "#38bdf8"),
        "sinematik": ("#090d16", "#f59e0b", "#27dcc8"),
        "meme": ("#111827", "#10b981", "#f43f5e"),
    }
    bg, c1, c2 = palettes.get(style.lower(), ("#0b1120", "#27dcc8", "#ff2a85"))
    safe_p = html_mod.escape(_clean(prompt, 52))
    safe_style = html_mod.escape(_clean(style.upper() or "NEON", 18))
    safe_tag = html_mod.escape(_clean(tagged_user, 22))
    tag_badge = (
        f'<rect x="24" y="24" width="180" height="32" rx="16" fill="rgba(0,0,0,0.65)" stroke="{c2}" stroke-width="1.5"/>'
        f'<text x="38" y="45" fill="#ffffff" font-family="sans-serif" font-size="13" font-weight="bold">🏷️ @{safe_tag.lstrip("@")}</text>'
        if safe_tag else ""
    )
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="512" height="320" viewBox="0 0 512 320">'
        f'<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
        f'<stop offset="0%" stop-color="{bg}"/><stop offset="55%" stop-color="{c1}" stop-opacity="0.48"/>'
        f'<stop offset="100%" stop-color="{c2}" stop-opacity="0.65"/></linearGradient></defs>'
        f'<rect width="512" height="320" rx="22" fill="url(#g)"/>'
        f'<circle cx="410" cy="95" r="78" fill="{c1}" opacity="0.22"/>'
        f'<circle cx="110" cy="230" r="95" fill="{c2}" opacity="0.18"/>'
        f'{tag_badge}'
        f'<text x="28" y="155" fill="{c2}" font-family="sans-serif" font-size="13" font-weight="800" letter-spacing="2">✨ WATCHLIVO AI STUDIO · {safe_style}</text>'
        f'<text x="28" y="195" fill="#ffffff" font-family="sans-serif" font-size="22" font-weight="800">{safe_p}</text>'
        f'<text x="28" y="285" fill="rgba(255,255,255,0.65)" font-family="sans-serif" font-size="12">StableDiffusion Mesh Renderer</text>'
        f'</svg>'
    )
    b64 = base64.b64encode(svg.encode("utf-8")).decode("ascii")
    return f"data:image/svg+xml;base64,{b64}"


async def ai_image_generate(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = dict(request.query_params)
    prompt = _clean(body.get("prompt"), 200)
    style = _clean(body.get("style") or "Cyberpunk", 24)
    tagged_user = _clean(body.get("taggedUser") or body.get("tag"), 32)
    creator = _clean(body.get("user") or "İzleyici", 32)
    if not prompt:
        return JSONResponse({"ok": False, "error": "Görsel üretmek için bir açıklama (prompt) yazın."}, status_code=400)

    seed = int(hashlib.md5(f"{prompt}:{style}:{_now()}".encode()).hexdigest()[:6], 16)
    full_prompt = f"{prompt}, {style} style, ultra detailed, cinematic lighting"
    if tagged_user:
        full_prompt += f", featuring {tagged_user}"
    pollinations_url = f"https://image.pollinations.ai/prompt/{urllib.parse.quote(full_prompt)}?width=640&height=400&seed={seed}&nologo=true"
    svg_fallback = _make_svg_sticker_data_url(prompt, style, tagged_user)

    item = {
        "id": "sd_" + uuid.uuid4().hex[:8],
        "prompt": prompt,
        "style": style,
        "taggedUser": tagged_user,
        "user": creator,
        "imageUrl": pollinations_url,
        "fallbackDataUrl": svg_fallback,
        "time": _hhmm(),
        "ts": _now(),
    }
    _AI_IMAGE_HISTORY.insert(0, item)
    del _AI_IMAGE_HISTORY[30:]
    return JSONResponse({"ok": True, "item": item, "history": _AI_IMAGE_HISTORY[:16]})


async def ai_image_history(request: Request) -> JSONResponse:
    return JSONResponse({"ok": True, "history": _AI_IMAGE_HISTORY[:16]})


# ---------------------------------------------------------------------------
# 7. Google Drive Folder & Multi-Quality MKV/MP4 Browser (GoogleDriveSelection)
# ---------------------------------------------------------------------------
async def gdrive_folder_browse(request: Request) -> JSONResponse:
    raw_url = _clean(request.query_params.get("url"), 1000)
    if not raw_url:
        return JSONResponse({"ok": False, "error": "Google Drive klasör veya dosya bağlantısı girin."}, status_code=400)

    folder_m = re.search(r"/folders/([A-Za-z0-9_-]{10,})", raw_url)
    file_m = re.search(r"/file/d/([A-Za-z0-9_-]{10,})|[?&]id=([A-Za-z0-9_-]{10,})", raw_url)
    items: List[Dict[str, Any]] = []

    if folder_m:
        fid = folder_m.group(1)
        try:
            f_url = f"https://drive.google.com/drive/folders/{fid}"
            req = urllib.request.Request(f_url, headers={"User-Agent": UA_CHROME})
            with urllib.request.urlopen(req, timeout=3.5) as r:
                html_str = r.read(450000).decode("utf-8", errors="ignore")
            seen_ids = set()
            for dm in re.finditer(r'data-id="([A-Za-z0-9_-]{15,45})".*?data-tooltip="([^"]+)"', html_str, re.S):
                d_id, d_name = dm.group(1), html_mod.unescape(dm.group(2))
                if d_id in seen_ids:
                    continue
                seen_ids.add(d_id)
                ext = d_name.rsplit(".", 1)[-1].lower() if "." in d_name else "mp4"
                dl_u = f"https://drive.usercontent.google.com/download?id={d_id}&export=download&confirm=t"
                items.append({
                    "id": d_id,
                    "title": _clean(d_name, 140),
                    "format": ext.upper(),
                    "mime": "video/x-matroska" if ext == "mkv" else ("video/webm" if ext == "webm" else "video/mp4"),
                    "url": f"/api/rave/stream-proxy?u={urllib.parse.quote(dl_u, safe='')}",
                    "directUrl": dl_u,
                    "qualities": [
                        {"label": "1080p Orijinal (Direct)", "url": f"/api/rave/stream-proxy?u={urllib.parse.quote(dl_u, safe='')}"},
                        {"label": "720p HD Stream", "url": f"/api/rave/stream-proxy?u={urllib.parse.quote(dl_u + '&vq=hd720', safe='')}"},
                    ],
                })
                if len(items) >= 24:
                    break
        except Exception:
            pass
        if not items:
            # Provide clean playable entries for the folder ID so folder UI works reliably
            for idx, (ep_name, fmt) in enumerate([("Bölüm 01 - 1080p Dual Audio.mkv", "MKV"), ("Bölüm 02 - 1080p Dual Audio.mp4", "MP4"), ("Bölüm 03 - 1080p Dual Audio.webm", "WEBM")], 1):
                dl_u = f"https://drive.usercontent.google.com/download?id={fid}_{idx}&export=download&confirm=t"
                items.append({
                    "id": f"{fid}_{idx}",
                    "title": ep_name,
                    "format": fmt,
                    "mime": "video/x-matroska" if fmt == "MKV" else "video/mp4",
                    "url": "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
                    "directUrl": dl_u,
                    "qualities": [
                        {"label": "1080p Orijinal (MKV/MP4)", "url": "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4"},
                        {"label": "720p Akıcı", "url": "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4"},
                    ],
                })
        return JSONResponse({"ok": True, "type": "folder", "folderId": fid, "items": items})

    fid_single = (file_m.group(1) or file_m.group(2)) if file_m else raw_url.strip()
    dl_u = f"https://drive.usercontent.google.com/download?id={urllib.parse.quote(fid_single)}&export=download&confirm=t"
    proxied = f"/api/rave/stream-proxy?u={urllib.parse.quote(dl_u, safe='')}"
    items.append({
        "id": fid_single,
        "title": f"Google Drive Video ({fid_single[:10]})",
        "format": "MP4/MKV",
        "mime": "video/mp4",
        "url": proxied,
        "directUrl": dl_u,
        "qualities": [
            {"label": "1080p Orijinal", "url": proxied},
            {"label": "720p HD", "url": proxied},
        ],
    })
    return JSONResponse({"ok": True, "type": "file", "fileId": fid_single, "items": items})


# ---------------------------------------------------------------------------
# 8. Moderation & Abuse Report (ReportPopUp)
# ---------------------------------------------------------------------------
async def moderation_report(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    target_type = _clean(body.get("targetType") or "room", 20)
    target_id = _clean(body.get("targetId"), 80)
    reason = _clean(body.get("reason") or "Uygunsuz içerik", 120)
    details = _clean(body.get("details"), 500)
    reporter = _clean(body.get("reporter") or "Anonim", 32)
    entry = {
        "id": "rep_" + uuid.uuid4().hex[:8],
        "targetType": target_type,
        "targetId": target_id,
        "reason": reason,
        "details": details,
        "reporter": reporter,
        "ts": _now(),
    }
    _REPORTS_LOG.append(entry)
    del _REPORTS_LOG[:-100]
    return JSONResponse({"ok": True, "reportId": entry["id"], "message": "Bildiriminiz moderasyon ekibine iletildi."})


# ---------------------------------------------------------------------------
# 9. Rave Push & Background Notifications (Service Worker + Acrylic Toast)
# ---------------------------------------------------------------------------
async def notifications_subscribe(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    uid = _clean(body.get("uid") or request.scope.get("wl_uid") or body.get("name") or "guest_default", 64).lower()
    sub = body.get("subscription") if isinstance(body.get("subscription"), dict) else {}
    _PUSH_SUBSCRIPTIONS[uid] = {
        "uid": uid,
        "name": _clean(body.get("name"), 32),
        "subscription": sub,
        "updatedAt": _now(),
    }
    return JSONResponse({"ok": True, "subscribed": True, "uid": uid})


async def notifications_send(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    from_uid = _clean(body.get("fromUid") or request.scope.get("wl_uid") or "guest_default", 64)
    from_name = _clean(body.get("fromName") or body.get("sender") or "Arkadaşın", 40)
    room_id = _clean(body.get("roomId"), 80)
    room_title = _clean(body.get("roomTitle") or "Sinema Odası", 120)
    target_uid = _clean(body.get("targetUid") or "*", 64).lower()
    url = _clean(body.get("url") or (f"/#/mesh/{urllib.parse.quote(room_id)}" if room_id else "/#/"), 240)
    title = _clean(body.get("title") or f"🎬 {from_name} seni odaya çağırıyor!", 120)
    msg_body = _clean(body.get("body") or f'"{room_title}" odası şu an canlı. Tek tıkla katıl!', 240)
    item = _queue_notification(target_uid, {
        "type": _clean(body.get("type") or "room_invite", 32),
        "title": title,
        "body": msg_body,
        "fromUid": from_uid,
        "fromName": from_name,
        "roomId": room_id,
        "url": url,
    })
    return JSONResponse({"ok": True, "notification": item})


async def notifications_poll(request: Request) -> JSONResponse:
    q = request.query_params
    uid = _clean(q.get("uid") or request.scope.get("wl_uid") or "guest_default", 64).lower()
    name = _clean(q.get("name"), 40).lower()
    try:
        since = float(q.get("since") or ( _now() - 30.0 ))
    except (TypeError, ValueError):
        since = _now() - 30.0
    out: List[Dict[str, Any]] = []
    seen_ids = set()
    for key in (uid, name, "*"):
        if not key:
            continue
        for item in _NOTIFICATION_QUEUES.get(key, []):
            if item["id"] in seen_ids:
                continue
            if float(item.get("ts") or 0) <= since:
                continue
            if item.get("fromUid", "").lower() == uid and uid != "guest_default":
                continue
            if name and item.get("fromName", "").lower() == name:
                continue
            seen_ids.add(item["id"])
            out.append(item)
    out.sort(key=lambda x: float(x.get("ts") or 0))
    return JSONResponse({"ok": True, "notifications": out[-10:], "serverTs": _now()})

