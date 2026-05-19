"""Shared constants across `routes/` modules.

Keep this file small and strictly constant — no functions, no state. If you
need a cache or helper, it probably belongs in the owning domain module.
"""
from __future__ import annotations

# QLD ArcGIS MapServer endpoints — used by tiles.py and housenumbers.py.
# MapServer/4 = cadastral parcels; MapServer/0 = property addresses.
_ARCGIS_BASE = (
    "https://spatial-gis.information.qld.gov.au/arcgis/rest/services/"
    "PlanningCadastre/LandParcelPropertyFramework/MapServer"
)
QLD_PARCEL_ARCGIS_URL = f"{_ARCGIS_BASE}/4/query"
QLD_ADDRESS_ARCGIS_URL = f"{_ARCGIS_BASE}/0/query"
