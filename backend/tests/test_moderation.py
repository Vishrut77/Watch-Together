from tests.conftest import join, make_room


def setup_room(client):
    code, owner = make_room(client)
    guest = join(client, code, "Guest")
    other = join(client, code, "Other")
    return code, owner, guest, other


def post(client, person, path):
    return client.post(path, headers=person.headers)


def test_participant_cannot_use_any_moderation_action(client):
    code, owner, guest, other = setup_room(client)
    base = f"/api/rooms/{code}"
    for action in ("mute", "kick", "ban"):
        assert post(client, guest, f"{base}/participants/{other.id}/{action}").status_code == 403
    assert post(client, guest, f"{base}/lock").status_code == 403
    assert post(client, guest, f"{base}/unlock").status_code == 403
    assert client.patch(f"{base}/settings", headers=guest.headers, json={"chat_enabled": False}).status_code == 403
    assert client.delete(base, headers=guest.headers).status_code == 403
    assert client.post(f"{base}/participants/{other.id}/permissions", headers=guest.headers, json={"permissions": ["manage_settings"]}).status_code == 403
    # nothing changed
    assert client.get(base).json()["is_locked"] is False


def test_unauthenticated_requests_are_rejected(client):
    code, owner, guest, other = setup_room(client)
    assert client.post(f"/api/rooms/{code}/participants/{other.id}/kick").status_code == 401


def test_forged_role_in_request_body_is_ignored(client):
    code, owner, guest, other = setup_room(client)
    r = client.post(
        f"/api/rooms/{code}/participants/{other.id}/kick",
        headers=guest.headers,
        json={"role": "owner", "permissions": ["remove_participants"]},
    )
    assert r.status_code == 403


def test_owner_can_mute(client, lk_calls):
    code, owner, guest, _ = setup_room(client)
    assert post(client, owner, f"/api/rooms/{code}/participants/{guest.id}/mute").status_code == 204
    assert ("mute", code, guest.id) in lk_calls


def test_owner_cannot_moderate_self(client):
    code, owner, *_ = setup_room(client)
    assert post(client, owner, f"/api/rooms/{code}/participants/{owner.id}/kick").status_code == 403


def test_kick_removes_and_token_stops_working(client, lk_calls):
    code, owner, guest, _ = setup_room(client)
    assert post(client, owner, f"/api/rooms/{code}/participants/{guest.id}/kick").status_code == 204
    assert ("remove", code, guest.id) in lk_calls
    assert client.post(f"/api/rooms/{code}/token", headers=guest.headers).status_code == 403
    join(client, code, "Guest", client_id=guest.client_id)  # kicked users may come back (ban is the permanent one)


def test_ban_is_permanent_for_that_device(client):
    code, owner, guest, _ = setup_room(client)
    assert post(client, owner, f"/api/rooms/{code}/participants/{guest.id}/ban").status_code == 204
    r = join(client, code, "NewName", client_id=guest.client_id, expect=403)
    assert "banned" in r.json()["detail"]
    assert client.post(f"/api/rooms/{code}/token", headers=guest.headers).status_code == 403


def test_owner_grants_and_revokes_cohost_permissions(client, lk_calls):
    code, owner, guest, other = setup_room(client)
    base = f"/api/rooms/{code}"
    r = client.post(f"{base}/participants/{guest.id}/permissions", headers=owner.headers, json={"permissions": ["mute_participants"]})
    assert r.status_code == 200 and r.json()["role"] == "cohost" and r.json()["permissions"] == ["mute_participants"]
    assert ("update", code, guest.id) in lk_calls
    # may mute, may NOT kick / lock (permissions are granular)
    assert post(client, guest, f"{base}/participants/{other.id}/mute").status_code == 204
    assert post(client, guest, f"{base}/participants/{other.id}/kick").status_code == 403
    assert post(client, guest, f"{base}/lock").status_code == 403
    r = client.delete(f"{base}/participants/{guest.id}/permissions", headers=owner.headers)
    assert r.json()["role"] == "participant"
    assert post(client, guest, f"{base}/participants/{other.id}/mute").status_code == 403


def test_cohost_cannot_touch_owner_or_other_cohosts(client):
    code, owner, guest, other = setup_room(client)
    base = f"/api/rooms/{code}"
    all_perms = ["remove_participants", "mute_participants", "manage_settings"]
    for p in (guest, other):
        client.post(f"{base}/participants/{p.id}/permissions", headers=owner.headers, json={"permissions": all_perms})
    assert post(client, guest, f"{base}/participants/{owner.id}/kick").status_code == 403
    assert post(client, guest, f"{base}/participants/{other.id}/kick").status_code == 403
    assert client.post(f"{base}/participants/{other.id}/permissions", headers=guest.headers, json={"permissions": ["manage_playback"]}).status_code == 403


def test_owner_permissions_cannot_be_changed(client):
    code, owner, *_ = setup_room(client)
    assert client.delete(f"/api/rooms/{code}/participants/{owner.id}/permissions", headers=owner.headers).status_code == 400


def test_invalid_permission_name_rejected(client):
    code, owner, guest, _ = setup_room(client)
    r = client.post(f"/api/rooms/{code}/participants/{guest.id}/permissions", headers=owner.headers, json={"permissions": ["make_me_god"]})
    assert r.status_code == 422


def test_cohost_with_settings_can_lock_but_only_owner_changes_password(client):
    code, owner, guest, _ = setup_room(client)
    base = f"/api/rooms/{code}"
    client.post(f"{base}/participants/{guest.id}/permissions", headers=owner.headers, json={"permissions": ["manage_settings"]})
    assert post(client, guest, f"{base}/lock").status_code == 200
    assert client.patch(f"{base}/settings", headers=guest.headers, json={"is_public": False}).status_code == 200
    assert client.patch(f"{base}/settings", headers=guest.headers, json={"password": "newpass99"}).status_code == 403
    assert client.patch(f"{base}/settings", headers=owner.headers, json={"password": "newpass99"}).status_code == 200


def test_screen_share_setting_needs_its_own_permission(client):
    code, owner, guest, _ = setup_room(client)
    base = f"/api/rooms/{code}"
    client.post(f"{base}/participants/{guest.id}/permissions", headers=owner.headers, json={"permissions": ["mute_participants"]})
    assert client.patch(f"{base}/settings", headers=guest.headers, json={"screen_share_mode": "everyone"}).status_code == 403
    client.post(f"{base}/participants/{guest.id}/permissions", headers=owner.headers, json={"permissions": ["manage_screen_share"]})
    assert client.patch(f"{base}/settings", headers=guest.headers, json={"screen_share_mode": "everyone"}).status_code == 200


def test_end_room(client, lk_calls):
    code, owner, guest, _ = setup_room(client)
    assert client.delete(f"/api/rooms/{code}", headers=owner.headers).status_code == 204
    assert ("delete", code) in lk_calls
    assert client.get(f"/api/rooms/{code}").status_code == 410
    assert client.post(f"/api/rooms/{code}/join", json={"nickname": "Z", "client_id": "late-client-1"}).status_code == 410
    assert code not in [r["id"] for r in client.get("/api/rooms").json()]
