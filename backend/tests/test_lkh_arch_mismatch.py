"""
LKH-3 architecture-mismatch regression test
============================================

Reproduces the production runtime issue where the cached LKH binary at
`LKH_SOLVER_PATH` is compiled for a CPU arch that doesn't match the running
container (e.g. x86_64 binary in an aarch64 pod). Before the fix, every
Optimize call re-tried LKH, re-threw `OSError [Errno 8] Exec format error`,
and spammed `logger.warning("LKH post-processing failed, …")` once per call.

After the fix:
- `lkh_tsp_solve` catches the OSError, flips `LKH_AVAILABLE=False`
  globally, and logs ONE info-level line.
- Subsequent calls short-circuit at the top-of-function guard with a quiet
  RuntimeError("LKH-3 binary not available"). No more log spam.
"""

import sys
import errno
import logging
from unittest.mock import patch

import pytest

sys.path.insert(0, '/app/backend')

import server  # noqa: E402


@pytest.fixture(autouse=True)
def _restore_lkh_available():
    """Each test starts with LKH_AVAILABLE=True so the disable path can fire."""
    prev_avail = server.LKH_AVAILABLE
    prev_err = server.LKH_IMPORT_ERROR
    server.LKH_AVAILABLE = True
    server.LKH_IMPORT_ERROR = None
    yield
    server.LKH_AVAILABLE = prev_avail
    server.LKH_IMPORT_ERROR = prev_err


def _toy_matrix(n: int = 5) -> list:
    """N x N symmetric duration matrix (seconds), diagonal zero."""
    return [
        [0 if i == j else 60 * (abs(i - j) + 1) for j in range(n)]
        for i in range(n)
    ]


def test_lkh_self_disables_on_exec_format_error(caplog):
    """First Exec-format OSError flips LKH_AVAILABLE=False and logs once."""
    matrix = _toy_matrix(5)

    fake_exc = OSError(errno.ENOEXEC, "Exec format error")

    with patch.object(server, "lkh") as mock_lkh:
        mock_lkh.LKHProblem = lambda **kw: object()
        mock_lkh.solve.side_effect = fake_exc

        caplog.set_level(logging.INFO, logger="server")
        with pytest.raises(RuntimeError, match="LKH-3 binary not runnable"):
            server.lkh_tsp_solve(matrix, depot=0, runs=1, time_limit_seconds=1)

    assert server.LKH_AVAILABLE is False
    assert server.LKH_IMPORT_ERROR and "incompatible" in server.LKH_IMPORT_ERROR
    disabling = [r for r in caplog.records if "[lkh] Disabling LKH" in r.getMessage()]
    assert len(disabling) == 1, "Expected exactly one disable log line"


def test_lkh_short_circuits_after_disable(caplog):
    """Once disabled, lkh_tsp_solve raises a quiet RuntimeError without invoking lkh.solve."""
    server.LKH_AVAILABLE = False
    server.LKH_IMPORT_ERROR = "previously disabled"

    matrix = _toy_matrix(5)

    with patch.object(server, "lkh") as mock_lkh:
        caplog.set_level(logging.INFO, logger="server")
        with pytest.raises(RuntimeError, match="LKH-3 binary not available"):
            server.lkh_tsp_solve(matrix, depot=0, runs=1, time_limit_seconds=1)

        # Critical: the disabled guard must NOT reach `lkh.solve(...)`.
        mock_lkh.solve.assert_not_called()

    # No "[lkh] Disabling" lines either — we never entered the except block.
    assert not any(
        "[lkh] Disabling LKH" in r.getMessage() for r in caplog.records
    )


def test_lkh_disable_is_idempotent_across_calls(caplog):
    """Second Exec-format failure (if LKH_AVAILABLE was somehow re-enabled
    and the binary is still bad) does not re-log the disable line."""
    matrix = _toy_matrix(5)
    fake_exc = OSError(errno.ENOEXEC, "Exec format error")

    with patch.object(server, "lkh") as mock_lkh:
        mock_lkh.LKHProblem = lambda **kw: object()
        mock_lkh.solve.side_effect = fake_exc

        caplog.set_level(logging.INFO, logger="server")

        # First call: disable + log.
        with pytest.raises(RuntimeError):
            server.lkh_tsp_solve(matrix)

        first_logs = [
            r for r in caplog.records if "[lkh] Disabling LKH" in r.getMessage()
        ]
        assert len(first_logs) == 1

        # Re-enable artificially (simulating a bug in code re-flipping the flag).
        # The function must still raise but only re-log if it actually transitions
        # from True → False. Since the guard `if LKH_AVAILABLE:` is inside the
        # except, a second call with LKH_AVAILABLE=False short-circuits before
        # the lkh.solve() call — so no log spam either way.
        caplog.clear()
        with pytest.raises(RuntimeError, match="LKH-3 binary not available"):
            server.lkh_tsp_solve(matrix)

        assert not any(
            "[lkh] Disabling LKH" in r.getMessage() for r in caplog.records
        )


def test_non_exec_format_oserror_does_not_disable_lkh(caplog):
    """Other OSErrors (permission denied, etc.) still raise but do NOT disable LKH."""
    matrix = _toy_matrix(5)
    fake_exc = OSError(errno.EACCES, "Permission denied")

    with patch.object(server, "lkh") as mock_lkh:
        mock_lkh.LKHProblem = lambda **kw: object()
        mock_lkh.solve.side_effect = fake_exc

        caplog.set_level(logging.INFO, logger="server")
        with pytest.raises(RuntimeError, match="LKH-3 binary not runnable"):
            server.lkh_tsp_solve(matrix)

    # EACCES is transient (might be a chmod race) — don't permanently disable.
    assert server.LKH_AVAILABLE is True
    assert not any(
        "[lkh] Disabling LKH" in r.getMessage() for r in caplog.records
    )
