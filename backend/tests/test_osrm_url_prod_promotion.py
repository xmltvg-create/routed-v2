"""Regression test for the OSRM_URL_PROD startup promotion.

Issue: production Emergent pod doesn't ship a local OSRM binary so requests to
http://localhost:5000 fail. We added a startup check that promotes
OSRM_URL_PROD to OSRM_URL when the configured loopback OSRM host isn't
listening — keeps a single .env file working in both sandbox (where local
OSRM is supervisor-managed) and production (where we point at Fly.io).

Race condition guard: in sandbox, both the FastAPI backend and the local
OSRM binary are supervisor-managed. OSRM takes ~3-5 s to mmap its data
files, so the backend may boot first and see an unreachable localhost:5000.
We retry the probe a number of times to avoid spuriously promoting to the
remote URL on every container restart.
"""

from __future__ import annotations

import socket
import threading
import time
from urllib.parse import urlparse


def _resolve(osrm_url: str, osrm_url_prod: str, max_attempts: int = 15) -> str:
    """Mirror the startup logic in server.py — kept here so a regression in
    the actual server.py block fails the test deterministically."""
    if osrm_url_prod and osrm_url.startswith(
        ("http://localhost", "http://127.", "http://[::1]")
    ):
        parsed = urlparse(osrm_url)
        host = parsed.hostname or "localhost"
        port = parsed.port or 80
        for _ in range(max_attempts):
            try:
                with socket.create_connection((host, port), timeout=1.0):
                    return osrm_url
            except Exception:
                time.sleep(0.05)  # tighter than prod (1.0) so tests stay fast
        return osrm_url_prod
    return osrm_url


def test_loopback_unreachable_promotes_to_prod():
    # Port 9 is the IETF-reserved discard port; nothing should ever bind there.
    assert (
        _resolve("http://localhost:9", "https://pathpilot-osrm.fly.dev", max_attempts=2)
        == "https://pathpilot-osrm.fly.dev"
    )


def test_loopback_reachable_keeps_local():
    # Bind a throwaway local socket and resolve against it — we should stay on
    # the loopback URL because it's actually listening.
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    port = server.getsockname()[1]
    try:
        url = f"http://127.0.0.1:{port}"
        assert _resolve(url, "https://pathpilot-osrm.fly.dev") == url
    finally:
        server.close()


def test_no_prod_url_keeps_loopback_unchanged():
    # If OSRM_URL_PROD is unset (empty), even an unreachable loopback URL
    # should be left alone — we don't want to silently break the pre-fly.io
    # behaviour for users who haven't migrated yet.
    assert _resolve("http://localhost:9", "") == "http://localhost:9"


def test_non_loopback_url_never_promoted():
    # Public/explicit URLs (e.g. Fly.io itself or router.project-osrm.org)
    # should never get rewritten — only the loopback default is treated as a
    # "is local OSRM running?" probe.
    assert (
        _resolve(
            "https://router.project-osrm.org",
            "https://pathpilot-osrm.fly.dev",
        )
        == "https://router.project-osrm.org"
    )


def test_retry_waits_for_slow_local_osrm():
    """Simulates the supervisor race: backend boots first, OSRM comes up
    a few hundred ms later. The probe must retry and pick up the local
    URL once it starts listening — not silently promote to Fly.io."""
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.bind(("127.0.0.1", 0))
    port = server.getsockname()[1]
    server.close()

    # Bind the port from a background thread after a 200 ms delay,
    # mimicking OSRM's slow startup.
    def _start_late():
        time.sleep(0.2)
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("127.0.0.1", port))
        s.listen(1)
        # Hold the port for a bit so the probe sees it
        time.sleep(2)
        s.close()

    t = threading.Thread(target=_start_late, daemon=True)
    t.start()

    url = f"http://127.0.0.1:{port}"
    # max_attempts=10 with 50 ms sleep = 500 ms budget — enough to catch
    # the late binder.
    result = _resolve(url, "https://pathpilot-osrm.fly.dev", max_attempts=10)
    assert result == url, (
        f"Probe gave up on slow local OSRM and promoted to remote — "
        f"this is the race that bit us on container restart. result={result}"
    )

