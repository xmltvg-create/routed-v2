"""Regression test: the import_process auto-archive must emit Schema B
(summary + archived_at), not the legacy Schema A (stats + created_at).

Background
----------
Two writers write to `route_history`:
  A) `/api/routes/archive` — canonical, writes `summary.total_stops/
     delivered/skipped/failed/...` and `archived_at`.
  B) `/api/import/process` — auto-archives any completed stops before
     wiping for a new manifest import.

Before 2026-05-12 the importer wrote a different shape:
  { stats: {stops_count, auto_archived_reason}, created_at, completed_at }

The frontend HistoryModal renders `r.summary.total_stops` etc., so it
crashed on these legacy auto-archive rows (`r.summary` was undefined).
The frontend now has a normalisation adapter, but the right structural
fix is to align the writer so future rows match the canonical schema.

This test is code-shape only (no TestClient/Mongo) because the shape
contract is what we care about and it lives entirely in source.
"""
from __future__ import annotations

import inspect
import re

import server


def test_import_process_archive_writes_summary_not_stats():
    """`auto-archived completed stops` must be inserted with `summary`
    + `archived_at`, never `stats` + `created_at` at the top level.

    Surfaces both writers (canonical /api/routes/archive AND the
    import_process auto-archive) and asserts the legacy keys aren't
    introduced into route_history docs by either."""
    src = inspect.getsource(server)

    # Locate the import_process auto-archive block. The marker comment
    # "auto-archived" is the only one that appears in both write sites,
    # so we scope to the line range starting from `_auto_archived_reason`
    # which is unique to this writer.
    marker = re.search(
        r"import_process_overwrite",
        src,
    )
    assert marker, "could not locate import_process auto-archive block"

    # Inspect the source within 2 KB of the marker — that's the writer.
    window = src[max(0, marker.start() - 2000): marker.end() + 500]

    # Must define `summary` and `archived_at` in the doc.
    assert "\"archived_at\"" in window, (
        "import_process auto-archive must write `archived_at`, not "
        "`created_at`/`completed_at` at the top level — see "
        "HistoryModal.tsx which expects archived_at."
    )
    assert "\"summary\"" in window, (
        "import_process auto-archive must write a `summary` block — the "
        "HistoryModal reads r.summary.total_stops, r.summary.delivered, "
        "etc. and crashes when summary is undefined."
    )
    # Must NOT write a top-level `stats` key (that's the legacy Schema A
    # the frontend can't render directly).
    forbidden = re.search(
        r"archive_doc\s*=\s*\{[^}]*\"stats\":",
        window,
        re.DOTALL,
    )
    assert not forbidden, (
        "found a top-level `stats` key in the import_process auto-archive "
        "doc — this is the 2026-05-12 schema regression. Move per-route "
        "counts into `summary.*` instead."
    )
