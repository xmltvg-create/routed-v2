"""
install_native_solvers.py — Runtime installer for LKH + Java-17 in the prod container.

Why this exists:
  The Emergent production Docker image doesn't ship the LKH binary or a Java
  runtime. Since we can't modify the Dockerfile, we install these at server
  startup in a background thread so the FastAPI health check isn't blocked.

  Two solvers benefit:
    • LKH-3     (C binary compiled from source, ~1.8 MB, ~20s compile)
    • Timefold  (JVM-based — needs openjdk-17-jre-headless, ~60 MB apt install)

  When each install succeeds, the caller-supplied callbacks flip the module
  flags `LKH_AVAILABLE` / `TIMEFOLD_AVAILABLE` in server.py, and the next
  /api/benchmark call includes those solvers.

Design notes:
  - Idempotent: each installer short-circuits if already present
  - Silent failure: if any step fails (no network, apt lock, gcc missing),
    we log and degrade gracefully — benchmark just skips the affected solver
  - Java: apt-get download depends on container having outbound HTTP to
    Debian mirrors; it works in Emergent's cloud image
"""

import importlib
import logging
import os
import subprocess
import threading
import urllib.request

logger = logging.getLogger(__name__)

# Persistent cache on /app (dedicated PVC) — survives pod restarts. Falls back
# to /usr/local/bin + /opt if /app/backend isn't writable (tests, local dev).
_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
NATIVE_CACHE_DIR = os.path.join(_BACKEND_DIR, ".native_cache")
try:
    os.makedirs(NATIVE_CACHE_DIR, exist_ok=True)
    _CACHE_WRITABLE = os.access(NATIVE_CACHE_DIR, os.W_OK)
except Exception:
    _CACHE_WRITABLE = False

# --- LKH ---------------------------------------------------------------------
LKH_BIN_PATH = (
    os.path.join(NATIVE_CACHE_DIR, "bin", "LKH") if _CACHE_WRITABLE
    else "/usr/local/bin/LKH"
)
LKH_VERSION = "3.0.11"
LKH_SOURCE_URL = f"http://webhotel4.ruc.dk/~keld/research/LKH-3/LKH-{LKH_VERSION}.tgz"
LKH_WORK_DIR = "/tmp/lkh-install"

# Lock to prevent concurrent LKH rebuild attempts (multiple threads/restarts)
_lkh_install_lock = threading.Lock()
# Track whether we already logged the ENOEXEC warning this process lifetime
_lkh_enoexec_warned = False

# --- Java 17 -----------------------------------------------------------------
# Debian-bookworm on arm64 ships openjdk-17 at this path
JAVA_HOME_CANDIDATES = [
    os.path.join(NATIVE_CACHE_DIR, "jdk-17"),  # our persistent install (preferred)
    "/opt/jdk-17",                              # legacy ephemeral fallback
    "/usr/lib/jvm/java-17-openjdk-arm64",
    "/usr/lib/jvm/java-17-openjdk-amd64",
    "/usr/lib/jvm/default-java",
]


def _run(cmd: list[str], cwd: str | None = None, timeout: int = 120) -> None:
    subprocess.run(
        cmd, cwd=cwd, timeout=timeout, check=True,
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )


# =============================================================================
# LKH
# =============================================================================
def _lkh_is_installed() -> bool:
    return os.path.isfile(LKH_BIN_PATH) and os.access(LKH_BIN_PATH, os.X_OK)


