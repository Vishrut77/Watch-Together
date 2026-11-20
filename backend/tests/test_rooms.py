import jwt

from app.core.config import settings
from app.database.database import SessionLocal
from app.models import Room
from tests.conftest import join, make_room


def test_create_room_makes_caller_the_owner(client):
    code, owner = make_room(client)
    assert len(code) == 6 and owner.role == "owner" and owner.invite
    r = client.get(f"/api/rooms/{code}")
    assert r.status_code == 200 and r.json()["name"] == "Movie Night"


def test_create_room_validation_is_friendly(client):
    r = client.post("/api/rooms", json={"name": "   ", "nickname": "A", "client_id": "abcdefgh1"})
    assert r.status_code == 422 and "empty" in r.json()["detail"]
    r = client.post("/api/rooms", json={"name": "X", "nickname": "A", "client_id": "abcdefgh1", "max_participants": 500})
    assert r.status_code == 422


def test_password_is_hashed(client):
    code, _ = make_room(client, password="hunter22")
    with SessionLocal() as db:
        stored = db.get(Room, code).password_hash
    assert stored.startswith("scrypt$") and "hunter22" not in stored


def test_public_rooms_listed_private_hidden(client):
    pub, _ = make_room(client, name="Public One", client_id="owner-client-aaa")
    priv, _ = make_room(client, name="Secret One", is_public=False, client_id="owner-client-bbb")
    names = [r["name"] for r in client.get("/api/rooms").json()]
    assert "Public One" in names and "Secret One" not in names


def test_unknown_room_is_404(client):
    assert client.get("/api/rooms/ZZZZZZ").status_code == 404
    r = client.post("/api/rooms/ZZZZZZ/join", json={"nickname": "A", "client_id": "abcdefgh1"})
    assert r.status_code == 404 and "couldn't find" in r.json()["detail"]


def test_join_by_code_is_case_insensitive(client):
    code, _ = make_room(client)
    join(client, code.lower(), "Sam")


def test_private_room_rejects_without_invite_or_password(client):
    code, owner = make_room(client, is_public=False)
    r = join(client, code, "Eve", expect=403)
    assert "private" in r.json()["detail"]
    join(client, code, "Ann", invite_token=owner.invite)  # valid invite works
    r = join(client, code, "Mal", invite_token="not-the-token", expect=403)


def test_private_room_with_password(client):
    code, _ = make_room(client, is_public=False, password="letmein1")
    assert join(client, code, "A", expect=401).status_code == 401
    assert join(client, code, "B", password="wrong-pass", expect=401).status_code == 401
    join(client, code, "C", password="letmein1")


def test_public_room_with_password_still_needs_it(client):
    code, owner = make_room(client, password="letmein1")
    join(client, code, "A", expect=401)
    join(client, code, "B", password="letmein1")


def test_capacity_limit(client):
    code, _ = make_room(client, max_participants=2)
    join(client, code, "A")
    r = join(client, code, "B", expect=409)
    assert "full" in r.json()["detail"]


def test_same_device_rejoining_does_not_use_a_second_seat(client):
    code, _ = make_room(client, max_participants=2)
    join(client, code, "A", client_id="same-device-0001")
    join(client, code, "A", client_id="same-device-0001")


def test_duplicate_nicknames_are_made_unique(client):
    code, _ = make_room(client, nickname="Sam")
    p = client.post(f"/api/rooms/{code}/join", json={"nickname": "Sam", "client_id": "other-device-1"}).json()
    assert p["participant"]["nickname"] == "Sam (2)"


def test_locked_room_blocks_new_joiners_but_not_owner(client):
    code, owner = make_room(client)
    assert client.post(f"/api/rooms/{code}/lock", headers=owner.headers).status_code == 200
    r = join(client, code, "Late", expect=403)
    assert "locked" in r.json()["detail"]
    again = client.post(f"/api/rooms/{code}/join", json={"nickname": "Owner", "client_id": owner.client_id})
    assert again.status_code == 200 and again.json()["participant"]["role"] == "owner"
    client.post(f"/api/rooms/{code}/unlock", headers=owner.headers)
    join(client, code, "Late")


def test_leave_frees_the_seat(client):
    code, _ = make_room(client, max_participants=2)
    a = join(client, code, "A")
    assert client.post(f"/api/rooms/{code}/leave", headers=a.headers).status_code == 204
    join(client, code, "B")


def test_token_endpoint_requires_membership(client):
    code, owner = make_room(client)
    other, _ = make_room(client, client_id="owner-client-zzz")
    assert client.post(f"/api/rooms/{code}/token").status_code == 401
    assert client.post(f"/api/rooms/{code}/token", headers={"Authorization": "Bearer junk"}).status_code == 401
    _, stranger = other, _
    r = client.post(f"/api/rooms/{other}/token", headers=owner.headers)  # owner token is for a different room
    assert r.status_code == 401


def test_livekit_token_grants_follow_backend_roles(client):
    code, owner = make_room(client)
    guest = join(client, code, "Guest")

    def grants(person):
        r = client.post(f"/api/rooms/{code}/token", headers=person.headers)
        assert r.status_code == 200, r.text
        body = r.json()
        claims = jwt.decode(body["token"], settings.livekit_api_secret, algorithms=["HS256"], options={"verify_aud": False})
        assert claims["sub"] == person.id and claims["exp"] - claims["nbf"] <= settings.livekit_token_ttl_minutes * 60 + 5
        return claims["video"], body

    g, body = grants(guest)
    assert g["room"] == f"wt-{code}" and g["canPublish"] and not g.get("canPublishData")
    assert "screen_share" not in g["canPublishSources"]  # default mode is hosts_only
    assert body["url"] == settings.livekit_url
    og, _ = grants(owner)
    assert "screen_share" in og["canPublishSources"]

    client.patch(f"/api/rooms/{code}/settings", headers=owner.headers, json={"screen_share_mode": "everyone"})
    g, _ = grants(guest)
    assert "screen_share" in g["canPublishSources"]
    client.patch(f"/api/rooms/{code}/settings", headers=owner.headers, json={"camera_enabled": False})
    g, _ = grants(guest)
    assert "camera" not in g["canPublishSources"]
    og, _ = grants(owner)
    assert "camera" in og["canPublishSources"]


def test_participants_list_requires_membership(client):
    code, owner = make_room(client)
    join(client, code, "Guest")
    assert client.get(f"/api/rooms/{code}/participants").status_code == 401
    r = client.get(f"/api/rooms/{code}/participants", headers=owner.headers)
    assert [p["nickname"] for p in r.json()] == ["Owner", "Guest"]


def test_health(client):
    assert client.get("/health").json()["status"] == "ok"


def test_rate_limiting(client, monkeypatch):
    monkeypatch.setattr(settings, "rate_limit_enabled", True)
    codes = []
    for i in range(6):
        r = client.post("/api/rooms", json={"name": f"R{i}", "nickname": "A", "client_id": f"client-id-{i:04d}"})
        codes.append(r.status_code)
    assert codes[:6].count(201) == 6
    r = client.post("/api/rooms", json={"name": "R7", "nickname": "A", "client_id": "client-id-9999"})
    assert r.status_code == 429
