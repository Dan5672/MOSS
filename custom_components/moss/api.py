"""A small client for MOSS's Home Assistant API (/api/ha/v1)."""

from __future__ import annotations

import asyncio
import hashlib
import ssl
from typing import Any

import aiohttp


class MossError(Exception):
    """MOSS answered with an error, or couldn't be reached."""


class MossAuthError(MossError):
    """The token is wrong or has been revoked."""


class MossCertError(MossError):
    """MOSS's certificate isn't trusted (usually: it's MOSS's own certificate authority)."""


def ssl_context(ca_pem: str) -> ssl.SSLContext:
    """Trusts MOSS's own certificate authority (on top of the usual ones). Blocking: run it in an executor."""
    return ssl.create_default_context(cadata=ca_pem)


def fingerprint(ca_pem: str) -> str:
    """SHA-256 fingerprint as MOSS shows it in Settings, HTTPS (AA:BB:...)."""
    digest = hashlib.sha256(ssl.PEM_cert_to_DER_cert(ca_pem)).hexdigest().upper()
    return ":".join(digest[i : i + 2] for i in range(0, len(digest), 2))


async def fetch_ca(session: aiohttp.ClientSession, url: str) -> str:
    """MOSS's CA certificate, from https://<moss>/moss-ca.crt. It's public; the person checks its fingerprint."""
    try:
        async with asyncio.timeout(15):
            async with session.get(url.rstrip("/") + "/moss-ca.crt", ssl=False) as resp:
                text = await resp.text()
    except (aiohttp.ClientError, TimeoutError) as err:
        raise MossError(f"Can't fetch MOSS's certificate: {err}") from err
    if resp.status != 200 or "-----BEGIN CERTIFICATE-----" not in text:
        raise MossError("MOSS didn't offer its certificate")
    start = text.index("-----BEGIN CERTIFICATE-----")
    end = text.index("-----END CERTIFICATE-----") + len("-----END CERTIFICATE-----")
    return text[start:end] + "\n"


class MossApi:
    """Talks to one MOSS install with one integration token."""

    def __init__(self, session: aiohttp.ClientSession, url: str, token: str, verify_ssl: bool = True, context: ssl.SSLContext | None = None) -> None:
        self._session = session
        self._base = url.rstrip("/") + "/api/ha/v1/"
        self._token = token
        self._ssl: ssl.SSLContext | bool | None = context if context is not None else (None if verify_ssl else False)

    async def _request(self, method: str, path: str, *, json: dict[str, Any] | None = None, params: dict[str, str] | None = None) -> Any:
        try:
            async with asyncio.timeout(30):
                async with self._session.request(
                    method,
                    self._base + path,
                    json=json,
                    params=params,
                    headers={"Authorization": f"Bearer {self._token}"},
                    ssl=self._ssl,
                ) as resp:
                    data = await resp.json(content_type=None) if resp.content_length != 0 else {}
                    if resp.status == 401:
                        raise MossAuthError((data or {}).get("error", "Invalid token"))
                    if resp.status >= 400:
                        raise MossError((data or {}).get("error", f"MOSS answered HTTP {resp.status}"))
                    return data
        except aiohttp.ClientConnectorCertificateError as err:
            raise MossCertError(f"MOSS's certificate isn't trusted: {err}") from err
        except (aiohttp.ClientError, TimeoutError, ValueError) as err:
            raise MossError(f"Can't reach MOSS: {err}") from err

    async def state(self) -> dict[str, Any]:
        return await self._request("GET", "state")

    async def events(self, after: int | None) -> dict[str, Any]:
        return await self._request("GET", "events", params=None if after is None else {"after": str(after)})

    async def calendar(self, start: str, end: str) -> list[dict[str, Any]]:
        return (await self._request("GET", "calendar", params={"start": start, "end": end}))["events"]

    async def agents(self) -> list[dict[str, Any]]:
        return (await self._request("GET", "agents"))["agents"]

    async def post(self, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        return await self._request("POST", path, json=body or {})

    async def ask(self, agent: str, question: str, timeout: float = 120) -> dict[str, Any]:
        """Ask an agent something and wait for its answer (it runs as a normal MOSS chat run)."""
        started = await self.post("ask", {"agent": agent, "question": question})
        conversation, since = started["conversationId"], started["since"]
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while loop.time() < deadline:
            await asyncio.sleep(3)
            reply = await self._request("GET", f"ask/{conversation}", params={"since": since})
            if reply.get("done"):
                return {"agent": started["agent"], "reply": reply["reply"], "status": reply.get("status", "succeeded")}
        return {
            "agent": started["agent"],
            "reply": f"{started['agent']} is still working on it. The answer will be in your MOSS chat.",
            "status": "pending",
        }
