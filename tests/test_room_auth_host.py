import sys
import os
sys.path.insert(0, os.path.abspath('c:/Users/pc/Documents/projelerim/rave_web_platform'))
from rooms import new_room, add_participant, handle_action, ensure_host, set_media, sign_client_token, verify_client_token

def test_room_host_authorization():
    # 1. Create room
    room = new_room('test_room', 'Test Room', creator='Mert Can Yıldız', creator_id='uid_mert_pc')
    p1, is_new1 = add_participant(room, 'pc_client_1', {'username': 'Mert Can Yıldız', 'uid': 'uid_mert_pc'}, 'ws')
    assert room['host_id'] == 'pc_client_1', f"Expected pc_client_1, got {room.get('host_id')}"
    print('Check 1 (PC is host): PASS')

    # 2. Phone enters with SAME NAME
    p2, is_new2 = add_participant(room, 'phone_client_2', {'username': 'Mert Can Yıldız', 'uid': 'uid_mert_phone'}, 'ws')
    assert room['host_id'] == 'pc_client_1', f"Host hijacked by phone! Expected pc_client_1, got {room.get('host_id')}"
    print('Check 2 (Phone with same name does not hijack host): PASS')

    # 3. ensure_host called
    ensure_host(room)
    assert room['host_id'] == 'pc_client_1', f"ensure_host changed host! Got {room.get('host_id')}"
    print('Check 3 (ensure_host preserves active host): PASS')

    # 4. Set media via set_media with start=10.0
    set_media(room, {'url': 'https://example.com/video.mp4', 'duration': 100.0, 'playing': True}, 'Mert Can Yıldız', start=10.0)

    # 5. Phone attempts seek
    out_phone = handle_action(room, 'phone_client_2', {'type': 'seek', 'currentTime': 50.0})
    errors = [m['message'] for m in out_phone.get('reply', []) if m.get('type') == 'error']
    assert any('yalnızca oda lideri' in e for e in errors), f"Phone seek was not denied: {out_phone}"
    assert room['media']['currentTime'] == 10.0, f"Phone seek modified currentTime! Got {room['media']['currentTime']}"
    print('Check 4 (Phone seek action denied and blocked): PASS')

    # 6. PC attempts seek
    out_pc = handle_action(room, 'pc_client_1', {'type': 'seek', 'currentTime': 50.0})
    assert room['media']['currentTime'] == 50.0, f"PC seek failed! Got {room['media']['currentTime']}"
    print('Check 5 (PC seek action authorized): PASS')

    # 7. PC disconnects
    del room['participants']['pc_client_1']
    ensure_host(room)
    assert room['host_id'] == 'phone_client_2', f"Phone was not promoted after PC left: {room.get('host_id')}"
    print('Check 6 (Phone promoted when PC leaves): PASS')

    # 8. PC refreshes / reconnects with signed clientToken or creatorId -> reclaims host!
    token = sign_client_token('test_room', 'pc_client_1')
    verified_cid = verify_client_token('test_room', token)
    assert verified_cid == 'pc_client_1', f"Token verification failed: {verified_cid}"
    add_participant(room, verified_cid, {'username': 'Mert Can Yıldız', 'uid': 'uid_mert_pc'}, 'http')
    assert room['host_id'] == 'pc_client_1', f"Creator did not reclaim host on refresh! Got {room.get('host_id')}"
    out_pause = handle_action(room, 'pc_client_1', {'type': 'pause', 'currentTime': 50.0})
    assert room['media']['playing'] is False, "Creator could not pause after refresh!"
    print('Check 7 (Creator preserves/reclaims host on page refresh & can pause): PASS')

    print('ALL BACKEND ROOM TESTS PASSED!')

if __name__ == '__main__':
    test_room_host_authorization()
