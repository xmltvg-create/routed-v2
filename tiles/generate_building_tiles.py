"""
Extract building data from Queensland OSM PBF into a SQLite-backed tile cache.
Generates Mapbox Vector Tiles (PBF format) for each z/x/y combination.

Usage: python3 generate_building_tiles.py
Output: /app/tiles/buildings.db (SQLite with z/x/y -> gzipped PBF)
"""

import osmium
import json
import math
import sqlite3
import gzip
import struct
import sys
from collections import defaultdict

PBF_PATH = '/app/queensland.osm.pbf'
DB_PATH = '/app/tiles/buildings.db'
MIN_ZOOM = 13
MAX_ZOOM = 14

# ─── Mercator math ────────────────────────────────────────────────────────────

def lng_to_tile_x(lng, zoom):
    return int((lng + 180.0) / 360.0 * (1 << zoom))

def lat_to_tile_y(lat, zoom):
    lat_rad = math.radians(lat)
    n = 1 << zoom
    return int((1.0 - math.log(math.tan(lat_rad) + 1.0 / math.cos(lat_rad)) / math.pi) / 2.0 * n)

def tile_bounds(x, y, z):
    n = 1 << z
    lon_min = x / n * 360.0 - 180.0
    lon_max = (x + 1) / n * 360.0 - 180.0
    lat_max = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    lat_min = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    return lon_min, lat_min, lon_max, lat_max

# ─── Building type → default height ──────────────────────────────────────────

BUILDING_HEIGHTS = {
    'house': 6, 'detached': 6, 'residential': 6, 'semidetached_house': 6,
    'apartments': 15, 'commercial': 15, 'office': 18,
    'industrial': 10, 'warehouse': 10,
    'retail': 5, 'supermarket': 6,
    'garage': 3, 'shed': 3, 'carport': 3, 'hut': 3,
    'church': 20, 'cathedral': 25, 'chapel': 12,
    'hospital': 18, 'school': 12, 'university': 15,
    'hotel': 20, 'civic': 15,
}

# ─── OSM Handler ──────────────────────────────────────────────────────────────

