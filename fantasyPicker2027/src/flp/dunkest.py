"""Client for the EuroLeague Fantasy Challenge API (Dunkest 'Fantaking' backend).

Auth is two-legged:
  1. password grant against EuroLeague's OAuth server -> a EuroLeague JWT
  2. that JWT exchanged at Dunkest's /social/login -> a Dunkest bearer token
The Dunkest token is what every data endpoint wants. Tokens are cached on disk
so we are not hammering the login endpoints on every run.
"""
from __future__ import annotations

import base64
import json
import time
from pathlib import Path
from typing import Any

import requests

from . import config

OAUTH_URL = "https://oauth.fanscore.com/oauth/token"
API = "https://fantaking-api.dunkest.com/api/v1"
NEWS_API = "https://article-cms-api.incrowdsports.com/v2"
FANTASY_ORIGIN = "https://euroleaguefantasy.euroleaguebasketball.net"
UA = "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0"

TOKEN_CACHE = config.DATA / ".token.json"


def _jwt_payload(token: str) -> dict[str, Any]:
    """Decode a JWT payload without verifying (we only need the claims)."""
    part = token.split(".")[1]
    part += "=" * (-len(part) % 4)
    return json.loads(base64.urlsafe_b64decode(part))


class Dunkest:
    def __init__(self) -> None:
        self.s = requests.Session()
        self.s.headers.update({"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})
        self._token: str | None = None

    # ---------- auth ----------

    def _login(self) -> dict[str, Any]:
        r = self.s.post(
            OAUTH_URL,
            data={
                "username": config.USERNAME,
                "password": config.PASSWORD,
                "grant_type": "password",
                "client_id": "EUROLEAGUE",
                "device_id": config.DEVICE_ID,
            },
            headers={
                "Accept": "application/json, text/plain, */*",
                "Content-Type": "application/x-www-form-urlencoded",
                "Origin": "https://www.euroleaguebasketball.net",
                "Referer": "https://www.euroleaguebasketball.net/",
            },
            timeout=30,
        )
        r.raise_for_status()
        el = r.json()
        jwt = el["access_token"]
        claims = _jwt_payload(jwt)

        r2 = self.s.post(
            "https://fantaking-api.dunkest.com/api/v1/social/login",
            json={
                "provider_id": str(claims["sub"]),
                "provider_name": "euroleague",
                "provider_token": jwt,
                "email": claims.get("email", config.USERNAME),
                "game_id": config.GAME_ID,
            },
            headers={
                "Accept": "*/*",
                "Content-Type": "application/json",
                "Origin": FANTASY_ORIGIN,
                "Referer": f"{FANTASY_ORIGIN}/",
            },
            timeout=30,
        )
        r2.raise_for_status()
        body = r2.json()
        token = _find_token(body)
        if not token:
            raise RuntimeError(f"no bearer token in social/login response: {list(body)}")
        # EuroLeague JWT exp is the tighter of the two lifetimes; refresh on it.
        return {"token": token, "exp": claims.get("exp", time.time() + 3600), "login": body}

    @property
    def token(self) -> str:
        if self._token:
            return self._token
        if TOKEN_CACHE.exists():
            cached = json.loads(TOKEN_CACHE.read_text())
            if cached.get("exp", 0) > time.time() + 120:
                self._token = cached["token"]
                return self._token
        fresh = self._login()
        TOKEN_CACHE.parent.mkdir(parents=True, exist_ok=True)
        TOKEN_CACHE.write_text(json.dumps({"token": fresh["token"], "exp": fresh["exp"]}))
        TOKEN_CACHE.chmod(0o600)
        self._token = fresh["token"]
        return self._token

    # ---------- requests ----------

    def get(self, path: str, **params: Any) -> Any:
        url = path if path.startswith("http") else f"{API}{path}"
        r = self.s.get(
            url,
            params=params or None,
            headers={
                "Accept": "*/*",
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.token}",
                "Origin": FANTASY_ORIGIN,
                "Referer": f"{FANTASY_ORIGIN}/",
            },
            timeout=45,
        )
        r.raise_for_status()
        return r.json()

    # ---------- endpoints ----------

    def players(self, players_list_id: str, matchday_id: str) -> Any:
        return self.get(
            f"/players-lists/{players_list_id}/matchdays/{matchday_id}/players",
            per_page=-1, page=1, sort_by="quotation", sort_order="desc",
        )

    def roster(self, team_id: str, matchday_id: str) -> Any:
        return self.get(f"/fantasy-teams/{team_id}/matchdays/{matchday_id}/roster")

    def schedule(self, players_list_id: str, matchday_id: str) -> Any:
        return self.get(f"/schedules/{players_list_id}/matchdays/{matchday_id}", lang="en")

    def lineups(self, match_id: str) -> Any:
        return self.get(f"/matches/{match_id}/lineups")

    def news(self, page: int = 1, size: int = 10) -> Any:
        return self.get(
            f"{NEWS_API}/articles", clientId="EUROLEAGUE",
            categorySlug="news", page=page, size=size,
        )


def _find_token(obj: Any) -> str | None:
    """The bearer token is nested somewhere in the login payload; go find it."""
    if isinstance(obj, dict):
        for key in ("token", "access_token", "api_token", "bearer"):
            v = obj.get(key)
            if isinstance(v, str) and len(v) > 20:
                return v
        for v in obj.values():
            found = _find_token(v)
            if found:
                return found
    elif isinstance(obj, list):
        for v in obj:
            found = _find_token(v)
            if found:
                return found
    return None
