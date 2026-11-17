import sys
import os
from starlette.testclient import TestClient

base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
sys.path.insert(0, base_dir)

import server

client = TestClient(server.app)

# 1. Create Room
r_create = client.post("/api/rooms/create", json={
    "name": "Sync Test Room",
    "creator": "HostUser",
    "media": {
        "title": "Inception",
        "url": "https://example.com/test.m3u8",
        "playing": True,
        "currentTime": 0.0
    }
})
create_data = r_create.json()
room_id = create_data["room"]["id"]
cid = create_data["clientId"]
tok = create_data["clientToken"]

print(f"Room Created: {room_id}, CID: {cid}")

# 2. Host sends seek to 1800.0s
seek_res = client.post(f"/api/rooms/{room_id}/sync", json={
    "type": "seek",
    "clientId": cid,
    "clientToken": tok,
    "currentTime": 1800.0,
    "playing": True
})
print("Seek Response:", seek_res.status_code)

# 3. Peer joins and reads room state
peer_res = client.post(f"/api/rooms/{room_id}/sync", json={
    "type": "poll",
    "username": "PeerUser"
})
peer_data = peer_res.json()
peer_room = peer_data.get("room") or peer_data
cur_time = peer_room.get("media", {}).get("currentTime")
print(f"Peer Received Media CurrentTime: {cur_time}")