class BuildingHandler(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.buildings = []  # list of (centroid_lng, centroid_lat, properties_dict)
        self.count = 0
        self.wkbfab = osmium.geom.WKBFactory()

    def area(self, a):
        building = a.tags.get('building', '')
        building_part = a.tags.get('building:part', '')
        if not building and not building_part:
            return

        # Get centroid for tile assignment
        try:
            wkb = self.wkbfab.create_multipolygon(a)
        except Exception:
            return

        # Calculate centroid from the WKB (simplified: use first point of outer ring)
        # For tile binning we just need approximate location
        try:
            # Get centroid via bounding box approximation
            nodes = []
            for outer in a.outer_rings():
                for node in outer:
                    nodes.append((node.lon, node.lat))
            if not nodes:
                return
            lng = sum(n[0] for n in nodes) / len(nodes)
            lat = sum(n[1] for n in nodes) / len(nodes)
        except Exception:
            return

        # Calculate heights
        height_raw = a.tags.get('height')
        levels_raw = a.tags.get('building:levels')
        min_height_raw = a.tags.get('min_height')
        min_levels_raw = a.tags.get('building:min_levels')

        height = None
        if height_raw:
            try:
                height = float(height_raw.replace('m', '').strip())
            except ValueError:
                pass

        levels = None
        if levels_raw:
            try:
                levels = int(float(levels_raw))
            except ValueError:
                pass

        render_height = height
        if render_height is None and levels is not None:
            render_height = levels * 3.0
        if render_height is None:
            btype = building or building_part
            render_height = BUILDING_HEIGHTS.get(btype, 8)

        min_height = None
        if min_height_raw:
            try:
                min_height = float(min_height_raw.replace('m', '').strip())
            except ValueError:
                pass
        min_levels = None
        if min_levels_raw:
            try:
                min_levels = int(float(min_levels_raw))
            except ValueError:
                pass

        render_min_height = min_height
        if render_min_height is None and min_levels is not None:
            render_min_height = min_levels * 3.0
        if render_min_height is None:
            render_min_height = 0

        props = {
            'render_height': round(render_height, 1),
            'render_min_height': round(render_min_height, 1),
            'building': building or building_part,
        }

        if levels is not None:
            props['levels'] = levels
        if building_part:
            props['is_part'] = True

        roof_shape = a.tags.get('roof:shape', '')
        if roof_shape:
            props['roof_shape'] = roof_shape

        material = a.tags.get('building:material', '')
        if material:
            props['material'] = material

        colour = a.tags.get('building:colour', '')
        if colour:
            props['colour'] = colour

        name = a.tags.get('name', '')
        if name:
            props['name'] = name

        # Store polygon coords for the tile
        self.buildings.append({
            'lng': lng, 'lat': lat,
            'coords': nodes,  # outer ring coordinates
            'props': props,
        })
        self.count += 1
        if self.count % 10000 == 0:
            print(f'  Extracted {self.count} buildings...', flush=True)


def create_geojson_tile(buildings_in_tile, tile_x, tile_y, tile_z):
    """Create a GeoJSON FeatureCollection for buildings in this tile."""
    features = []
    for b in buildings_in_tile:
        features.append({
            'type': 'Feature',
            'geometry': {
                'type': 'Polygon',
                'coordinates': [[[c[0], c[1]] for c in b['coords']]],
            },
            'properties': b['props'],
        })
    return {
        'type': 'FeatureCollection',
        'features': features,
    }


def main():
    print(f'Extracting buildings from {PBF_PATH}...', flush=True)
    handler = BuildingHandler()
    handler.apply_file(PBF_PATH, locations=True)
    print(f'Extracted {handler.count} buildings total.', flush=True)

    # Bin buildings into tiles
    print(f'Binning into tiles (z{MIN_ZOOM}-{MAX_ZOOM})...', flush=True)
    tiles = defaultdict(list)  # (z, x, y) -> list of buildings

    for b in handler.buildings:
        for z in range(MIN_ZOOM, MAX_ZOOM + 1):
            tx = lng_to_tile_x(b['lng'], z)
            ty = lat_to_tile_y(b['lat'], z)
            tiles[(z, tx, ty)].append(b)

    print(f'Generated {len(tiles)} tile bins.', flush=True)

    # Write to SQLite (MBTiles-like format)
    print(f'Writing to {DB_PATH}...', flush=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute('CREATE TABLE IF NOT EXISTS tiles (z INT, x INT, y INT, data BLOB, PRIMARY KEY(z, x, y))')
    conn.execute('CREATE TABLE IF NOT EXISTS metadata (name TEXT, value TEXT)')

    # Write metadata
    conn.execute("INSERT OR REPLACE INTO metadata VALUES ('name', 'PathPilot QLD Buildings')")
    conn.execute("INSERT OR REPLACE INTO metadata VALUES ('format', 'geojson')")
    conn.execute("INSERT OR REPLACE INTO metadata VALUES ('minzoom', ?)", (str(MIN_ZOOM),))
    conn.execute("INSERT OR REPLACE INTO metadata VALUES ('maxzoom', ?)", (str(MAX_ZOOM),))
    conn.execute("INSERT OR REPLACE INTO metadata VALUES ('total_buildings', ?)", (str(handler.count),))

    batch = 0
    for (z, x, y), buildings in tiles.items():
        geojson = create_geojson_tile(buildings, x, y, z)
        data = gzip.compress(json.dumps(geojson, separators=(',', ':')).encode())
        conn.execute('INSERT OR REPLACE INTO tiles VALUES (?, ?, ?, ?)', (z, x, y, data))
        batch += 1
        if batch % 100 == 0:
            conn.commit()
            print(f'  Written {batch}/{len(tiles)} tiles...', flush=True)

    conn.commit()
    conn.close()
    print(f'Done! {len(tiles)} tiles written to {DB_PATH}', flush=True)
    print(f'Total buildings: {handler.count}', flush=True)


if __name__ == '__main__':
    main()
