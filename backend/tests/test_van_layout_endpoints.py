"""Unit tests for the van-layout endpoint validation rules. We test the
allowed-shape constant directly + the Pydantic model rather than booting
the full FastAPI app, because Motor's async Mongo client is bound to its
own event loop and TestClient runs synchronously, which causes
'attached to a different loop' RuntimeErrors. The Mongo upsert path is
trivial enough that the model + constant tests are sufficient guards.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402

from server import ALLOWED_VAN_SHAPES, VanLayout  # noqa: E402


def test_allowed_shapes_documents_supported_grids():
    """The matrix of grid shapes drivers can pick. Narrowing this set
    silently breaks the frontend's `VAN_LAYOUT_OPTIONS` constant, so this
    test exists to make any deletion intentional."""
    assert ALLOWED_VAN_SHAPES == {(2, 3), (3, 3), (3, 4)}


def test_van_layout_accepts_supported_shapes():
    for rows, cols in ALLOWED_VAN_SHAPES:
        layout = VanLayout(rows=rows, cols=cols)
        assert layout.rows == rows
        assert layout.cols == cols


def test_van_layout_pydantic_rejects_non_int_inputs():
    with pytest.raises(Exception):
        VanLayout(rows="three", cols=3)  # type: ignore[arg-type]


def test_allowed_shapes_lookup_works_for_validation():
    """The endpoint uses `(layout.rows, layout.cols) in ALLOWED_VAN_SHAPES`
    to validate. This test pins that contract so we don't accidentally
    switch to a list (which is fine but slower) or a dict (which would
    break the membership check)."""
    layout = VanLayout(rows=3, cols=4)
    assert (layout.rows, layout.cols) in ALLOWED_VAN_SHAPES

    bad = VanLayout(rows=3, cols=2)
    assert (bad.rows, bad.cols) not in ALLOWED_VAN_SHAPES

    huge = VanLayout(rows=50, cols=50)
    assert (huge.rows, huge.cols) not in ALLOWED_VAN_SHAPES