def _lkh_binary_runnable() -> bool:
    """Verify the cached LKH binary is actually executable on this CPU.

    `_lkh_is_installed()` only checks the file exists + has +x; that's a
    necessary but insufficient signal. A binary compiled for a different
    arch (e.g. an x86_64 LKH cached on a PVC then mounted into an aarch64
    pod after a fork) still passes the +x check but raises
    `OSError [Errno 8] Exec format error` the moment subprocess tries to
    exec it. Run a 1-byte stdin invocation and look specifically for that
    failure mode — anything else (LKH printing its banner, exiting with
    a non-zero status because the input is junk) means the binary runs.
    """
    global _lkh_enoexec_warned
    if not _lkh_is_installed():
        return False
    try:
        subprocess.run(
            [LKH_BIN_PATH],
            input=b"",
            timeout=5,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return True
    except OSError as exc:
        # errno 8 == ENOEXEC == "Exec format error". Cached binary is wrong arch.
        import errno as _errno
        if exc.errno in (_errno.ENOEXEC, 8):
            if not _lkh_enoexec_warned:
                _lkh_enoexec_warned = True
                logger.warning(
                    "[lkh-installer] cached binary at %s is incompatible with this "
                    "CPU arch (errno=ENOEXEC). Triggering rebuild from source.",
                    LKH_BIN_PATH,
                )
            return False
        return False
    except subprocess.TimeoutExpired:
        return True
    except Exception:
        return True


def _install_lkh_sync() -> bool:
    if _lkh_is_installed() and _lkh_binary_runnable():
        logger.info("[lkh-installer] runnable binary present at %s — skipping", LKH_BIN_PATH)
        return True

    # Acquire lock to prevent concurrent rebuild attempts from multiple
    # threads (server startup check + background installer can race).
    if not _lkh_install_lock.acquire(blocking=False):
        logger.info("[lkh-installer] another thread is already compiling — waiting")
        _lkh_install_lock.acquire()  # block until the other thread finishes
        _lkh_install_lock.release()
        # Re-check — the other thread may have succeeded.
        return _lkh_is_installed() and _lkh_binary_runnable()

    try:
        return _install_lkh_sync_locked()
    finally:
        _lkh_install_lock.release()


def _install_lkh_sync_locked() -> bool:
    """Actual LKH compilation. Caller must hold _lkh_install_lock."""
    # Re-check after acquiring lock — another thread may have just finished.
    if _lkh_is_installed() and _lkh_binary_runnable():
        return True

    # Either no binary or one that won't exec on this CPU — wipe + recompile.
    if os.path.isfile(LKH_BIN_PATH):
        try:
            os.remove(LKH_BIN_PATH)
            logger.info("[lkh-installer] removed stale/incompatible binary at %s", LKH_BIN_PATH)
        except Exception as e:
            logger.warning("[lkh-installer] could not remove stale binary: %s", e)
    # Also clear the /usr/local/bin/LKH symlink if it points at the same stale file.
    try:
        alias = "/usr/local/bin/LKH"
        if os.path.islink(alias) and not os.path.exists(os.path.realpath(alias)):
            os.unlink(alias)
    except Exception:
        pass

    for tool in ("gcc", "make"):
        if subprocess.call(["which", tool], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) != 0:
            logger.warning("[lkh-installer] %s not available — cannot compile LKH", tool)
            return False

    os.makedirs(LKH_WORK_DIR, exist_ok=True)
    tarball = os.path.join(LKH_WORK_DIR, f"LKH-{LKH_VERSION}.tgz")
    src_dir = os.path.join(LKH_WORK_DIR, f"LKH-{LKH_VERSION}")

    try:
        logger.info("[lkh-installer] downloading LKH %s source...", LKH_VERSION)
        urllib.request.urlretrieve(LKH_SOURCE_URL, tarball)
        logger.info("[lkh-installer] extracting...")
        _run(["tar", "xzf", tarball, "-C", LKH_WORK_DIR], timeout=30)
        logger.info("[lkh-installer] compiling with `make` (~20s)...")
        _run(["make"], cwd=src_dir, timeout=360)

        compiled = os.path.join(src_dir, "LKH")
        if not os.path.isfile(compiled):
            logger.warning("[lkh-installer] compile finished but %s missing", compiled)
            return False
        # Ensure the destination dir exists (e.g. /app/backend/.native_cache/bin)
        os.makedirs(os.path.dirname(LKH_BIN_PATH), exist_ok=True)
        _run(["install", "-m", "755", compiled, LKH_BIN_PATH], timeout=10)
        # Also expose on PATH for code paths that shell out to "LKH" without a
        # full path (e.g. the `lkh` python package). Symlink into /usr/local/bin
        # if writable; silently skip on read-only overlays.
        try:
            alias = "/usr/local/bin/LKH"
            if LKH_BIN_PATH != alias and not os.path.exists(alias):
                os.symlink(LKH_BIN_PATH, alias)
        except Exception:
            pass
        logger.info("[lkh-installer] OK — LKH installed at %s", LKH_BIN_PATH)
        return True
    except subprocess.TimeoutExpired as e:
        logger.warning("[lkh-installer] step timed out: %s", e)
        return False
    except subprocess.CalledProcessError as e:
        stderr = (e.stderr or b"").decode("utf-8", errors="replace")[:500]
        logger.warning("[lkh-installer] command failed (%s): %s", e.cmd, stderr)
        return False
    except Exception as e:
        logger.warning("[lkh-installer] unexpected failure: %s", e)
        return False


# =============================================================================
# Java 17 + Timefold
# =============================================================================
def _detect_java_home() -> str | None:
    for candidate in JAVA_HOME_CANDIDATES:
        if os.path.isfile(os.path.join(candidate, "bin", "java")):
            return candidate
    return None


def _install_java_sync() -> str | None:
    """Install OpenJDK 17 JRE and return the JAVA_HOME path.

    Strategy: try apt-get first (fast, ~60 s on Debian where the package
    exists), fall back to a static Adoptium Temurin tarball download that
    works regardless of the container's apt sources (used in the Emergent
    production image where openjdk-17 isn't in /etc/apt/sources.list).
    """
    detected = _detect_java_home()
    if detected:
        logger.info("[jdk-installer] Java already present at %s — skipping", detected)
        return detected

    # Attempt 1 — apt-get (fast, native package manager)
    detected = _try_apt_install_jdk()
    if detected:
        return detected

    # Attempt 2 — static Temurin tarball (works where apt doesn't have the pkg)
    detected = _try_temurin_tarball_install()
    if detected:
        return detected

    logger.warning("[jdk-installer] both apt-get and tarball install failed — Timefold will stay disabled")
    return None


def _try_apt_install_jdk() -> str | None:
    if subprocess.call(["which", "apt-get"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) != 0:
        return None
    try:
        logger.info("[jdk-installer] trying apt-get install openjdk-17-jre-headless...")
        env = {**os.environ, "DEBIAN_FRONTEND": "noninteractive"}
        subprocess.run(
            ["apt-get", "install", "-y", "--no-install-recommends", "openjdk-17-jre-headless"],
            timeout=300, check=True,
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=env,
        )
        detected = _detect_java_home()
        if detected:
            logger.info("[jdk-installer] apt-get OK — JAVA_HOME=%s", detected)
            return detected
        logger.warning("[jdk-installer] apt-get returned success but JAVA_HOME not detectable")
        return None
    except subprocess.TimeoutExpired:
        logger.warning("[jdk-installer] apt-get timed out after 5 min")
        return None
    except subprocess.CalledProcessError as e:
        stderr = (e.stderr or b"").decode("utf-8", errors="replace")[:500]
        logger.warning("[jdk-installer] apt-get failed: %s", stderr)
        return None
    except Exception as e:
        logger.warning("[jdk-installer] apt-get unexpected failure: %s", e)
        return None


# Pinned LTS; arm64 = aarch64 CPU, x64 = x86_64. URL encode '+' as %2B.
TEMURIN_VERSION = "17.0.13+11"
TEMURIN_VERSION_URL = "17.0.13%2B11"
TEMURIN_VERSION_FILE = "17.0.13_11"
# Prefer persistent install on /app so replicas + restarts skip the ~30s download
TEMURIN_INSTALL_DIR = (
    os.path.join(NATIVE_CACHE_DIR, "jdk-17") if _CACHE_WRITABLE
    else "/opt/jdk-17"
)


def _temurin_arch() -> str | None:
    """Map Python's uname -m to Temurin's release-asset architecture slug."""
    import platform
    m = platform.machine().lower()
    if m in ("aarch64", "arm64"):
        return "aarch64"
    if m in ("x86_64", "amd64"):
        return "x64"
    return None


def _try_temurin_tarball_install() -> str | None:
    arch = _temurin_arch()
    if not arch:
        logger.warning("[jdk-installer] unsupported CPU arch for Temurin fallback")
        return None

    asset = f"OpenJDK17U-jre_{arch}_linux_hotspot_{TEMURIN_VERSION_FILE}.tar.gz"
    url = (
        "https://github.com/adoptium/temurin17-binaries/releases/download/"
        f"jdk-{TEMURIN_VERSION_URL}/{asset}"
    )
    tarball = f"/tmp/{asset}"

    try:
        logger.info("[jdk-installer] downloading Temurin JRE 17 (%s, ~45 MB) from Adoptium...", arch)
        urllib.request.urlretrieve(url, tarball)

        logger.info("[jdk-installer] extracting to %s...", TEMURIN_INSTALL_DIR)
        os.makedirs(TEMURIN_INSTALL_DIR, exist_ok=True)
        _run(["tar", "xzf", tarball, "-C", TEMURIN_INSTALL_DIR, "--strip-components=1"], timeout=60)

        java_bin = os.path.join(TEMURIN_INSTALL_DIR, "bin", "java")
        if not os.path.isfile(java_bin):
            logger.warning("[jdk-installer] tarball extracted but %s missing", java_bin)
            return None

        # Add to JAVA_HOME_CANDIDATES so _detect_java_home picks it up on restarts
        if TEMURIN_INSTALL_DIR not in JAVA_HOME_CANDIDATES:
            JAVA_HOME_CANDIDATES.insert(0, TEMURIN_INSTALL_DIR)
        logger.info("[jdk-installer] Temurin OK — JAVA_HOME=%s", TEMURIN_INSTALL_DIR)
        return TEMURIN_INSTALL_DIR
    except Exception as e:
        logger.warning("[jdk-installer] Temurin tarball install failed: %s", e)
        return None


def _load_timefold_sync() -> bool:
    """Install Java if needed, then import timefold_solver. Returns True on success."""
    java_home = _install_java_sync()
    if not java_home:
        return False
    os.environ["JAVA_HOME"] = java_home
    try:
        # Force fresh import so JPype picks up the new JAVA_HOME
        import timefold_solver  # noqa: F401
        importlib.reload(timefold_solver)
        logger.info("[timefold-installer] OK — timefold_solver importable with JDK %s", java_home)
        return True
    except Exception as e:
        # Timefold is one of 12+ available solvers — its absence is a planned
        # graceful-degradation path, not an error. The JVM-DLL-not-found case
        # in particular is expected on Emergent's prod image where the JDK
        # tarball lands but isn't process-resolvable. Keep the log line short
        # and uncluttered so deploy logs read clean.
        if "JVM DLL not found" in str(e) or "JVM is not running" in str(e):
            logger.info("[timefold-installer] Timefold disabled (JVM not available in this container) — using OR-Tools/VROOM/PyVRP/etc. instead")
        else:
            logger.warning("[timefold-installer] timefold_solver unavailable after JDK install: %s", e)
        return False


# =============================================================================
# Public API — background thread launchers
# =============================================================================
def ensure_lkh_installed_background(on_complete=None) -> None:
    if _lkh_is_installed() and _lkh_binary_runnable():
        if on_complete:
            on_complete(True)
        return

    def _worker():
        ok = _install_lkh_sync()
        if on_complete:
            try:
                on_complete(ok)
            except Exception as e:
                logger.warning("[lkh-installer] on_complete callback failed: %s", e)

    threading.Thread(target=_worker, name="lkh-installer", daemon=True).start()


def ensure_timefold_installed_background(on_complete=None) -> None:
    def _worker():
        ok = _load_timefold_sync()
        if on_complete:
            try:
                on_complete(ok)
            except Exception as e:
                logger.warning("[timefold-installer] on_complete callback failed: %s", e)

    threading.Thread(target=_worker, name="timefold-installer", daemon=True).start()
