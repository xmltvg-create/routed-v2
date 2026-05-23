/**
 * DeliveryMap.native.tsx — React Native (Android/iOS) implementation.
 *
 * Architecture:
 *   WebView + MapLibre GL JS (CDN) with Android-specific safeguards:
 *   1. Canvas-generated marker images via map.addImage() — no asset paths
 *   2. Strict style-load gating — layers mount only after style.load + idle
 *   3. Red debug circle layer on the same source for isolation testing
 *   4. Hardware-accelerated WebView layer type
 *   5. 3D Driving Mode: pitch-60 camera, look-ahead offset, smooth easeTo bearing,
 *      fill-extrusion buildings, directional navigation puck
 *
 * Exports the same interface as DeliveryMap.tsx (web).
 */

import React, { forwardRef, useImperativeHandle, useRef, useEffect, useState, useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';

// ─── Types (shared with web) ─────────────────────────────────────────────────

export interface DeliveryStop {
  id: string;
  latitude: number;
  longitude: number;
  address?: string;
  name?: string;
  order: number;
  completed?: boolean;
}

export interface DriverLocation {
  latitude: number;
  longitude: number;
  heading: number;
}

export interface NextTurnInfo {
  instruction: string;
  distance: string;
}

export interface DeliveryMapRef {
  flyTo: (center: [number, number], opts?: { zoom?: number; bearing?: number; pitch?: number; duration?: number }) => void;
  jumpTo: (center: [number, number], opts?: { bearing?: number; pitch?: number }) => void;
  fitBounds: (bounds: [[number, number], [number, number]], padding?: number) => void;
  setDrawingMode: (enabled: boolean) => void;
  clearLasso: () => void;
  addSectionPolygon: (id: number, coords: number[][], color: string, label: string) => void;
  removeSectionPolygon: (id: number) => void;
  clearAllSectionPolygons: () => void;
  toggleParcels: (enabled: boolean) => void;
  /** Enter "block road" mode — the next map tap creates a no-go zone
   *  centred on the tap. The WebView dim-tints to hint the mode is on
   *  and auto-clears after a single tap (single-shot). */
  setBlockRoadMode: (enabled: boolean) => void;
  /** Replace the rendered no-go-zone overlay. Pass an empty array to
   *  clear. Each zone is `{id, name, polygon: [[lng,lat],…]}`. */
  setNogoZones: (zones: Array<{ id: string; name?: string; polygon: number[][] }>) => void;
  /** Switch the pin painter between Planning Mode and Locked Mode.
   *  Compute once at the parent: `stops.some(s => s.original_sequence != null)`.
   *  - `false` (planning): pins missing `original_sequence` show
   *    `String(order + 1)` in BLUE — the proposed drive order.
   *  - `true` (locked):   pins missing `original_sequence` show "★"
   *    (Unicode BLACK STAR) in PURPLE — late freight that arrived after
   *    lock-in. */
  setRouteConfirmed: (confirmed: boolean) => void;
  sendMessage: (msg: object) => void;
  /** Force-clear the cached fingerprint so the next stops-effect tick
   *  re-ships every feature to the WebView regardless of cache state.
   *  Use after POST /api/routes/confirm to guarantee blue→red flip. */
  forceStopsRefresh: () => void;
  getMap: () => null;
}

interface DeliveryMapProps {
  stops: DeliveryStop[];
  routeCoordinates: number[][] | null;
  /** Render the route polyline as a dashed line — used by the planning
   *  view to visually distinguish a "current → first-stop" preview hint
   *  from a road-accurate active-navigation polyline. WebView toggles
   *  `line-dasharray` on the `route-line` layer accordingly. Defaults
   *  to false so existing callers (active nav) get a solid line. */
  routeIsPreview?: boolean;
  driverLocation: DriverLocation | null;
  traveledPath: number[][] | null;
  mapStyle?: string;
  initialCenter?: [number, number];
  initialZoom?: number;
  followDriver?: boolean;
  onStopClick?: (stopId: string) => void;
  onCameraIdle?: (center: { lng: number; lat: number }, zoom: number) => void;
  onMapReady?: () => void;
  onLassoComplete?: (stopIds: string[]) => void;
  /** Fired when the driver taps the map while in "block road" mode.
   *  Parent should POST /api/nogo-zones/from-point with the lat/lng,
   *  refresh the zone list, and call `setNogoZones(...)` on the ref. */
  onBlockRoadTap?: (lat: number, lng: number) => void;
  /** Fired when the driver taps an existing red no-go-zone polygon
   *  (only when not in lasso/block-road mode). Parent typically shows
   *  a confirm dialog and calls DELETE /api/nogo-zones/{id}. */
  onNogoZoneClick?: (id: string, name: string) => void;
  drawingMode?: boolean;
  speed?: number | null;
  etaMinutes?: number | null;
  distanceRemaining?: string | null;
  nextTurn?: NextTurnInfo | null;
  /** [lng, lat] of the stop the driver is currently heading toward. When
      set (navigation mode) the map renders a pulsing amber ring so the
      driver can spot the target at a glance. Null/undefined hides it. */
  nextStopCoord?: [number, number] | null;
  /** Hex colour for the next-stop ring. Defaults to amber. Parent passes
      green when the driver is comfortably on-time, amber when tight, red
      when overrunning the stop's time-window. */
  nextStopColor?: string | null;
  /** When `true`, the parent's `useNavigationCamera` hook owns the
   *  driving camera at 4 Hz. This component MUST then suppress its own
   *  React-driven `drivingCamera` writes — otherwise the two writers
   *  race and the map visibly snaps between centers/bearings every
   *  ~250 ms (the "camera tug-of-war" bug).
   *
   *  Default `false` keeps backwards-compat for any consumer that hasn't
   *  yet wired `useNavigationCamera` and still relies on this component
   *  to drive the driving camera from prop changes alone. */
  highFreqCameraActive?: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

// Look-ahead offset in degrees (~44m at equator) — places driver in bottom third
const LOOK_AHEAD = 0.0004;

// ─── Inline HTML Builder ─────────────────────────────────────────────────────

const MAPLIBRE_CDN = 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl';
// MapLibre style. We serve a proxied + self-hosted variant of OpenFreeMap's
// Liberty: the vector tiles still come from openfreemap.org (they're too
// huge to self-host), but sprites + glyphs are rewritten by the backend to
// point at /api/map/*. That keeps label rendering on the same warm HTTPS/2
// connection the rest of the API uses — no cold TLS to a third-party
// origin on app start.
//
// Fallback: if `EXPO_PUBLIC_BACKEND_URL` is missing (offline dev, preview
// probe), drop back to the upstream style URL directly.
const _BACKEND_FOR_STYLE = (process.env.EXPO_PUBLIC_BACKEND_URL || '').replace(/\/$/, '');
const MAP_STYLE = _BACKEND_FOR_STYLE
  ? `${_BACKEND_FOR_STYLE}/api/map/style`
  : 'https://tiles.openfreemap.org/styles/liberty';

function buildHtml(center: [number, number], zoom: number): string {
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<link rel="stylesheet" href="${MAPLIBRE_CDN}.css">
<script src="${MAPLIBRE_CDN}.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/@turf/turf@7.1.0/turf.min.js"><\/script>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body,html,#map{width:100%;height:100%;overflow:hidden}
  #draw-overlay{position:absolute;top:0;left:0;right:0;bottom:0;z-index:999;display:none;touch-action:none}
  /* HUD is hidden — the NavigationPanel overlay rendered by React Native
     already shows speed / ETA / distance / turn-banner. Keeping the DOM
     element for progress-ring paint updates but making it invisible. */
  .hud{position:absolute;bottom:16px;left:16px;right:16px;background:rgba(0,0,0,0.78);
       display:none;
    color:#fff;border-radius:12px;padding:10px 14px;font-family:-apple-system,system-ui,sans-serif;
    font-size:14px;display:none;z-index:10;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
  .hud .row{display:flex;justify-content:space-between;align-items:center}
  .hud .speed{font-size:28px;font-weight:700}
  .hud .unit{font-size:12px;opacity:0.7}
  .hud .turn{margin-top:6px;font-size:13px;opacity:0.9;border-top:1px solid rgba(255,255,255,0.2);padding-top:6px}
  /* Progress ring — sits to the right of the speedometer, shows % of route
     completed. Driven by _routeProgressKm inside updateRouteGhost, so it
     stays perfectly in sync with the blue/gray line split on the map. */
  .hud .ring-wrap{display:flex;align-items:center;gap:10px}
  .hud .ring{position:relative;width:44px;height:44px;flex-shrink:0}
  .hud .ring svg{transform:rotate(-90deg);width:44px;height:44px}
  .hud .ring circle.track{fill:none;stroke:rgba(255,255,255,0.18);stroke-width:4}
  .hud .ring circle.fill{fill:none;stroke:#22c55e;stroke-width:4;stroke-linecap:round;
    stroke-dasharray:125.66;stroke-dashoffset:125.66;transition:stroke-dashoffset 0.35s ease-out}
  .hud .ring .pct{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    font-size:11px;font-weight:600;letter-spacing:-0.2px}
</style>
</head><body>
<div id="map"></div>
<div id="draw-overlay"></div>
<div id="hud" class="hud">
  <div class="row">
    <div class="ring-wrap">
      <div><span id="hud-speed" class="speed">0</span><span class="unit"> km/h</span></div>
      <!-- Route-progress ring: circumference is 2πr = 125.66 for r=20. The
           stroke-dashoffset is driven in JS from (1 - progress/total) * 125.66.
           The label shows the same percentage as integer text inside. -->
      <div id="hud-ring" class="ring" style="display:none">
        <svg viewBox="0 0 44 44"><circle class="track" cx="22" cy="22" r="20"></circle><circle id="hud-ring-fill" class="fill" cx="22" cy="22" r="20"></circle></svg>
        <div id="hud-ring-pct" class="pct">0%</div>
      </div>
    </div>
    <div style="text-align:right">
      <div id="hud-eta"></div>
      <div id="hud-dist" style="opacity:0.7;font-size:12px"></div>
    </div>
  </div>
  <div id="hud-turn" class="turn" style="display:none"></div>
</div>
<script>
// ────────────────────────────────────────────────────────────────────────────
// (1) Canvas-based icon generators — zero asset paths, zero glyph deps
// ────────────────────────────────────────────────────────────────────────────

// Completed stop icon — grey pin with white checkmark tick
function makeCompletedIcon(size) {
  size = size || 64;
  var w = size;
  var h = Math.round(size * 1.35);
  var c = document.createElement('canvas');
  c.width = w; c.height = h;
  var ctx = c.getContext('2d');
  var cx = w / 2;
  var r = w * 0.44;
  var tipY = h - 3;

  // Drop shadow
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.2)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 2;
  ctx.beginPath();
  ctx.arc(cx, r + 2, r, Math.PI * 0.15, Math.PI * 0.85, true);
  ctx.quadraticCurveTo(cx, tipY + 2, cx, tipY);
  ctx.quadraticCurveTo(cx, tipY + 2, cx + r * Math.cos(Math.PI * 0.15), r + 2 + r * Math.sin(Math.PI * 0.15));
  ctx.closePath();
  ctx.fillStyle = 'rgba(0,0,0,0.1)'; ctx.fill();
  ctx.restore();

  // Grey pin body
  ctx.beginPath();
  ctx.arc(cx, r + 2, r, Math.PI * 0.15, Math.PI * 0.85, true);
  ctx.quadraticCurveTo(cx, tipY, cx, tipY - 1);
  ctx.quadraticCurveTo(cx, tipY, cx + r * Math.cos(Math.PI * 0.15), r + 2 + r * Math.sin(Math.PI * 0.15));
  ctx.closePath();
  ctx.fillStyle = '#9ca3af'; ctx.fill();

  // White inner circle
  var innerR = r * 0.62;
  ctx.beginPath(); ctx.arc(cx, r + 2, innerR, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff'; ctx.fill();

  // Green checkmark tick
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = size * 0.07;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - innerR * 0.45, r + 2);
  ctx.lineTo(cx - innerR * 0.05, r + 2 + innerR * 0.35);
  ctx.lineTo(cx + innerR * 0.5, r + 2 - innerR * 0.35);
  ctx.stroke();

  return ctx.getImageData(0, 0, w, h);
}

function makeStopIcon(label, color, size) {
  size = size || 96;  // bumped 76→96 so the Sharpie label can never be confused with a housenumber tile label sitting underneath
  var w = size;
  var h = Math.round(size * 1.35);
  var c = document.createElement('canvas');
  c.width = w; c.height = h;
  var ctx = c.getContext('2d');
  var cx = w / 2;
  var r = w * 0.44;
  var tipY = h - 3;

  // Heavier drop shadow so the pin reads as "above" the housenumber layer
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 4;
  ctx.beginPath();
  ctx.arc(cx, r + 2, r, Math.PI * 0.15, Math.PI * 0.85, true);
  ctx.quadraticCurveTo(cx, tipY + 2, cx, tipY);
  ctx.quadraticCurveTo(cx, tipY + 2, cx + r * Math.cos(Math.PI * 0.15), r + 2 + r * Math.sin(Math.PI * 0.15));
  ctx.closePath();
  ctx.fillStyle = 'rgba(0,0,0,0.20)'; ctx.fill();
  ctx.restore();

  // Outer pin body
  ctx.beginPath();
  ctx.arc(cx, r + 2, r, Math.PI * 0.15, Math.PI * 0.85, true);
  ctx.quadraticCurveTo(cx, tipY, cx, tipY - 1);
  ctx.quadraticCurveTo(cx, tipY, cx + r * Math.cos(Math.PI * 0.15), r + 2 + r * Math.sin(Math.PI * 0.15));
  ctx.closePath();
  ctx.fillStyle = color; ctx.fill();

  // White inner circle — wider so the number sits on a clean field
  var innerR = r * 0.66;
  ctx.beginPath(); ctx.arc(cx, r + 2, innerR, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff'; ctx.fill();

  // Coloured ring border inside white circle (thicker — sells the "Sharpie" feel)
  ctx.beginPath(); ctx.arc(cx, r + 2, innerR, 0, Math.PI * 2);
  ctx.strokeStyle = color; ctx.lineWidth = r * 0.10;
  ctx.stroke();

  // Number label — heavier weight, slightly larger, painted in the pin colour
  var labelStr = String(label);
  var fontSize = labelStr.length <= 1 ? innerR * 1.45 : labelStr.length === 2 ? innerR * 1.15 : innerR * 0.9;
  ctx.fillStyle = color;
  ctx.font = '900 ' + Math.round(fontSize) + 'px -apple-system, system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(labelStr, cx, r + 3);

  return ctx.getImageData(0, 0, w, h);
}

// (4) Custom Navigation Puck — directional SVG-style arrow drawn on canvas
//     Rotates via icon-rotate property bound to the GeoJSON bearing property
function makeNavPuck(size) {
  size = size || 96;
  var c = document.createElement('canvas');
  c.width = size; c.height = size;
  var ctx = c.getContext('2d');
  var cx = size / 2, cy = size / 2;

  // Outer glow ring
  ctx.beginPath(); ctx.arc(cx, cy, size / 2 - 2, 0, Math.PI * 2);
  var glow = ctx.createRadialGradient(cx, cy, size * 0.15, cx, cy, size * 0.48);
  glow.addColorStop(0, 'rgba(59, 130, 246, 0.30)');
  glow.addColorStop(1, 'rgba(59, 130, 246, 0.0)');
  ctx.fillStyle = glow; ctx.fill();

  // White shadow behind arrow (1.5× bigger than original)
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.40)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 3;
  ctx.beginPath();
  ctx.moveTo(cx,      cy - 24);
  ctx.lineTo(cx + 18, cy + 15);
  ctx.lineTo(cx,      cy +  6);
  ctx.lineTo(cx - 18, cy + 15);
  ctx.closePath();
  ctx.fillStyle = '#ffffff'; ctx.fill();
  ctx.restore();

  // Blue directional arrow (1.5× bigger)
  ctx.beginPath();
  ctx.moveTo(cx,      cy - 20);
  ctx.lineTo(cx + 15, cy + 12);
  ctx.lineTo(cx,      cy +  3);
  ctx.lineTo(cx - 15, cy + 12);
  ctx.closePath();
  ctx.fillStyle = '#3b82f6'; ctx.fill();

  // White inner dot
  ctx.beginPath(); ctx.arc(cx, cy - 2, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff'; ctx.fill();

  return ctx.getImageData(0, 0, size, size);
}

// ────────────────────────────────────────────────────────────────────────────
// (2) Map init with strict style-load gating
// ────────────────────────────────────────────────────────────────────────────

var _layersReady = false;
var _pendingMessages = [];
var _drivingMode = false;
var _userInteracting = false;
var _interactionTimer = null;
var _easeInFlight = false;
var _tileCache = {};
var _tileLoading = false;
var _backendUrl = '${_BACKEND_FOR_STYLE}';
// Cache guards: skip redundant setData() calls when the set of visible tile
// keys hasn't changed. Prevents a per-moveend GPU re-upload of thousands of
// building extrusions during driving mode (easeTo fires moveend every ~400ms).
var _lastBuildingsKey = '';
var _nextStopLng = null;
var _nextStopLat = null;

// Default zoom-based opacity stops — reused when we drop out of driving
// mode or when there's no active next-stop target to fade around.
var _BASE_OPACITY_SELF = ['interpolate',['linear'],['zoom'],13,0.35,15,0.65,17,0.8];
var _BASE_OPACITY_OSM  = ['interpolate',['linear'],['zoom'],13,0.30,15,0.55,17,0.70];

function _updateBuildingFade(){
  // During driving mode we fade buildings that are CLOSE to the active stop
  // so the pulse + destination marker read clearly against the 3D volume.
  // Outside driving mode (or with no active target) restore the default
  // zoom-based opacity so buildings render solid while planning a route.
  if (!map) return;
  var haveTarget = _drivingMode && typeof _nextStopLng === 'number' && typeof _nextStopLat === 'number';
  var selfOp, osmOp;
  if (haveTarget) {
    // distance() returns metres from the feature to the literal point. Near
    // the stop (<=10m) fade hard to ~0.12, ramp back to the base curve at
    // >=200m so the surrounding city context stays visible.
    var target = ['literal', {type:'Point', coordinates:[_nextStopLng, _nextStopLat]}];
    selfOp = ['interpolate', ['exponential', 1.4], ['distance', target],
      10, 0.12,
      40, 0.28,
      120, 0.55,
      220, 0.80
    ];
    osmOp = ['interpolate', ['exponential', 1.4], ['distance', target],
      10, 0.10,
      40, 0.22,
      120, 0.45,
      220, 0.70
    ];
  } else {
    selfOp = _BASE_OPACITY_SELF;
    osmOp = _BASE_OPACITY_OSM;
  }
  try {
    if (map.getLayer('buildings-self-3d')) map.setPaintProperty('buildings-self-3d','fill-extrusion-opacity', selfOp);
    if (map.getLayer('buildings-3d'))      map.setPaintProperty('buildings-3d','fill-extrusion-opacity', osmOp);
  } catch(e) { /* older MapLibre without distance() expression — keep defaults */ }
}
var _lastParcelsKey = '';
var _lastAddressesKey = '';
var _moveendTimer = null;
var _stopsFeatures = []; // stored copy of stops data for point-in-polygon
var _stopsVersion = 0; // monotonic counter to bust MapLibre symbol cache
var _fullRouteCoords = []; // full route polyline — used for ghost-split in driving mode
var _routeProgressKm = 0;  // monotonic distance along _fullRouteCoords (km)
                            // Prevents Turf.nearestPointOnLine from snapping
                            // to a later pass when the route doubles back.
var _routeTotalKm = 0;     // cached total length of _fullRouteCoords (km)
var _smoothedZoom = 16.5;  // lerp-smoothed zoom target
// ── Puck heading smoother ──
// GPS ticks arrive ~every 800ms. We lerp the displayed bearing toward the latest
// GPS reading at ~60fps so the puck glides through turns instead of snapping.
var _puckCurrentBearing = null;  // currently rendered angle (deg, 0-360)
var _puckTargetBearing = null;   // latest GPS heading
var _puckLocation = null;        // latest {longitude, latitude}
var _puckAnimRAF = null;         // rAF handle
var _drawCoords=[];
var _drawActive=false;
var _drawThrottle=0;
var _lassoFinishing=false;

function pointInPoly(pt,poly){
  var x=pt[0],y=pt[1],inside=false;
  for(var i=0,j=poly.length-1;i<poly.length;j=i++){
    var xi=poly[i][0],yi=poly[i][1],xj=poly[j][0],yj=poly[j][1];
    if(((yi>y)!=(yj>y))&&(x<(xj-xi)*(y-yi)/(yj-yi)+xi))inside=!inside;
  }
  return inside;
}

function updateLasso(){
  var coords=_drawCoords.length>0?_drawCoords.concat([_drawCoords[0]]):[];
  var geom=coords.length>=3?{type:'Polygon',coordinates:[coords]}:{type:'LineString',coordinates:_drawCoords};
  if(map&&map.getSource&&map.getSource('lasso'))map.getSource('lasso').setData({type:'Feature',properties:{},geometry:geom});
}

function finishLasso(){
  if(_drawCoords.length<3)return;
  if(_lassoFinishing)return;
  _lassoFinishing=true;
  var poly=_drawCoords.concat([_drawCoords[0]]);
  var stopIds=[];
  _stopsFeatures.forEach(function(f){
    if(f.geometry&&f.geometry.coordinates&&!f.properties.completed){
      if(pointInPoly(f.geometry.coordinates,poly))stopIds.push(f.properties.id);
    }
  });
  post({type:'log',msg:'finishLasso: '+_drawCoords.length+' pts, checked '+_stopsFeatures.length+' stops, found '+stopIds.length});
  post({type:'lassoComplete',stopIds:stopIds,count:stopIds.length,polygon:poly});
}

var _sectionIds=[];
function addSectionPoly(id,coords,color,label){
  var sid='section-'+id;
  removeSectionPoly(id);
  var feat={type:'Feature',properties:{label:label||''},geometry:{type:'Polygon',coordinates:[coords]}};
  map.addSource(sid,{type:'geojson',data:feat});
  map.addLayer({id:sid+'-fill',type:'fill',source:sid,paint:{'fill-color':color,'fill-opacity':0.18}});
  map.addLayer({id:sid+'-line',type:'line',source:sid,paint:{'line-color':color,'line-width':2.5,'line-opacity':0.85},layout:{'line-join':'round','line-cap':'round'}});
  // Centroid for label
  var cx=0,cy=0;for(var i=0;i<coords.length-1;i++){cx+=coords[i][0];cy+=coords[i][1];}
  cx/=(coords.length-1);cy/=(coords.length-1);
  var lsid=sid+'-lbl';
  map.addSource(lsid,{type:'geojson',data:{type:'Feature',properties:{label:label},geometry:{type:'Point',coordinates:[cx,cy]}}});
  map.addLayer({id:lsid,type:'symbol',source:lsid,layout:{'text-field':['get','label'],'text-size':13,'text-font':['Noto Sans Bold'],'text-allow-overlap':true},paint:{'text-color':color,'text-halo-color':'#ffffff','text-halo-width':2}});
  _sectionIds.push(id);
  post({type:'log',msg:'addSectionPoly: '+sid+' ('+label+')'});
}
function removeSectionPoly(id){
  var sid='section-'+id;
  [sid+'-lbl',sid+'-line',sid+'-fill'].forEach(function(lid){if(map.getLayer(lid))map.removeLayer(lid);});
  [sid+'-lbl',sid].forEach(function(s){if(map.getSource(s))map.removeSource(s);});
  _sectionIds=_sectionIds.filter(function(x){return x!==id;});
}
function clearAllSectionPolys(){
  var ids=_sectionIds.slice();
  ids.forEach(function(id){removeSectionPoly(id);});
  _sectionIds=[];
  post({type:'log',msg:'clearAllSectionPolys'});
}

// ── No-Go zones (driver-marked impassable polygons) ──────────────────
// Rendered as a single GeoJSON FeatureCollection layer (red translucent
// fill + dashed outline). Tap-to-block: when _blockRoadActive is true,
// the next map click is treated as the centre of a new zone — we post
// the lat/lng up to RN, which calls /api/nogo-zones/from-point and
// re-syncs the zone list back down.
var _blockRoadActive = false;
function setNogoZones(zones){
  var fc = {type:'FeatureCollection', features:(zones||[]).map(function(z){
    return {type:'Feature', properties:{id:z.id, name:z.name||''}, geometry:{type:'Polygon', coordinates:[z.polygon]}};
  })};
  if(!map.getSource('nogo-zones')){
    map.addSource('nogo-zones',{type:'geojson',data:fc});
    map.addLayer({id:'nogo-zones-fill',type:'fill',source:'nogo-zones',paint:{'fill-color':'#dc2626','fill-opacity':0.28}});
    map.addLayer({id:'nogo-zones-line',type:'line',source:'nogo-zones',paint:{'line-color':'#dc2626','line-width':2,'line-dasharray':[3,2],'line-opacity':0.95}});
    // Layer-specific click on the fill polygon → delete prompt. Layer
    // hits are reliable on Android WebView (the same mechanism powers
    // the stop-icon click handler), unlike generic map clicks.
    map.on('click','nogo-zones-fill',function(e){
      if(_drawActive || _blockRoadActive) return;  // don't conflict with active draw modes
      if(e.features && e.features[0]) {
        post({type:'nogoZoneClick', id: e.features[0].properties.id, name: e.features[0].properties.name||''});
      }
    });
    // Hand cursor on hover so the polygon feels tappable.
    map.on('mouseenter','nogo-zones-fill',function(){map.getCanvas().style.cursor='pointer';});
    map.on('mouseleave','nogo-zones-fill',function(){map.getCanvas().style.cursor='';});
  } else {
    map.getSource('nogo-zones').setData(fc);
  }
  post({type:'log',msg:'setNogoZones: '+(zones||[]).length+' zone(s)'});
}
// NOTE: the map.on('click', ...) handler that drives "block road" mode is
// registered later (alongside the other map.on listeners, after map is
// instantiated). Doing it here at parse time would throw ReferenceError
// because map does not exist yet, killing the entire WebView bundle.

// ── (5) Route Ghosting — Turf.js line-slice with monotonic progress ───────
// Splits the full route into completed (gray) and upcoming (primary blue)
// segments at the driver's nearest snapped point on the line.
// Called on every drivingCamera tick — runs only in driving mode.
//
// BUG (fixed): turf.nearestPointOnLine searches the whole polyline, so when
// the route doubles back (passes the same street twice) it could snap to a
// later or earlier pass and the split would jump around — users saw the
// upcoming blue line "looping" through streets they had already left.
//
// FIX: track a monotonic _routeProgressKm along the line. Each tick we
//   (a) slice the remaining polyline (progress -> end),
//   (b) find the nearest point on that forward slice only,
//   (c) move progress forward by that offset, but cap the single-tick jump
//       to 300 m so a transient bad GPS fix cannot teleport us past a whole
//       loop,
//   (d) rebuild completed/upcoming with turf.lineSliceAlong(line, 0, p) and
//       turf.lineSliceAlong(line, p, total).
// Progress is reset to 0 whenever _fullRouteCoords changes.
var _MAX_PROGRESS_JUMP_KM = 0.3;   // one tick can advance ≤ 300 m
var _SNAP_LOOKAHEAD_KM = 0.5;      // only search the next 500 m of route
function updateRouteGhost(driverLng, driverLat) {
  if (!_drivingMode || _fullRouteCoords.length < 2) return;
  if (typeof turf === 'undefined') return;
  try {
    var line = turf.lineString(_fullRouteCoords);
    if (_routeTotalKm <= 0) _routeTotalKm = turf.length(line, {units:'kilometers'});
    if (_routeProgressKm >= _routeTotalKm) _routeProgressKm = _routeTotalKm;

    // Search window: from current progress to min(progress + lookahead, total)
    var windowEnd = Math.min(_routeProgressKm + _SNAP_LOOKAHEAD_KM, _routeTotalKm);
    var forward;
    if (windowEnd > _routeProgressKm + 0.001) {
      forward = turf.lineSliceAlong(line, _routeProgressKm, windowEnd, {units:'kilometers'});
    } else {
      forward = line; // guard degenerate case near the end
    }

    var driverPt = turf.point([driverLng, driverLat]);
    var snapped = turf.nearestPointOnLine(forward, driverPt, {units:'kilometers'});
    // snapped.properties.location is distance along the forward slice, so add the base offset.
    var candidate = _routeProgressKm + (snapped.properties.location || 0);

    // Enforce monotonicity and cap per-tick jump (defends against bad GPS).
    if (candidate > _routeProgressKm) {
      var jump = candidate - _routeProgressKm;
      if (jump > _MAX_PROGRESS_JUMP_KM) jump = _MAX_PROGRESS_JUMP_KM;
      _routeProgressKm += jump;
    }
    if (_routeProgressKm > _routeTotalKm) _routeProgressKm = _routeTotalKm;

    var completed, upcoming;
    if (_routeProgressKm <= 0.0005) {
      completed = {type:'Feature',properties:{},geometry:{type:'LineString',coordinates:[]}};
      upcoming = line;
    } else if (_routeTotalKm - _routeProgressKm <= 0.0005) {
      completed = line;
      upcoming = {type:'Feature',properties:{},geometry:{type:'LineString',coordinates:[]}};
    } else {
      completed = turf.lineSliceAlong(line, 0, _routeProgressKm, {units:'kilometers'});
      upcoming = turf.lineSliceAlong(line, _routeProgressKm, _routeTotalKm, {units:'kilometers'});
    }

    if (map.getSource('route-completed')) map.getSource('route-completed').setData(completed);
    if (map.getSource('route-upcoming'))  map.getSource('route-upcoming').setData(upcoming);

    // Drive the progress ring in the HUD. Circumference for r=20 is 2πr ≈ 125.66;
    // stroke-dashoffset interpolates between full (not yet started) and 0 (done).
    var pct = _routeTotalKm > 0 ? Math.min(1, _routeProgressKm / _routeTotalKm) : 0;
    var ringFill = document.getElementById('hud-ring-fill');
    var ringPct = document.getElementById('hud-ring-pct');
    if (ringFill) ringFill.style.strokeDashoffset = (125.66 * (1 - pct)).toFixed(2);
    if (ringPct) ringPct.textContent = Math.round(pct * 100) + '%';
  } catch(e) {
    // Turf can fail on degenerate geometries — the classic cases are:
    //   (a) driver snapped to the exact first/last vertex -> lineSliceAlong
    //       returns an empty LineString and the layer vanishes
    //   (b) polyline has coincident duplicate points -> length goes NaN
    //   (c) turf global not yet loaded (rare race at startup)
    //
    // Defensive fallback: render the FULL route as "upcoming" and clear
    // "completed" so the driver never sees a missing line. Better to show
    // an imperfect split than a blank map mid-drive.
    try {
      if (map.getSource('route-upcoming')) {
        map.getSource('route-upcoming').setData({
          type:'Feature', properties:{},
          geometry:{ type:'LineString', coordinates: _fullRouteCoords.slice() },
        });
      }
      if (map.getSource('route-completed')) {
        map.getSource('route-completed').setData({
          type:'Feature', properties:{}, geometry:{ type:'LineString', coordinates: [] },
        });
      }
    } catch(_) { /* last-resort: give up silently */ }
  }
}

// ── Tile-loading helpers (global scope for access from processMessage) ────
function lngToTileX(lng,z){return Math.floor((lng+180)/360*(1<<z));}
function latToTileY(lat,z){var r=Math.PI/180*lat;return Math.floor((1-Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2*(1<<z));}

function loadBuildingTiles(){
  // Fetches the self-hosted QLD building tiles on every moveend. No longer
  // gated on driving mode — the cadastre-derived footprints are the ONLY
  // building data we have in new AU residential estates (OSM is empty there),
  // so they need to paint whenever a driver / planner is zoomed in.
  if(!_backendUrl||_tileLoading||!map||!map.getZoom||map.getZoom()<13) return;
  var b=map.getBounds();
  var z=14;
  var xMin=lngToTileX(b.getWest(),z),xMax=lngToTileX(b.getEast(),z);
  var yMin=latToTileY(b.getNorth(),z),yMax=latToTileY(b.getSouth(),z);
  var allFeatures=[];
  var pending=[];
  var keys=[];
  for(var x=xMin;x<=xMax;x++){
    for(var y=yMin;y<=yMax;y++){
      var key=z+'/'+x+'/'+y;
      keys.push(key);
      if(_tileCache[key]){allFeatures=allFeatures.concat(_tileCache[key]);continue;}
      pending.push(key);
    }
  }
  var viewKey=keys.join('|');
  if(pending.length===0){
    // Short-circuit: if the visible tile set is identical to the last write,
    // skip setData — re-uploading thousands of extrusions per moveend causes
    // the map to flicker and starves the JS thread during driving mode.
    if(viewKey===_lastBuildingsKey) return;
    _lastBuildingsKey=viewKey;
    if(map.getSource('buildings-self'))map.getSource('buildings-self').setData({type:'FeatureCollection',features:allFeatures});
    return;
  }
  _tileLoading=true;
  var done=0;
  pending.forEach(function(key){
    fetch(_backendUrl+'/api/tiles/buildings/'+key+'.json')
      .then(function(r){return r.json();})
      .then(function(fc){_tileCache[key]=fc.features||[];allFeatures=allFeatures.concat(_tileCache[key]);})
      .catch(function(){_tileCache[key]=[];})
      .finally(function(){
        done++;
        if(done===pending.length){
          _tileLoading=false;
          _lastBuildingsKey=viewKey;
          if(map.getSource('buildings-self'))map.getSource('buildings-self').setData({type:'FeatureCollection',features:allFeatures});
          post({type:'log',msg:'buildingTiles loaded: '+allFeatures.length+' features from '+(pending.length)+' tiles'});
        }
      });
  });
}

// Tile caches — bounded to prevent the WebView from blowing through memory
// during long delivery runs. After ~15 stops across different suburbs we were
// holding megabytes of unused tile GeoJSON, causing MapLibre to stall mid-run.
// Keep hot tiles (recently accessed) and evict the rest FIFO-style.
var _parcelCache={};
var _parcelCacheKeys=[]; // FIFO order of insertion — oldest first
var _addressCache={};
var _addressCacheKeys=[];
var _TILE_CACHE_MAX=64; // ≈ 6 MB worst case per cache at ~100 KB/tile
function _cachePut(cache, keys, key, value){
  if (!(key in cache)) keys.push(key);
  cache[key] = value;
  while (keys.length > _TILE_CACHE_MAX) {
    var evict = keys.shift();
    if (evict !== key) delete cache[evict];
  }
}
var _parcelLoading=false;
var _parcelsVisible=false;
var _addressLoading=false;
function loadParcelTiles(){
  if(!_parcelsVisible||!_backendUrl||_parcelLoading||!map||!map.getZoom||map.getZoom()<15) return;
  var b=map.getBounds();
  var z=16;
  var xMin=lngToTileX(b.getWest(),z),xMax=lngToTileX(b.getEast(),z);
  var yMin=latToTileY(b.getNorth(),z),yMax=latToTileY(b.getSouth(),z);
  var allFeatures=[];
  var pending=[];
  var keys=[];
  for(var x=xMin;x<=xMax;x++){
    for(var y=yMin;y<=yMax;y++){
      var key=z+'/'+x+'/'+y;
      keys.push(key);
      if(_parcelCache[key]){allFeatures=allFeatures.concat(_parcelCache[key]);continue;}
      pending.push(key);
    }
  }
  var viewKey=keys.join('|');
  if(pending.length===0){
    if(viewKey===_lastParcelsKey) return;
    _lastParcelsKey=viewKey;
    if(map.getSource('parcels'))map.getSource('parcels').setData({type:'FeatureCollection',features:allFeatures});
    return;
  }
  _parcelLoading=true;
  var done=0;
  pending.forEach(function(key){
    fetch(_backendUrl+'/api/tiles/parcels/'+key+'.json')
      .then(function(r){return r.json();})
      .then(function(fc){_cachePut(_parcelCache,_parcelCacheKeys,key,fc.features||[]);allFeatures=allFeatures.concat(_parcelCache[key]);})
      .catch(function(){_cachePut(_parcelCache,_parcelCacheKeys,key,[]);})
      .finally(function(){
        done++;
        if(done===pending.length){
          _parcelLoading=false;
          _lastParcelsKey=viewKey;
          if(map.getSource('parcels'))map.getSource('parcels').setData({type:'FeatureCollection',features:allFeatures});
          post({type:'log',msg:'parcelTiles loaded: '+allFeatures.length+' features from '+pending.length+' tiles (cache='+_parcelCacheKeys.length+')'});
        }
      });
  });
}

function loadAddressTiles(){
  if(!_parcelsVisible||!_backendUrl||_addressLoading||!map||!map.getZoom||map.getZoom()<16) return;
  var b=map.getBounds();
  var z=16;
  var xMin=lngToTileX(b.getWest(),z),xMax=lngToTileX(b.getEast(),z);
  var yMin=latToTileY(b.getNorth(),z),yMax=latToTileY(b.getSouth(),z);
  var allFeatures=[];
  var pending=[];
  var keys=[];
  for(var x=xMin;x<=xMax;x++){
    for(var y=yMin;y<=yMax;y++){
      var key=z+'/'+x+'/'+y;
      keys.push(key);
      if(_addressCache[key]){allFeatures=allFeatures.concat(_addressCache[key]);continue;}
      pending.push(key);
    }
  }
  var viewKey=keys.join('|');
  if(pending.length===0){
    if(viewKey===_lastAddressesKey) return;
    _lastAddressesKey=viewKey;
    if(map.getSource('addresses'))map.getSource('addresses').setData({type:'FeatureCollection',features:tagAddressesWithStops(allFeatures)});
    return;
  }
  _addressLoading=true;
  var done=0;
  pending.forEach(function(key){
    fetch(_backendUrl+'/api/tiles/addresses/'+key+'.json')
      .then(function(r){return r.json();})
      .then(function(fc){_cachePut(_addressCache,_addressCacheKeys,key,fc.features||[]);allFeatures=allFeatures.concat(_addressCache[key]);})
      .catch(function(){_cachePut(_addressCache,_addressCacheKeys,key,[]);})
      .finally(function(){
        done++;
        if(done===pending.length){
          _addressLoading=false;
          _lastAddressesKey=viewKey;
          if(map.getSource('addresses'))map.getSource('addresses').setData({type:'FeatureCollection',features:tagAddressesWithStops(allFeatures)});
          post({type:'log',msg:'addressTiles loaded: '+allFeatures.length+' features from '+pending.length+' tiles'});
        }
      });
  });
}

// Tag each address feature with isStop=true when its point falls within
// ~25 m of one of the driver's stops. Used by the address-label-stops layer
// to render delivery-target numbers bolder/bigger than the rest of the block.
// ~25 m ≈ 0.00022 degrees of latitude; longitude scales by cos(lat).
function tagAddressesWithStops(features){
  var stops = (_stopsFeatures||[]).filter(function(s){return s&&s.geometry&&s.geometry.coordinates;});
  if(!stops.length||!features.length) return features;
  var RADIUS_DEG = 0.00022; // ≈ 25 m
  var R2 = RADIUS_DEG*RADIUS_DEG;
  return features.map(function(f){
    if(!f||!f.geometry||!f.geometry.coordinates) return f;
    var c = f.geometry.coordinates;
    var lng = c[0], lat = c[1];
    var cosLat = Math.cos(lat*Math.PI/180) || 1;
    var isStop = false;
    for (var i=0;i<stops.length;i++){
      var sc = stops[i].geometry.coordinates;
      var dx = (sc[0]-lng)*cosLat;
      var dy = (sc[1]-lat);
      if (dx*dx + dy*dy < R2) { isStop = true; break; }
    }
    // Preserve existing properties; overwrite isStop each pass.
    var np = {};
    for (var k in f.properties) np[k] = f.properties[k];
    np.isStop = isStop;
    return {type:'Feature',geometry:f.geometry,properties:np};
  });
}

function post(obj) {
  try { window.ReactNativeWebView.postMessage(JSON.stringify(obj)); } catch(e) {}
}

var map = new maplibregl.Map({
  container: 'map',
  style: '${MAP_STYLE}',
  center: [${center[0]}, ${center[1]}],
  zoom: ${zoom},
  attributionControl: false,
  failIfMajorPerformanceCaveat: false,
  maxPitch: 70
});

// Track user touch to pause driving camera
map.on('touchstart', function() { _userInteracting = true; clearTimeout(_interactionTimer); });
map.on('touchend', function() {
  _interactionTimer = setTimeout(function() { _userInteracting = false; }, 3000);
});
map.on('mousedown', function() { _userInteracting = true; clearTimeout(_interactionTimer); });
map.on('mouseup', function() {
  _interactionTimer = setTimeout(function() { _userInteracting = false; }, 3000);
});

function initLayers() {
  if (_layersReady) return;
  if (!map.isStyleLoaded()) {
    post({type:'log',msg:'initLayers deferred — style not loaded yet'});
    return;
  }
  _layersReady = true;
  post({type:'log',msg:'initLayers — adding sources and layers'});

  // Pre-bake the "unconfirmed" pin — painted on any stop whose route has
  // not been Confirmed yet (no original_sequence). Renders a dash inside
  // the pin head so the driver SEES they need to Confirm Route before any
  // box number is committed. We deliberately do NOT pre-bake "stop-N"
  // sprites for transient drive-order numbers — see the icon-image layer
  // expression and processMessage(updateStops) for the strict
  // original_sequence-only contract.
  if (map.hasImage('stop-unconfirmed')) map.removeImage('stop-unconfirmed');
  map.addImage('stop-unconfirmed', makeStopIcon('—', '#94a3b8', 76), {pixelRatio: 2});
  // Single completed icon (grey pin + green checkmark) for ALL completed stops
  map.addImage('stop-done', makeCompletedIcon(64), {pixelRatio: 2});
  // (4) Navigation puck icon
  map.addImage('nav-puck', makeNavPuck(96), {pixelRatio: 2});

  // ── (3) 3D Buildings — worldwide OpenMapTiles fallback ───────────────────
  // Covers everywhere on Earth at z>=13 via the shared "openmaptiles" vector
  // source. Kept ALWAYS VISIBLE (not gated on driving mode) so drivers outside
  // SE Queensland -- where our richer self-hosted DB has no coverage -- still
  // see 3D context when zoomed in. Height ramps from 0 at z=13 to full at
  // z=16, so low-zoom city views are not overwhelmed by tall extrusions.
  map.addLayer({
    id: 'buildings-3d',
    type: 'fill-extrusion',
    source: 'openmaptiles',
    'source-layer': 'building',
    minzoom: 13,
    filter: ['!=', ['get', 'hide_3d'], true],
    paint: {
      'fill-extrusion-color': [
        'interpolate', ['linear'], ['coalesce', ['to-number', ['get', 'render_height']], 8],
        0, '#d4d4d8',
        15, '#a1a1aa',
        40, '#78716c',
        100, '#64748b'
      ],
      'fill-extrusion-height': [
        'interpolate', ['linear'], ['zoom'],
        13, 0,
        15, ['*', 0.5, ['coalesce', ['to-number', ['get', 'render_height']], 8]],
        16, ['coalesce', ['to-number', ['get', 'render_height']], 8]
      ],
      'fill-extrusion-base': [
        'case',
        ['>=', ['zoom'], 15],
        ['coalesce', ['to-number', ['get', 'render_min_height']], 0],
        0
      ],
      'fill-extrusion-opacity': [
        'interpolate', ['linear'], ['zoom'],
        13, 0.3,
        15, 0.55,
        17, 0.7
      ]
    },
    layout: { 'visibility': 'visible' }
  });

  // ── Self-hosted QLD buildings (always on) ────────────────────────────────
  // Richer height + cadastre-derived footprints for SE Queensland. Overlays
  // the worldwide OSM buildings-3d where we have data; outside the DB
  // bbox the source stays empty and OSM wins. Decoupled from driving mode
  // because OSM is empty in new AU estates (Pelican Waters, Ripley, etc.)
  // and this DB is often the ONLY source of building geometry there.
  map.addSource('buildings-self',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  // Flat fill layer underneath the 3D extrusion — a safety net so building
  // footprints always paint even if a device's fill-extrusion stack fails to
  // render (some low-end Android GPUs silently drop fill-extrusion when the
  // tile has mixed polygon types). Low opacity so it doesn't clash with the
  // 3D version when both succeed.
  map.addLayer({
    id:'buildings-self-fill', type:'fill', source:'buildings-self',
    minzoom: 14,
    paint:{
      'fill-color': '#9ca3af',
      'fill-opacity': ['interpolate',['linear'],['zoom'], 14, 0.25, 16, 0.35, 18, 0.45],
      'fill-outline-color': '#6b7280'
    },
    layout:{'visibility':'visible'}
  });
  map.addLayer({
    id:'buildings-self-3d', type:'fill-extrusion', source:'buildings-self',
    minzoom:13,
    paint:{
      'fill-extrusion-color':['interpolate',['linear'],['coalesce',['to-number',['get','render_height']],8],0,'#d4d4d8',6,'#c4b5a0',15,'#a1a1aa',40,'#78716c',100,'#64748b'],
      'fill-extrusion-height':['interpolate',['linear'],['zoom'],13,0,15,['*',0.5,['coalesce',['to-number',['get','render_height']],8]],16,['coalesce',['to-number',['get','render_height']],8]],
      'fill-extrusion-base':['coalesce',['to-number',['get','render_min_height']],0],
      'fill-extrusion-opacity':['interpolate',['linear'],['zoom'],13,0.35,15,0.65,17,0.8]
    },
    layout:{'visibility':'visible'}
  });

  // ── QLD Cadastral Parcel Boundaries ─────────────────────────────────────
  map.addSource('parcels',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addLayer({
    id:'parcels-fill', type:'fill', source:'parcels', minzoom:15,
    paint:{'fill-color':'#9ca3af','fill-opacity':0.03},
    layout:{'visibility':'none'}
  });
  map.addLayer({
    id:'parcels-line', type:'line', source:'parcels', minzoom:15,
    paint:{
      // Faint grey — driver-friendly, doesn't fight with stop pins or route
      'line-color':'#6b7280',
      'line-width':['interpolate',['linear'],['zoom'],15,0.6,17,1.0],
      'line-opacity':0.55,
    },
    layout:{'visibility':'none'}
  });

  // ── QLD Property Addresses (street numbers) ────────────────────────────
  map.addSource('addresses',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  // Non-stop numbers — the neighbourhood context. Muted so your active
  // delivery targets stand out.
  map.addLayer({
    id:'address-label', type:'symbol', source:'addresses', minzoom:15.5,
    filter:['!=',['get','isStop'],true],
    layout:{
      'text-field':['get','street_number'],
      'text-size':['interpolate',['linear'],['zoom'],15.5,11,17,13,19,15],
      'text-font':['Noto Sans Bold'],
      'text-allow-overlap':true,
      'text-ignore-placement':true,
      'text-offset':[0,0.3],
      'visibility':'none'
    },
    paint:{
      'text-color':'#64748b', // slate-500 — quiet, readable
      'text-halo-color':'#ffffff',
      'text-halo-width':1.6,
      'text-opacity':['interpolate',['linear'],['zoom'],15.5,0.65,16,0.85],
    }
  });
  // Stop numbers — your actual delivery targets. Bigger, bolder, coloured to
  // match the stop-pin red so they pop over the muted context.
  map.addLayer({
    id:'address-label-stops', type:'symbol', source:'addresses', minzoom:15,
    filter:['==',['get','isStop'],true],
    layout:{
      'text-field':['get','street_number'],
      'text-size':['interpolate',['linear'],['zoom'],15,13,17,17,19,20],
      'text-font':['Noto Sans Bold'],
      'text-allow-overlap':true,
      'text-ignore-placement':true,
      'text-offset':[0,0.3],
      'visibility':'none',
      'symbol-sort-key':0, // render above non-stop labels
    },
    paint:{
      'text-color':'#b91c1c', // red-700 — matches stop pin
      'text-halo-color':'#ffffff',
      'text-halo-width':2.4,
      'text-halo-blur':0.2,
      'text-opacity':1,
    }
  });

  // ── House numbers (global, zoom ≥ 17.5) ────────────────────────────────
  // Driver-focused property-number overlay. Populated by the RN layer when it
  // fetches /api/housenumbers on camera idle; matches the web
  // <HouseNumberLayer /> pixel-for-pixel.
  map.addSource('house-numbers',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addLayer({
    id:'house-numbers', type:'symbol', source:'house-numbers', minzoom:17.5,
    layout:{
      'text-field':['get','housenumber'],
      'text-font':['Noto Sans Bold','Open Sans Bold'],
      'text-size':['interpolate',['linear'],['zoom'],17,12,20,16],
      'text-padding':2,
      'text-allow-overlap':false,
      'text-ignore-placement':false,
      'text-rotation-alignment':'map',
      'text-pitch-alignment':'viewport',
      'text-anchor':'bottom',
      'text-offset':[0,-0.2]
    },
    paint:{
      'text-color':'#111827',
      'text-halo-color':'#ffffff',
      'text-halo-width':2,
      'text-halo-blur':0.3,
      'text-opacity':['interpolate',['linear'],['zoom'],17,0,17.5,0.4,18,1]
    }
  });

  // Auto-load building tiles on camera move
  // Debounced: in driving mode easeTo fires moveend every ~400ms. We only want
  // to load tiles once the camera has been still for ~350ms — this prevents
  // stacking tile-fetch + setData storms that flicker the map.
  map.on('moveend',function(){
    if(_moveendTimer) clearTimeout(_moveendTimer);
    _moveendTimer=setTimeout(function(){
      _moveendTimer=null;
      var c=map.getCenter();
      post({type:'cameraIdle',lng:c.lng,lat:c.lat,zoom:map.getZoom()});
      loadBuildingTiles();
      loadParcelTiles();
      loadAddressTiles();
    },350);
  });

  map.addSource('stops', {type: 'geojson', data: {type:'FeatureCollection',features:[]}});

  // ── Driveway hint dots ────────────────────────────────────────────────
  // Two layers fed by ONE source. Each Feature is a LineString whose start
  // coord is the stop's address centroid (where the pin sits) and end
  // coord is the driver-friendly access point (kerb, driveway entrance,
  // loading dock) captured by the reverse-geocode pipeline. The line
  // layer paints a hair-thin dashed connector; a separate circle layer
  // paints a small dot at the END vertex of every line. We chose
  // LineString-with-endpoint-circle over two separate sources because
  // it's one Mongo round-trip, one setData call, and the dot moves
  // automatically when the pin coord updates (e.g. after a Map Fix tap).
  // Sits BELOW the numbered pin layer so it never competes for the
  // driver's primary hit-target.
  map.addSource('driveway-hints', {type:'geojson', data:{type:'FeatureCollection',features:[]}});
  map.addLayer({
    id: 'driveway-hints-line', type: 'line', source: 'driveway-hints',
    paint: {
      'line-color': '#a855f7',          // purple — matches late-freight pin family
      'line-width': 1.5,
      'line-opacity': 0.7,
      'line-dasharray': [2, 2],
    },
    layout: {'line-join': 'round', 'line-cap': 'round'},
  });
  // Driveway dot — small filled circle at the END of each LineString
  // (the access point). MapLibre paints circles at every coord by default,
  // so we use a tiny "endpoint-only" projection by pointing the layer at
  // the same source with a (geometry-type == "Point") filter — but since
  // Mapbox/MapLibre cannot filter LineString endpoints natively, we ship
  // a TWIN feature per stop in the driveway source: one LineString for the
  // dashed line, one Point at the access coord for the dot. Both share the
  // same (properties.stopId) so they batch together.
  map.addLayer({
    id: 'driveway-hints-dot', type: 'circle', source: 'driveway-hints',
    filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      'circle-color': '#a855f7',
      'circle-radius': 4.5,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 1.5,
      'circle-opacity': 0.95,
    },
  });

  // ── Next-stop pulse ring ─────────────────────────────────────────────────
  // A single-feature source, updated from RN whenever the current leg index
  // changes. Two circle layers on top of the source give a ring effect:
  //   • outer: large, animated radius + decaying opacity (the "pulse")
  //   • inner: tighter high-opacity ring to anchor the driver's eye
  // The pulse radius + opacity are updated on the drivingCamera rAF loop so
  // it runs only in driving mode — zero idle cost otherwise. The ring sits
  // BELOW the stop icons so the numbered pin remains the primary hit-target.
  map.addSource('next-stop', {type:'geojson', data:{type:'FeatureCollection', features:[]}});
  map.addLayer({
    id: 'next-stop-pulse', type: 'circle', source: 'next-stop',
    paint: {
      'circle-color': '#f59e0b',           // amber-500 — pops against any map style
      'circle-radius': 18,                 // animated on each tick
      'circle-opacity': 0.35,              // animated on each tick
      'circle-stroke-color': '#f59e0b',
      'circle-stroke-width': 2,
      'circle-stroke-opacity': 0.8,
    },
    layout: {'visibility': 'none'},        // shown only in driving mode
  });
  map.addLayer({
    id: 'next-stop-core', type: 'circle', source: 'next-stop',
    paint: {
      'circle-color': '#ffffff',
      'circle-radius': 7,
      'circle-stroke-color': '#f59e0b',
      'circle-stroke-width': 3,
    },
    layout: {'visibility': 'none'},
  });

  // Primary symbol layer — uses pre-loaded canvas images
  map.addLayer({
    id: 'stops-icon', type: 'symbol', source: 'stops',
    layout: {
      // Sprite key uses the explicit icon_key we stamped onto each
      // feature in processMessage(updateStops). icon_key is ONLY set when
      // 'original_sequence' is present (Sharpie-locked post-confirm) — its
      // value is "stop-os-N". Pre-confirm rows have NO icon_key and fall
      // back to a single "stop-unconfirmed" sprite that paints a dash
      // inside the pin head — visually forces the driver to confirm the
      // route before any number is committed. We deliberately DO NOT fall
      // back to "order" / "order + 1" / list index here — the pin must
      // never display a transient drive-order value that could later
      // disagree with the locked Sharpie value the driver wrote on
      // the box.
      'icon-image': ['case',
        ['==',['get','completed'],true],'stop-done',
        ['has','icon_key'],['get','icon_key'],
        'stop-unconfirmed'
      ],
      // Pin tip (y = h-3 in canvas, pixelRatio:2 -> ~1.5 screen-px above bottom edge) must sit on the coord,
      // otherwise the constant pixel offset becomes a visible geographic drift when zooming.
      'icon-size': 1, 'icon-allow-overlap': true, 'icon-ignore-placement': true,
      'icon-anchor': 'bottom', 'icon-offset': [0, 1.5]
    }
  });

  // Background-sync dot — small orange circle overlaid on any pin whose action (complete/uncomplete)
  // is still awaiting server ack. Only painted when pending===true; invisible otherwise so it has
  // zero visual impact on normal pins. Placed offset to the top-right of the pin head.
  map.addLayer({
    id: 'stops-pending-dot', type: 'circle', source: 'stops',
    filter: ['==', ['get', 'pending'], true],
    paint: {
      'circle-color': '#f97316',       // orange-500
      'circle-radius': 4,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 1.5,
      'circle-translate': [10, -26],   // shift to top-right corner of the pin head (screen pixels)
      'circle-translate-anchor': 'viewport',
    },
  });

  // ── Route source ─────────────────────────────────────────────────────────
  map.addSource('route', {type:'geojson',data:{type:'Feature',properties:{},geometry:{type:'LineString',coordinates:[]}}});
  // White casing UNDER the main route line — adds the subtle outline that
  // makes the blue "pop" on light basemaps (Google-Maps style).
  map.addLayer({id:'route-line-casing',type:'line',source:'route',paint:{'line-color':'#ffffff','line-width':11,'line-opacity':0.9},layout:{'line-join':'round','line-cap':'round'}});
  map.addLayer({id:'route-line',type:'line',source:'route',paint:{'line-color':'#1a73e8','line-width':8,'line-opacity':1},layout:{'line-join':'round','line-cap':'round'}});
  // Animated pulse overlay for driving mode
  map.addLayer({
    id: 'route-pulse', type: 'line', source: 'route',
    paint: {'line-color':'#60a5fa','line-width':3,'line-opacity':0.7,'line-dasharray':[0,4,3]},
    layout: {'line-join':'round','line-cap':'round','visibility':'none'}
  });

  // ── (3) Ghost route layers — completed (gray) + upcoming (cobalt-blue) ────
  // Visible only in driving mode; replaced by Turf lineSlice on each GPS tick
  map.addSource('route-completed',{type:'geojson',data:{type:'Feature',properties:{},geometry:{type:'LineString',coordinates:[]}}});
  map.addLayer({
    id:'route-completed-line',type:'line',source:'route-completed',
    paint:{'line-color':'#6b7280','line-width':5,'line-opacity':0.45},
    layout:{'line-join':'round','line-cap':'round','visibility':'none'}
  });
  map.addSource('route-upcoming',{type:'geojson',data:{type:'Feature',properties:{},geometry:{type:'LineString',coordinates:[]}}});
  // White casing + main line for upcoming segment (same Google-Maps treatment)
  map.addLayer({
    id:'route-upcoming-casing',type:'line',source:'route-upcoming',
    paint:{'line-color':'#ffffff','line-width':12,'line-opacity':0.9},
    layout:{'line-join':'round','line-cap':'round','visibility':'none'}
  });
  map.addLayer({
    id:'route-upcoming-line',type:'line',source:'route-upcoming',
    paint:{'line-color':'#1a73e8','line-width':9,'line-opacity':1},
    layout:{'line-join':'round','line-cap':'round','visibility':'none'}
  });
  // Animated chase-arrow: a thin white dashed overlay that flows along the blue upcoming line
  // to give the driver an unmistakable sense of direction of travel at a glance.
  map.addLayer({
    id:'route-chase', type:'line', source:'route-upcoming',
    // Bold neon yellow (high contrast against the blue upcoming line and
    // any map style). Width/opacity bumped so the chasing chevrons are
    // unmistakable even in direct sunlight on a phone screen.
    paint:{'line-color':'#fde047','line-width':4,'line-opacity':1,'line-dasharray':[0,4,3]},
    layout:{'line-join':'round','line-cap':'round','visibility':'none'}
  });

  // ── Traveled path ────────────────────────────────────────────────────────
  map.addSource('traveled',{type:'geojson',data:{type:'Feature',properties:{},geometry:{type:'LineString',coordinates:[]}}});
  map.addLayer({id:'traveled-line',type:'line',source:'traveled',paint:{'line-color':'#22c55e','line-width':4,'line-opacity':0.7},layout:{'line-join':'round','line-cap':'round'}});

  // ── Driver source + (4) Navigation puck layer ───────────────────────────
  // Puck scale is pumped to 2.5× the original icon-size so the driver's
  // location is unmistakable on a 6" phone at 60 km/h. Pulse radius scales
  // proportionally (22 → 55 px) to keep the halo proportional to the icon.
  map.addSource('driver',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addLayer({
    id: 'driver-pulse', type: 'circle', source: 'driver',
    paint: {'circle-radius':55,'circle-color':'rgba(59,130,246,0.12)','circle-stroke-width':0}
  });
  map.addLayer({
    id: 'driver-puck', type: 'symbol', source: 'driver',
    layout: {
      'icon-image': 'nav-puck',
      'icon-size': 2.5,
      'icon-rotate': ['coalesce', ['to-number', ['get', 'bearing']], 0],
      'icon-rotation-alignment': 'map',
      'icon-pitch-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true
    }
  });

  // ── Interaction handlers ─────────────────────────────────────────────────
  map.on('click','stops-icon',function(e){if(e.features&&e.features[0])post({type:'stopClick',id:e.features[0].properties.id});});

  // ── Lasso drawing system ─────────────────────────────────────────────────
  map.addSource('lasso',{type:'geojson',data:{type:'Feature',properties:{},geometry:{type:'LineString',coordinates:[]}}});
  map.addLayer({id:'lasso-line',type:'line',source:'lasso',paint:{'line-color':'#f97316','line-width':3,'line-dasharray':[4,3],'line-opacity':0.9},layout:{'line-join':'round','line-cap':'round','visibility':'none'}});
  map.addLayer({id:'lasso-fill',type:'fill',source:'lasso',paint:{'fill-color':'#f97316','fill-opacity':0.12},layout:{'visibility':'none'}});

  // ── No-Go zone tap-to-block click handler ────────────────────────────────
  // Registered AFTER map exists. Single-shot: when RN flips
  // _blockRoadActive to true via the setBlockRoadMode message, the next
  // map click posts back the lat/lng and clears the flag (RN re-arms after
  // the server confirms the new zone). Skipped while lasso draw is active.
  //
  // ALSO acts as the tap-to-DELETE handler for existing no-go zones. We
  // avoid relying on the layer-specific map.on('click','nogo-zones-fill',…)
  // listener because it has known reliability issues on Android WebView
  // (the tap registers on the canvas before MapLibre dispatches it through
  // the layer hit-test). Querying rendered features at the click point
  // is a reliable cross-platform fallback used elsewhere in this file.
  map.on('click', function(e){
    if (typeof _drawActive !== 'undefined' && _drawActive) return;
    if (_blockRoadActive) {
      _blockRoadActive = false;
      post({type:'blockRoadTap', lat:e.lngLat.lat, lng:e.lngLat.lng});
      return;
    }
    // Tap-to-delete: query the no-go-zones-fill layer at the tap point.
    try {
      if (map.getLayer('nogo-zones-fill')) {
        var hits = map.queryRenderedFeatures(e.point, {layers:['nogo-zones-fill']});
        if (hits && hits.length > 0) {
          var f = hits[0];
          post({type:'nogoZoneClick', id: f.properties.id, name: f.properties.name||''});
        }
      }
    } catch(_e){}
  });

  // ── Lasso drawing via HTML overlay (reliable on Android WebView) ──────────
  var _overlay = document.getElementById('draw-overlay');
  _overlay.addEventListener('touchstart', function(e) {
    // ── Block-road mode: single-tap to create a no-go zone ────────────
    // Mirrors the lasso pattern (HTML overlay > map.on('click') on
    // Android WebView). Single-shot — RN re-arms after the server
    // confirms the new zone.
    if (_blockRoadActive) {
      e.preventDefault(); e.stopPropagation();
      var bt = e.touches[0];
      var brect = map.getContainer().getBoundingClientRect();
      var bpt = map.unproject([bt.clientX - brect.left, bt.clientY - brect.top]);
      _blockRoadActive = false;
      _overlay.style.display = 'none';
      try { var bcnv = map.getCanvas(); if (bcnv) bcnv.style.filter = ''; } catch(_be){}
      post({type:'blockRoadTap', lat: bpt.lat, lng: bpt.lng});
      return;
    }
    if (!_drawActive) return;
    e.preventDefault(); e.stopPropagation();
    var t = e.touches[0];
    var rect = map.getContainer().getBoundingClientRect();
    var pt = map.unproject([t.clientX - rect.left, t.clientY - rect.top]);
    _drawCoords = [[pt.lng, pt.lat]];
    _drawThrottle = 0;
    updateLasso();
    post({type:'log',msg:'lasso touchstart: '+pt.lng.toFixed(4)+','+pt.lat.toFixed(4)});
  }, {passive: false});
  _overlay.addEventListener('touchmove', function(e) {
    if (!_drawActive || _drawCoords.length === 0) return;
    e.preventDefault(); e.stopPropagation();
    _drawThrottle++;
    if (_drawThrottle % 2 !== 0) return;
    var t = e.touches[0];
    var rect = map.getContainer().getBoundingClientRect();
    var pt = map.unproject([t.clientX - rect.left, t.clientY - rect.top]);
    _drawCoords.push([pt.lng, pt.lat]);
    updateLasso();
  }, {passive: false});
  _overlay.addEventListener('touchend', function(e) {
    if (!_drawActive || _drawCoords.length < 3) return;
    e.preventDefault();
    post({type:'log',msg:'lasso touchend: '+_drawCoords.length+' points'});
    finishLasso();
  }, {passive: false});

  post({type:'ready'});

  // Flush pending
  for(var m=0;m<_pendingMessages.length;m++) processMessage(_pendingMessages[m]);
  _pendingMessages=[];
}

// Double-gate: load + idle
map.on('load',function(){post({type:'log',msg:'map.on(load) fired'});initLayers();});
map.on('idle',function(){if(!_layersReady){post({type:'log',msg:'map.on(idle) — retry initLayers'});initLayers();}});

// ── Route pulse animation (runs continuously when driving mode is on) ────
var _pulseFrame = 0;
var _pulseRAF = null;
var _pulseLastTime = 0;
var _dashSeq = [
  [0,4,3],[0.5,4,2.5],[1,4,2],[1.5,4,1.5],[2,4,1],[2.5,4,0.5],[3,4,0],
  [0,0.5,3,3.5],[0,1,3,3],[0,1.5,3,2.5],[0,2,3,2],[0,2.5,3,1.5],[0,3,3,1],[0,3.5,3,0.5]
];
function animatePulse(time) {
  if (time - _pulseLastTime > 80) {
    _pulseLastTime = time;
    _pulseFrame = (_pulseFrame + 1) % _dashSeq.length;
    if (map.getLayer('route-pulse')) map.setPaintProperty('route-pulse','line-dasharray',_dashSeq[_pulseFrame]);
    // Chase-arrow overlay: same dash sequence, offset so it feels like a *separate* flowing marker
    // rather than duplicating the pulse. Visually reads as direction of travel.
    if (map.getLayer('route-chase')) {
      var chaseIdx = (_pulseFrame + Math.floor(_dashSeq.length / 2)) % _dashSeq.length;
      map.setPaintProperty('route-chase','line-dasharray',_dashSeq[chaseIdx]);
    }
  }
  // ── Next-stop pulse: smoothly expanding ring (20→34 px) with fading opacity.
  // Driven directly off the rAF time argument (continuous, not stepped) so it
  // looks natural even when the dash animation above is gated to 12 fps.
  if (map.getLayer('next-stop-pulse')) {
    var phase = (time % 1600) / 1600;        // 0→1 over 1.6 s
    var r = 18 + phase * 16;                   // 18 → 34 px
    var op = 0.45 * (1 - phase);               // fade to 0 as it grows
    map.setPaintProperty('next-stop-pulse','circle-radius', r);
    map.setPaintProperty('next-stop-pulse','circle-opacity', op);
    map.setPaintProperty('next-stop-pulse','circle-stroke-opacity', Math.max(0, 0.8 * (1 - phase)));
  }
  _pulseRAF = requestAnimationFrame(animatePulse);
}

// ────────────────────────────────────────────────────────────────────────────
// Message handler
// ────────────────────────────────────────────────────────────────────────────

function processMessage(d) {
  try {
    if (d.type === 'updateStops' && map.getSource('stops')) {
      // Store features for lasso point-in-polygon
      _stopsFeatures = (d.features || []).slice();
      // On-demand icon generation for any order number not yet in the image catalog
      var _v = ++_stopsVersion;

      // ── Confirm-Route state tracking ────────────────────────────────────────
      // Track previous icon_key per stop ID. Used to be a ripple-animation
      // hook; now just records last-known state for diagnostics. The swap
      // itself is INSTANT — fancy staggered animations were proving too
      // fragile (setTimeout dies on screen sleep / backgrounding) and a
      // failed animation left pins painted blue when they should be red.
      // Reliability over flair: the user has to be able to TRUST that
      // tapping Confirm flips the colour, every time, with zero delay.
      window.__pinIconState = window.__pinIconState || {};
      var prevByID = window.__pinIconState;

      // Compute routeConfirmed locally from THIS batch of features, so
      // late-freight pins are immediately purple even if the separate
      // setRouteConfirmed message hasn't arrived yet (React child effects
      // fire before parent effects, so updateStops arrives first).
      // ALSO syncs the global flag so stale true→false transitions work
      // (e.g. after a fresh XLS import wipes original_sequence).
      var _localRouteConfirmed = false;
      (d.features||[]).forEach(function(f) {
        if (f.properties && typeof f.properties.original_sequence === 'number' && !isNaN(f.properties.original_sequence)) {
          _localRouteConfirmed = true;
        }
      });
      // Always sync — ensures stale true is cleared after re-import.
      window._routeConfirmed = _localRouteConfirmed;

      (d.features||[]).forEach(function(f) {
        // ── Completed stops → grey pin (stop-done), skip icon_key ──────
        // The MapLibre icon-image expression checks completed first, but
        // symbol-layer caching can stale when only a property changes.
        // By not stamping icon_key on completed features we guarantee
        // the expression path is ['==',completed,true] → 'stop-done'
        // with no competing 'icon_key' present.
        if (f.properties && f.properties.completed === true) {
          // Ensure no stale icon_key from a previous render
          delete f.properties.icon_key;
          prevByID[f.properties.id] = 'stop-done';
          return;
        }

        var origSeq = f.properties && f.properties.original_sequence;
        var order = f.properties && f.properties.order;
        // Pin label resolution — three-state contract (kept in sync with
        // src/utils/stopPinNumber.ts → stopPinLabel):
        //
        //   A. The Lock — locked "original_sequence" (immutable Sharpie
        //      number the driver wrote on the box). Painted RED.
        //   B. Late Freight — route is confirmed (_localRouteConfirmed
        //      computed from THIS batch of features, OR the global flag
        //      window._routeConfirmed set via setRouteConfirmed message)
        //      but THIS stop has no original_sequence. Painted PURPLE
        //      with "★" (Unicode BLACK STAR, U+2605) so the driver
        //      immediately spots a parcel that arrived after lock —
        //      never confused with the numeric planning-mode labels.
        //   C. Planning-Mode Fallback — route NOT confirmed yet. Show the
        //      proposed drive-order index ("order + 1") so drivers can
        //      review the optimised sequence on the map before pressing
        //      Confirm. Painted BLUE.
        var label;
        var ringColor;
        if (typeof origSeq === 'number' && !isNaN(origSeq)) {
          label = origSeq;
          ringColor = '#e53e31';   // red — locked Sharpie
        } else if (_localRouteConfirmed) {
          label = '\u2605';        // ★ Unicode BLACK STAR — late freight
          ringColor = '#a855f7';   // purple-500 — late-freight warning
        } else if (typeof order === 'number' && !isNaN(order)) {
          label = order + 1;
          ringColor = '#1d4ed8';   // blue — tentative drive order
        } else {
          return;
        }
        var target = (typeof origSeq === 'number')
          ? ('stop-os-' + origSeq)
          : ('stop-ord-' + label);
        if (!map.hasImage(target)) map.addImage(target, makeStopIcon(label, ringColor, 96), {pixelRatio: 2});

        // INSTANT SWAP — no setTimeout, no animation, no defer queue. Whatever
        // colour the pin should be NOW, paint it now. The previous ripple
        // implementation could leave pins stuck blue if the setTimeout
        // never fired (screen off, app background, JS thread blocked).
        f.properties.icon_key = target;
        prevByID[f.properties.id] = target;
      });
      // Build a completely fresh FeatureCollection with new object references
      // Inject _v into each feature to guarantee MapLibre sees a property change
      var freshFeatures = (d.features||[]).map(function(f){
        return {type:'Feature',geometry:{type:'Point',coordinates:f.geometry.coordinates.slice()},properties:Object.assign({},f.properties,{_v:_v})};
      });
      var fc = {type:'FeatureCollection',features:freshFeatures};
      map.getSource('stops').setData(fc);

      // ── Driveway hints feed ───────────────────────────────────────────
      // For every stop that carries (access_lat, access_lng) properties,
      // emit a paired (LineString, Point) into the driveway-hints source:
      //   - LineString from centroid -> access point -> paints the dashed
      //     connector via the driveway-hints-line layer.
      //   - Point at the access point -> paints the small purple dot via
      //     the driveway-hints-dot layer (which filters geometry-type).
      // Stops without an access point contribute zero features, so the
      // wire cost is proportional to the geocode coverage. Skips stops
      // already marked completed — once delivered, the hint clutters the
      // map without informing the remaining decisions.
      try {
        var dhFeatures = [];
        (d.features||[]).forEach(function(f){
          var p = f.properties || {};
          if (p.completed) return;
          var alat = p.access_lat;
          var alng = p.access_lng;
          if (typeof alat !== 'number' || typeof alng !== 'number') return;
          if (!f.geometry || !f.geometry.coordinates) return;
          var clng = f.geometry.coordinates[0];
          var clat = f.geometry.coordinates[1];
          if (typeof clng !== 'number' || typeof clat !== 'number') return;
          // Skip degenerate hints where the access point is essentially
          // ON the centroid (Mapbox sometimes returns access = centroid
          // for businesses without a kerb). A 5 m threshold is below
          // GPS noise but above floating-point round-off.
          var dLat = (alat - clat) * 111000;
          var dLng = (alng - clng) * 111000 * Math.cos(clat * Math.PI / 180);
          if (Math.sqrt(dLat*dLat + dLng*dLng) < 5) return;
          dhFeatures.push({
            type: 'Feature',
            properties: {stopId: p.id, kind: 'connector'},
            geometry: {type: 'LineString', coordinates: [[clng, clat], [alng, alat]]},
          });
          dhFeatures.push({
            type: 'Feature',
            properties: {stopId: p.id, kind: 'access'},
            geometry: {type: 'Point', coordinates: [alng, alat]},
          });
        });
        var dhSrc = map.getSource('driveway-hints');
        if (dhSrc) dhSrc.setData({type:'FeatureCollection',features:dhFeatures});
      } catch(e) { post({type:'log',msg:'driveway-hints update failed: '+e.message}); }

      // Force symbol layer to re-evaluate icon-image expression
      map.triggerRepaint();
      // Re-tag visible addresses so the bold "stop-number" layer reflects the
      // new stops set (added, deleted, re-optimised). If addresses aren't
      // loaded yet this is a no-op.
      try {
        var addrSrc = map.getSource('addresses');
        if (addrSrc && addrSrc._data && addrSrc._data.features && addrSrc._data.features.length) {
          addrSrc.setData({type:'FeatureCollection',features:tagAddressesWithStops(addrSrc._data.features)});
        }
      } catch(e) {}
      post({type:'log',msg:'updateStops: '+fc.features.length+' features (v'+_v+')'});
      // Only fitBounds on initial load (version 1), not on refinements
      if (_v === 1 && fc.features.length > 0) {
        var bounds = new maplibregl.LngLatBounds();
        fc.features.forEach(function(f){if(f.geometry&&f.geometry.coordinates)bounds.extend(f.geometry.coordinates);});
        if (!bounds.isEmpty()) map.fitBounds(bounds,{padding:60,maxZoom:15});
      }
    }
    if (d.type === 'updateRoute' && map.getSource('route')) {
      _fullRouteCoords = d.coordinates || [];
      // Reset progress tracking — new polyline means we must re-snap from 0.
      _routeProgressKm = 0;
      _routeTotalKm = 0;
      map.getSource('route').setData({type:'Feature',properties:{},geometry:{type:'LineString',coordinates:_fullRouteCoords}});
      // Toggle dashed style when the parent flagged this as a planning
      // PREVIEW (current to first-stop hint) rather than a road-accurate
      // active-navigation polyline. setPaintProperty with null resets
      // to the layer solid default; a [dash, gap] pair (in line-width
      // multiples) renders the dashed "this is just a hint" look.
      if (map.getLayer('route-line')) {
        try {
          map.setPaintProperty('route-line','line-dasharray', d.dashed ? [2,2] : null);
        } catch (e) { /* old MapLibre versions choke on null reset; harmless */ }
      }
      // Restore layer visibility to match _drivingMode. The route-completion
      // celebration hides 'route-line' (and shows 'route-completed-line') even
      // in planning mode; if the driver then starts a new route we need to
      // un-hide the correct layers or the new polyline renders into nothing.
      if (map.getLayer('route-line')) {
        map.setLayoutProperty('route-line','visibility', _drivingMode ? 'none' : 'visible');
      }
      if (map.getLayer('route-completed-line')) {
        map.setLayoutProperty('route-completed-line','visibility', _drivingMode ? 'visible' : 'none');
      }
      if (map.getLayer('route-upcoming-line')) {
        map.setLayoutProperty('route-upcoming-line','visibility', _drivingMode ? 'visible' : 'none');
      }
      // In driving mode the user sees route-upcoming / route-completed (not
      // 'route' which is hidden). Seed the split sources with the new leg so
      // the polyline immediately shows the NEW destination instead of the
      // stale previous leg pointing at the just-completed stop.
      if (_drivingMode) {
        if (map.getSource('route-upcoming')) {
          map.getSource('route-upcoming').setData({type:'Feature',properties:{},geometry:{type:'LineString',coordinates:_fullRouteCoords}});
        }
        if (map.getSource('route-completed')) {
          map.getSource('route-completed').setData({type:'Feature',properties:{},geometry:{type:'LineString',coordinates:[]}});
        }
        // If we know the driver, immediately compute the correct split.
        if (_puckLocation && _fullRouteCoords.length >= 2) {
          updateRouteGhost(_puckLocation.longitude, _puckLocation.latitude);
        }
      }
    }
    if (d.type === 'updateTraveled' && map.getSource('traveled')) {
      map.getSource('traveled').setData({type:'Feature',properties:{},geometry:{type:'LineString',coordinates:d.coordinates||[]}});
    }
    if (d.type === 'appendTraveled' && map.getSource('traveled')) {
      // PERF: append-only delta from the RN side. Instead of re-shipping
      // the entire breadcrumb (which can be thousands of points after a
      // workday's driving) we receive just the new tail and concatenate
      // onto the existing source. setData is still the only way to push
      // updated GeoJSON in MapLibre, but the JSON we MARSHAL is now O(1)
      // per GPS fix instead of O(N), and so is the RN→WebView bridge
      // serialization. Source merge is still O(N) but happens entirely
      // inside the WebView thread (no bridge crossing) so it's basically
      // free vs the cross-bridge cost.
      var src = map.getSource('traveled');
      var existing = (src._data && src._data.geometry && src._data.geometry.coordinates) || [];
      var tail = d.coordinates || [];
      if (tail.length === 0) return;
      var merged = existing.concat(tail);
      src.setData({type:'Feature',properties:{},geometry:{type:'LineString',coordinates:merged}});
    }
    if (d.type === 'updateHouseNumbers' && map.getSource('house-numbers')) {
      // Accepts a pre-built GeoJSON FeatureCollection from RN. Features must
      // carry properties.housenumber — the layer's text-field expression reads
      // this directly. Sent by RN after fetching /api/housenumbers on idle.
      map.getSource('house-numbers').setData(d.data || {type:'FeatureCollection',features:[]});
    }
    if (d.type === 'setNextStop' && map.getSource('next-stop')) {
      // RN pushes {lng, lat, color} of the current leg's to_stop whenever
      // currentLegIndex changes. Pass null/undefined to hide the ring.
      var features = [];
      if (typeof d.lng === 'number' && typeof d.lat === 'number') {
        features.push({
          type: 'Feature', properties: {},
          geometry: { type: 'Point', coordinates: [d.lng, d.lat] },
        });
        _nextStopLng = d.lng;
        _nextStopLat = d.lat;
      } else {
        _nextStopLng = null;
        _nextStopLat = null;
      }
      map.getSource('next-stop').setData({type:'FeatureCollection', features: features});
      _updateBuildingFade();
      // Colour coding — amber default, green=on-time, red=late. Parent derives
      // from ETA vs the stop's time_window. Applied to both the pulsing ring
      // and the static core border for a unified look.
      var color = (typeof d.color === 'string' && d.color.length > 0) ? d.color : '#f59e0b';
      if (map.getLayer('next-stop-pulse')) {
        map.setPaintProperty('next-stop-pulse','circle-color', color);
        map.setPaintProperty('next-stop-pulse','circle-stroke-color', color);
      }
      if (map.getLayer('next-stop-core')) {
        map.setPaintProperty('next-stop-core','circle-stroke-color', color);
      }
    }
    if (d.type === 'updateDriver' && map.getSource('driver')) {
      if (!d.location) {
        // Driver lost — clear the source
        map.getSource('driver').setData({type:'FeatureCollection',features:[]});
        _puckLocation = null;
        if (_puckAnimRAF) { cancelAnimationFrame(_puckAnimRAF); _puckAnimRAF = null; }
        return;
      }
      _puckLocation = d.location;
      var newBearing = d.location.heading || 0;
      // First fix → snap; subsequent fixes → smooth lerp
      if (_puckCurrentBearing == null) _puckCurrentBearing = newBearing;
      _puckTargetBearing = newBearing;

      var writeDriverFeature = function() {
        if (!_puckLocation || !map.getSource('driver')) return;
        map.getSource('driver').setData({
          type:'FeatureCollection',
          features:[{
            type:'Feature',
            geometry:{type:'Point', coordinates:[_puckLocation.longitude, _puckLocation.latitude]},
            properties:{bearing: _puckCurrentBearing}
          }]
        });
      };

      var animateBearing = function() {
        // Shortest-arc difference [-180, 180]
        var diff = _puckTargetBearing - _puckCurrentBearing;
        while (diff > 180) diff -= 360;
        while (diff < -180) diff += 360;
        if (Math.abs(diff) < 0.5) {
          _puckCurrentBearing = _puckTargetBearing;
          writeDriverFeature();
          _puckAnimRAF = null;
          return;
        }
        // 18% of remaining angle per frame → ~90% closed in ~13 frames (~220ms @60fps)
        _puckCurrentBearing = ((_puckCurrentBearing + diff * 0.18) % 360 + 360) % 360;
        writeDriverFeature();
        _puckAnimRAF = requestAnimationFrame(animateBearing);
      };

      // Always write the latest position immediately so the puck doesn't lag its GPS fix
      writeDriverFeature();
      // Kick off the bearing animation if not already running
      if (!_puckAnimRAF) _puckAnimRAF = requestAnimationFrame(animateBearing);

      // Progress the gray/blue split polyline along the route as the driver
      // moves. Safe no-op outside driving mode or when route hasn't loaded.
      if (_drivingMode && _fullRouteCoords.length >= 2) {
        updateRouteGhost(_puckLocation.longitude, _puckLocation.latitude);
      }
    }

    // ── (1) Navigation Camera POV + (2) Dynamic Bearing ──────────────────
    if (d.type === 'drivingCamera') {
      // NOTE: do NOT gate on map.loaded() — it flickers false while any tile/
      // source is loading (constant during driving), which would drop every
      // camera tick. easeTo is safe to call before all sources finish loading.
      if (!map) return;
      // If a previous easeTo is still in flight, just skip — the next tick
      // (250 ms later) will catch up. We reset the flag via the moveend event
      // below rather than a setTimeout so that a suspended JS thread can never
      // permanently lock the camera (root cause of "camera not following").
      if (_easeInFlight) return;

      var rawLng = d.center ? d.center[0] : d.lng;
      var rawLat = d.center ? d.center[1] : d.lat;
      if (rawLng == null || rawLat == null) return;

      var bearing = d.bearing || 0;
      var spd = d.speedMps || 0;

      // ── Pixel-space look-ahead offset ─────────────────────────────────
      // Push the camera centre lookAhead pixels along the heading so the
      // driver puck sits in the bottom-third of the screen, leaving the
      // road ahead visible (Google-Maps-style). Computed in screen space
      // and then unprojected so it adapts to current zoom + pitch.
      var finalCenter = [rawLng, rawLat];
      try {
        var origin = map.project([rawLng, rawLat]);
        // 0 px when stopped, up to 180 px at 25 m/s — more look-ahead at speed
        var lookAhead = Math.min(180, Math.max(40, spd * 7));
        var rad = bearing * Math.PI / 180;
        // Screen y grows downward; we want the camera centre shifted UP-along
        // bearing relative to the driver, so subtract a vector in bearing dir.
        var px = origin.x + Math.sin(rad) * lookAhead;
        var py = origin.y - Math.cos(rad) * lookAhead;
        var shifted = map.unproject([px, py]);
        finalCenter = [shifted.lng, shifted.lat];
      } catch (e) {
        // project/unproject can throw before the first style load — fall
        // back to raw coords so the camera still tracks the driver.
        finalCenter = [rawLng, rawLat];
      }

      var rawZoom = 18.5 - (spd / 25) * 4.5;
      var targetZoom = Math.max(14, Math.min(18.5, rawZoom));
      if (typeof _smoothedZoom === 'undefined') _smoothedZoom = 16.5;
      _smoothedZoom = _smoothedZoom * 0.7 + targetZoom * 0.3;

      _easeInFlight = true;
      // Listen ONCE for the next moveend — that's the canonical "easeTo
      // finished" signal. Belt-and-braces: also clear via a 600 ms watchdog
      // in case moveend is somehow suppressed (e.g. easeTo was a no-op).
      map.once('moveend', function() { _easeInFlight = false; });
      setTimeout(function() { _easeInFlight = false; }, 600);

      map.easeTo({
        center: finalCenter,
        bearing: bearing,
        pitch: 60,
        zoom: _smoothedZoom,
        duration: 400
      });
    }

    // Enter/exit driving mode — toggles 3D buildings + route pulse
    if (d.type === 'setDrivingMode') {
      _drivingMode = !!d.enabled;
      if(d.backendUrl) _backendUrl = d.backendUrl;
      // Reset route progress — each driving session starts fresh at the line origin.
      _routeProgressKm = 0;
      _routeTotalKm = 0;
      if (map.getLayer('buildings-3d')) map.setLayoutProperty('buildings-3d','visibility','visible'); // OSM worldwide: ALWAYS on — fallback for non-QLD.
      if (map.getLayer('buildings-self-3d')) map.setLayoutProperty('buildings-self-3d','visibility','visible'); // QLD cadastre: ALWAYS on — OSM is empty in new estates, so this is the only source.
      _updateBuildingFade(); // Re-evaluate fade: fade near next-stop only while driving, full opacity otherwise.
      if (map.getLayer('route-pulse')) map.setLayoutProperty('route-pulse','visibility',_drivingMode?'visible':'none');
      // Ghost-split (gray completed + blue upcoming) only in driving mode. Hide the plain
      // purple 'route-line' behind it so the user sees distinct segments, not a continuous line.
      if (map.getLayer('route-line')) map.setLayoutProperty('route-line','visibility',_drivingMode?'none':'visible');
      if (map.getLayer('route-completed-line')) map.setLayoutProperty('route-completed-line','visibility',_drivingMode?'visible':'none');
      if (map.getLayer('route-upcoming-line'))  map.setLayoutProperty('route-upcoming-line','visibility',_drivingMode?'visible':'none');
      if (map.getLayer('route-chase'))          map.setLayoutProperty('route-chase','visibility',_drivingMode?'visible':'none');
      // Next-stop pulse ring (amber) — strongest visual anchor on the map.
      if (map.getLayer('next-stop-pulse')) map.setLayoutProperty('next-stop-pulse','visibility',_drivingMode?'visible':'none');
      if (map.getLayer('next-stop-core'))  map.setLayoutProperty('next-stop-core','visibility',_drivingMode?'visible':'none');
      // Seed the upcoming line with the full route so it's visible before the first GPS lineSlice tick.
      if (_drivingMode && _fullRouteCoords.length >= 2) {
        if (map.getSource('route-upcoming'))  map.getSource('route-upcoming').setData({type:'Feature',properties:{},geometry:{type:'LineString',coordinates:_fullRouteCoords}});
        if (map.getSource('route-completed')) map.getSource('route-completed').setData({type:'Feature',properties:{},geometry:{type:'LineString',coordinates:[]}});
      }
      // Start/stop pulse animation
      if (_drivingMode && !_pulseRAF) { _pulseRAF = requestAnimationFrame(animatePulse); }
      if (!_drivingMode && _pulseRAF) { cancelAnimationFrame(_pulseRAF); _pulseRAF = null; }
      // Progress ring — visible only in driving mode, reset to 0% on entry/exit
      var ringEl = document.getElementById('hud-ring');
      var ringFillEl = document.getElementById('hud-ring-fill');
      var ringPctEl = document.getElementById('hud-ring-pct');
      if (ringEl) ringEl.style.display = _drivingMode ? 'block' : 'none';
      if (ringFillEl) ringFillEl.style.strokeDashoffset = '125.66';
      if (ringPctEl) ringPctEl.textContent = '0%';
      // Load building tiles immediately when entering driving mode
      if (_drivingMode) loadBuildingTiles();
      // Reset camera to 2D when exiting
      if (!_drivingMode) {
        map.easeTo({pitch:0,bearing:0,duration:600});
      }
    }

    if (d.type === 'flyTo') map.flyTo({center:d.center,zoom:d.zoom||14,bearing:d.bearing||0,pitch:d.pitch||0,duration:d.duration||1000});
    if (d.type === 'jumpTo') map.jumpTo({center:d.center,bearing:d.bearing||0,pitch:d.pitch||0});
    if (d.type === 'fitBounds') map.fitBounds(d.bounds,{padding:d.padding||60});

    // ── Route completion celebration ──────────────────────────────────────
    // Animate the completed polyline from gray → success-green over 1.6s and thicken it
    // briefly so the driver visually registers the finish. Pins the full route to the
    // completed source so the green line covers the whole journey, not just the slice
    // that was gray at the last GPS tick.
    if (d.type === 'celebrateCompletion') {
      if (map.getSource('route-completed') && _fullRouteCoords.length >= 2) {
        map.getSource('route-completed').setData({type:'Feature',properties:{},geometry:{type:'LineString',coordinates:_fullRouteCoords}});
      }
      if (map.getSource('route-upcoming')) {
        map.getSource('route-upcoming').setData({type:'Feature',properties:{},geometry:{type:'LineString',coordinates:[]}});
      }
      // Snap the progress ring to 100% on completion.
      var celebRingFill = document.getElementById('hud-ring-fill');
      var celebRingPct = document.getElementById('hud-ring-pct');
      if (celebRingFill) celebRingFill.style.strokeDashoffset = '0';
      if (celebRingPct) celebRingPct.textContent = '100%';
      // Ensure the completed line is visible even in non-driving mode so the driver sees it post-route.
      if (map.getLayer('route-completed-line')) map.setLayoutProperty('route-completed-line','visibility','visible');
      if (map.getLayer('route-line'))           map.setLayoutProperty('route-line','visibility','none');

      var startColor = [107, 114, 128];   // #6b7280 gray
      var endColor   = [16, 185, 129];    // #10b981 success green
      var startTime = null;
      var DURATION = 1600;
      var animCelebrate = function(t) {
        if (startTime === null) startTime = t;
        var progress = Math.min(1, (t - startTime) / DURATION);
        var ease = 1 - Math.pow(1 - progress, 3); // ease-out-cubic
        var r = Math.round(startColor[0] + (endColor[0] - startColor[0]) * ease);
        var g = Math.round(startColor[1] + (endColor[1] - startColor[1]) * ease);
        var b = Math.round(startColor[2] + (endColor[2] - startColor[2]) * ease);
        var widthPulse = 4 + Math.sin(progress * Math.PI) * 4;      // 4 → 8 → 4
        var opacity    = 0.45 + ease * 0.45;                         // 0.45 → 0.9
        if (map.getLayer('route-completed-line')) {
          map.setPaintProperty('route-completed-line','line-color','rgb('+r+','+g+','+b+')');
          map.setPaintProperty('route-completed-line','line-width', widthPulse);
          map.setPaintProperty('route-completed-line','line-opacity', opacity);
        }
        if (progress < 1) requestAnimationFrame(animCelebrate);
      };
      requestAnimationFrame(animCelebrate);
    }

    // Reset celebration styling when a new route starts or completion is undone.
    if (d.type === 'resetCompletionCelebration') {
      if (map.getLayer('route-completed-line')) {
        map.setPaintProperty('route-completed-line','line-color','#6b7280');
        map.setPaintProperty('route-completed-line','line-width', 4);
        map.setPaintProperty('route-completed-line','line-opacity', 0.45);
      }
    }

    // ── Drawing mode toggle ──────────────────────────────────────────────
    if (d.type === 'setDrawingMode') {
      _drawActive = !!d.enabled;
      _drawCoords = [];
      post({type:'log',msg:'setDrawingMode: '+_drawActive});
      var overlay = document.getElementById('draw-overlay');
      if (_drawActive) {
        // Clear previous lasso before starting new draw
        if(map.getSource('lasso'))map.getSource('lasso').setData({type:'Feature',properties:{},geometry:{type:'LineString',coordinates:[]}});
        overlay.style.display = 'block';
        if(map.getLayer('lasso-line')) map.setLayoutProperty('lasso-line','visibility','visible');
        if(map.getLayer('lasso-fill')) map.setLayoutProperty('lasso-fill','visibility','visible');
      } else {
        // Hide overlay but keep lasso polygon visible (sticky)
        overlay.style.display = 'none';
      }
    }
    if (d.type === 'clearLasso') {
      if(map.getLayer('lasso-line')) map.setLayoutProperty('lasso-line','visibility','none');
      if(map.getLayer('lasso-fill')) map.setLayoutProperty('lasso-fill','visibility','none');
      if(map.getSource('lasso'))map.getSource('lasso').setData({type:'Feature',properties:{},geometry:{type:'LineString',coordinates:[]}});
      post({type:'log',msg:'clearLasso via message'});
    }
    if (d.type === 'addSectionPolygon') addSectionPoly(d.id, d.coords, d.color, d.label);
    if (d.type === 'removeSectionPolygon') removeSectionPoly(d.id);
    if (d.type === 'clearAllSectionPolygons') clearAllSectionPolys();
    if (d.type === 'setBlockRoadMode') {
      _blockRoadActive = !!d.enabled;
      // Toggle a soft visual hint (cursor/canvas tinting) so the driver
      // realises the next tap will create a zone.
      try {
        var cnv = map.getCanvas();
        if (cnv) cnv.style.filter = _blockRoadActive ? 'sepia(0.4) hue-rotate(310deg)' : '';
      } catch(_e){}
      // Show the same HTML overlay used by lasso so the touchstart
      // listener actually receives the tap (map.on('click') is unreliable
      // on Android WebView). Only show if lasso isn't already using it.
      try {
        var brmOverlay = document.getElementById('draw-overlay');
        if (brmOverlay && !_drawActive) {
          brmOverlay.style.display = _blockRoadActive ? 'block' : 'none';
        }
      } catch(_e2){}
      post({type:'log',msg:'setBlockRoadMode: '+_blockRoadActive});
    }
    if (d.type === 'setNogoZones') setNogoZones(d.zones || []);
    if (d.type === 'setRouteConfirmed') {
      // Flip the global flag the pin painter consults. Any stop missing
      // original_sequence while this is true is painted amber with "!"
      // (late freight). When false, painted blue with proposed index
      // (planning preview). NOTE: do NOT use backticks in this comment;
      // the entire WebView body lives inside a TS template literal.
      window._routeConfirmed = !!d.confirmed;
      // Re-paint the visible pins so the colour/label flips immediately
      // without waiting for a fresh viewport update.
      try {
        var src = map.getSource('stops');
        if (src && src._data) src.setData(src._data);
      } catch (_e3) {}
      post({type:'log',msg:'setRouteConfirmed: '+window._routeConfirmed});
    }
    if (d.type === 'toggleParcels') {
      _parcelsVisible = !!d.enabled;
      var vis = _parcelsVisible ? 'visible' : 'none';
      if(map.getLayer('parcels-fill')) map.setLayoutProperty('parcels-fill','visibility',vis);
      if(map.getLayer('parcels-line')) map.setLayoutProperty('parcels-line','visibility',vis);
      if(map.getLayer('address-label')) map.setLayoutProperty('address-label','visibility',vis);
      if(map.getLayer('address-label-stops')) map.setLayoutProperty('address-label-stops','visibility',vis);
      if(_parcelsVisible){ loadParcelTiles(); loadAddressTiles(); }
      else {
        if(map.getSource('parcels')) map.getSource('parcels').setData({type:'FeatureCollection',features:[]});
        if(map.getSource('addresses')) map.getSource('addresses').setData({type:'FeatureCollection',features:[]});
      }
      post({type:'log',msg:'toggleParcels: '+_parcelsVisible});
    }

    if (d.type === 'updateHUD') {
      // HUD text/badges are rendered by the React-Native NavigationPanel —
      // we keep the DOM nodes so the progress-ring painter can still update
      // hud-ring-pct silently, but never toggle the outer .hud container to
      // block (that caused "33 min / 40 km" to bleed through under the panel).
      if(d.eta!=null){document.getElementById('hud-eta').textContent=d.eta<1?'< 1 min':Math.round(d.eta)+' min';}
      if(d.distance){document.getElementById('hud-dist').textContent=d.distance;}
      if(d.speed!=null){document.getElementById('hud-speed').textContent=Math.round(d.speed);}
      // turn & outer hud container deliberately left hidden — NavigationPanel owns them.
    }
  } catch(e) {
    post({type:'error',message:e.toString()});
  }
}

window.handleMessage = function(msg) {
  try {
    var d = JSON.parse(msg);
    if (!_layersReady) { _pendingMessages.push(d); return; }
    processMessage(d);
  } catch(e) {
    post({type:'error',message:'parse error: '+e.toString()});
  }
};
<\/script>
</body></html>`;
}

// ─── Component ───────────────────────────────────────────────────────────────

const DeliveryMapInner = forwardRef<DeliveryMapRef, DeliveryMapProps>(function DeliveryMapNative(props, ref) {
  const {
    stops, routeCoordinates, driverLocation, traveledPath,
    initialCenter = [153.0251, -27.4698], initialZoom = 12,
    followDriver, onStopClick, onCameraIdle, onMapReady,
    onLassoComplete, drawingMode,
    onBlockRoadTap,
    onNogoZoneClick,
    speed, etaMinutes, distanceRemaining, nextTurn, nextStopCoord, nextStopColor,
    routeIsPreview = false,
    highFreqCameraActive = false,
  } = props;

  const webViewRef = useRef<WebView>(null);
  const [mapReady, setMapReady] = useState(false);
  const prevFollowRef = useRef(false);

  const html = React.useMemo(() => buildHtml(initialCenter, initialZoom), []);

  // Send message to WebView (double-stringify for safe JS embedding)
  const sendMsg = useCallback((msg: object) => {
    const escaped = JSON.stringify(JSON.stringify(msg));
    webViewRef.current?.injectJavaScript(`window.handleMessage(${escaped});true;`);
  }, []);

  // Imperative ref
  useImperativeHandle(ref, () => ({
    flyTo: (center, opts) => sendMsg({ type: 'flyTo', center, ...opts }),
    jumpTo: (center, opts) => sendMsg({ type: 'jumpTo', center, ...opts }),
    fitBounds: (bounds, padding) => sendMsg({ type: 'fitBounds', bounds, padding }),
    setDrawingMode: (enabled: boolean) => {
      drawingActiveRef.current = enabled;
      if (enabled) {
        // Clear previous lasso before starting new draw
        webViewRef.current?.injectJavaScript(`
          (function(){
            if(map.getSource('lasso'))map.getSource('lasso').setData({type:'Feature',properties:{},geometry:{type:'LineString',coordinates:[]}});
            var ov=document.getElementById('draw-overlay');
            ov.style.display='block';
            if(map.getLayer('lasso-line'))map.setLayoutProperty('lasso-line','visibility','visible');
            if(map.getLayer('lasso-fill'))map.setLayoutProperty('lasso-fill','visibility','visible');
            _drawActive=true;_drawCoords=[];_lassoFinishing=false;
            window.ReactNativeWebView.postMessage(JSON.stringify({type:'log',msg:'setDrawingMode: true (injected)'}));
          })();true;
        `);
      } else {
        // Hide overlay but KEEP lasso polygon visible on map (sticky)
        webViewRef.current?.injectJavaScript(`
          (function(){
            var ov=document.getElementById('draw-overlay');
            ov.style.display='none';
            _drawActive=false;_drawCoords=[];
            window.ReactNativeWebView.postMessage(JSON.stringify({type:'log',msg:'setDrawingMode: false (injected, lasso kept)'}));
          })();true;
        `);
      }
    },
    clearLasso: () => {
      webViewRef.current?.injectJavaScript(`
        (function(){
          if(map.getLayer('lasso-line'))map.setLayoutProperty('lasso-line','visibility','none');
          if(map.getLayer('lasso-fill'))map.setLayoutProperty('lasso-fill','visibility','none');
          if(map.getSource('lasso'))map.getSource('lasso').setData({type:'Feature',properties:{},geometry:{type:'LineString',coordinates:[]}});
          window.ReactNativeWebView.postMessage(JSON.stringify({type:'log',msg:'clearLasso (injected)'}));
        })();true;
      `);
    },
    addSectionPolygon: (id: number, coords: number[][], color: string, label: string) => {
      const escaped = JSON.stringify({ id, coords, color, label });
      webViewRef.current?.injectJavaScript(`
        (function(){addSectionPoly(${id},${JSON.stringify(coords)},'${color}','${label}');})();true;
      `);
    },
    removeSectionPolygon: (id: number) => {
      webViewRef.current?.injectJavaScript(`
        (function(){removeSectionPoly(${id});})();true;
      `);
    },
    clearAllSectionPolygons: () => {
      webViewRef.current?.injectJavaScript(`
        (function(){clearAllSectionPolys();})();true;
      `);
    },
    sendMessage: sendMsg,
    setBlockRoadMode: (enabled: boolean) => {
      sendMsg({ type: 'setBlockRoadMode', enabled: !!enabled });
    },
    setNogoZones: (zones) => {
      sendMsg({ type: 'setNogoZones', zones: zones || [] });
    },
    setRouteConfirmed: (confirmed: boolean) => {
      sendMsg({ type: 'setRouteConfirmed', confirmed: !!confirmed });
    },
    /** Force-clear the cached fingerprint and re-ship every stop's
     *  current state to the WebView. Belt-and-suspenders companion to
     *  POST /api/routes/confirm — Zustand state mutation should already
     *  fingerprint-bust the standard useEffect, but on slow networks /
     *  partial JSON we've seen the fingerprint match the pre-confirm
     *  shape and skip the bridge. Calling this from the Confirm Route
     *  handler guarantees the pins flip blue→red regardless of cache
     *  state. */
    forceStopsRefresh: () => {
      stopsFingerprintRef.current = '__force_refresh_' + Date.now();
    },
    toggleParcels: (enabled: boolean) => {
      webViewRef.current?.injectJavaScript(`
        (function(){
          _parcelsVisible=${enabled ? 'true' : 'false'};
          var vis=_parcelsVisible?'visible':'none';
          if(map.getLayer('parcels-fill'))map.setLayoutProperty('parcels-fill','visibility',vis);
          if(map.getLayer('parcels-line'))map.setLayoutProperty('parcels-line','visibility',vis);
          if(map.getLayer('address-label'))map.setLayoutProperty('address-label','visibility',vis);
          if(_parcelsVisible){loadParcelTiles();loadAddressTiles();}
          else{
            if(map.getSource('parcels'))map.getSource('parcels').setData({type:'FeatureCollection',features:[]});
            if(map.getSource('addresses'))map.getSource('addresses').setData({type:'FeatureCollection',features:[]});
          }
          window.ReactNativeWebView.postMessage(JSON.stringify({type:'log',msg:'toggleParcels: '+_parcelsVisible}));
        })();true;
      `);
    },
    getMap: () => null,
  }), [sendMsg]);

  // ── Toggle drawing mode on the WebView map ─────────────────────────────
  const drawingModeRef = useRef(false);
  useEffect(() => {
    if (!mapReady) return;
    // Guard: only send if actually changed (prevents rapid true→false flicker)
    if (drawingModeRef.current === !!drawingMode) return;
    drawingModeRef.current = !!drawingMode;
    if (__DEV__) console.log('[DrawingMode] sending to WebView:', !!drawingMode);
    sendMsg({ type: 'setDrawingMode', enabled: !!drawingMode });
  }, [drawingMode, mapReady, sendMsg]);

  // ── Toggle driving mode (3D buildings + pulse) when followDriver changes ──
  useEffect(() => {
    if (!mapReady) return;
    if (followDriver !== prevFollowRef.current) {
      prevFollowRef.current = !!followDriver;
      sendMsg({ type: 'setDrivingMode', enabled: !!followDriver, backendUrl: process.env.EXPO_PUBLIC_BACKEND_URL || '' });
    }
  }, [followDriver, mapReady, sendMsg]);

  // ── Sync stops ────────────────────────────────────────────────────────────
  // PERF: ship features across the WebView bridge ONLY when a map-visible
  // field actually changed. The Zustand store mints a new `stops` array on
  // every merge — including writes that never touch the map (notes,
  // tracking_number, time_window, sync-queue churn). Without this guard
  // we were re-stringifying ~30 KB of GeoJSON and crossing the bridge on
  // every keystroke in the notes editor. Fingerprint covers EXACTLY the
  // fields the WebView's renderer reads (id, completed, pending, order,
  // original_sequence, lng, lat). 5-decimal coord rounding tolerates
  // sub-meter geocoder jitter without forcing a re-ship.
  //
  // CRITICAL — `order` MUST be in this fingerprint. Planning-mode pins
  // paint their label as `order + 1` (see stop-rendering switch above),
  // so when /optimize returns a re-shuffled sequence the only field that
  // changed on each stop is `order`. Without `order` here the
  // fingerprint matches the pre-optimise value, the early-return below
  // fires, and the WebView never receives the new orders — pins display
  // the OLD sequence even though the polyline draws the new one
  // (the cause of "pins don't match the planned path" complaints).
  const stopsFingerprintRef = useRef<string>('');
  useEffect(() => {
    if (!mapReady) return;
    let fp = '';
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i] as any;
      const meta = s.geocode_metadata;
      const anp = meta && meta.access_navigation_point;
      const accessLat = anp && typeof anp.lat === 'number' ? anp.lat : null;
      const accessLng = anp && typeof anp.lng === 'number' ? anp.lng : null;
      // ML Phase 2 auto-snap: see CRASH FIX note below — single-object
      // form is bytecode-safe across all Hermes versions.
      const fpLng = typeof s.display_longitude === 'number' ? s.display_longitude : s.longitude;
      const fpLat = typeof s.display_latitude === 'number' ? s.display_latitude : s.latitude;
      fp += s.id + ':'
        + (s.completed ? '1' : '0') + ':'
        + (s.pending ? '1' : '0') + ':'
        + (typeof s.order === 'number' ? s.order : '_') + ':'
        + (typeof s.original_sequence === 'number' ? s.original_sequence : '_') + ':'
        + (typeof fpLng === 'number' ? fpLng.toFixed(5) : '_') + ':'
        + (typeof fpLat === 'number' ? fpLat.toFixed(5) : '_') + ':'
        // Access-point coords also pinned into the fingerprint so the
        // driveway-hints layer refreshes the moment the backend stamps
        // a new `access_navigation_point` (e.g. after the user taps
        // Map Fix on a problematic stop). 5-decimal precision matches
        // the centroid rounding above.
        + (typeof accessLat === 'number' ? accessLat.toFixed(5) : '_') + ':'
        + (typeof accessLng === 'number' ? accessLng.toFixed(5) : '_') + '|';
    }
    if (fp === stopsFingerprintRef.current) return;
    stopsFingerprintRef.current = fp;

    const features = stops.map(s => {
      const meta = (s as { geocode_metadata?: { access_navigation_point?: { lat?: number; lng?: number } | null } }).geocode_metadata;
      const anp = meta && meta.access_navigation_point;
      const accessLat = anp && typeof anp.lat === 'number' && !Number.isNaN(anp.lat) ? anp.lat : null;
      const accessLng = anp && typeof anp.lng === 'number' && !Number.isNaN(anp.lng) ? anp.lng : null;
      // ML Phase 2 auto-snap: prefer corrected centroid (kerb-side) when
      // backend stamped display_latitude/longitude, else raw rooftop.
      //
      // PERF/CRASH FIX: Hermes minifier has a known scoping bug where
      // const declarations referenced inside the immediately-returned
      // object literal sometimes get hoisted incorrectly, throwing
      // "Property 'pinLng' doesn't exist" in release builds (works in
      // dev). Bundling the coords into a single object avoids the
      // bytecode pattern that triggers the bug.
      const ssa = s as { display_latitude?: number | null; display_longitude?: number | null };
      const lng = typeof ssa.display_longitude === 'number' ? ssa.display_longitude : s.longitude;
      const lat = typeof ssa.display_latitude === 'number' ? ssa.display_latitude : s.latitude;
      return {
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [lng, lat] },
        properties: {
          id: s.id,
          order: s.order,
          // Sharpie-marker badge — written ONCE on first /routes/confirm,
          // never overwritten. The WebView sprite generator (see
          // processMessage(updateStops) above) renders this value as the
          // pin number when present and renders the `stop-unconfirmed`
          // sprite (a dash) when absent. NO FALLBACK to `order` / `order+1`
          // / list index — the painted pin must never display a transient
          // drive-order value that could later disagree with the locked
          // Sharpie value the driver wrote on the box.
          original_sequence: typeof (s as { original_sequence?: number | null }).original_sequence === 'number'
            ? (s as { original_sequence?: number | null }).original_sequence ?? null
            : null,
          completed: !!s.completed,
          name: s.name || '',
          pending: !!(s as any).pending,
          // Driveway hint: when the backend's reverse-geocode pipeline
          // captured an `access_navigation_point` (typically the kerb-side
          // GPS coord where a courier would actually park, distinct from
          // the address-centroid that lands on the rooftop), pass both
          // coords through. The WebView paints a tiny dot at the access
          // point + a hair-thin dashed connector back to the centroid pin
          // so drivers can SEE which side of the lot to approach from
          // before they're already past it.
          access_lat: accessLat,
          access_lng: accessLng,
        },
      };
    });
    sendMsg({ type: 'updateStops', features });
  }, [stops, mapReady, sendMsg]);

  // ── Sync route ────────────────────────────────────────────────────────────
  // PERF: same idea as stops — skip the bridge if the polyline is the
  // same one we shipped last time. Comparing length + first/last coord
  // is enough; the OSRM payload is deterministic for a given waypoint
  // sequence, so two identical-length polylines with matching endpoints
  // are byte-for-byte identical in 99.99 % of real cases.
  const routeFingerprintRef = useRef<string>('');
  useEffect(() => {
    if (!mapReady) return;
    const coords = routeCoordinates || [];
    const first = coords[0];
    const last = coords[coords.length - 1];
    const fp = coords.length + ':'
      + (first ? first[0].toFixed(5) + ',' + first[1].toFixed(5) : '_') + ':'
      + (last ? last[0].toFixed(5) + ',' + last[1].toFixed(5) : '_');
    if (fp === routeFingerprintRef.current) return;
    routeFingerprintRef.current = fp;
    sendMsg({ type: 'updateRoute', coordinates: coords, dashed: routeIsPreview });
  }, [routeCoordinates, mapReady, sendMsg, routeIsPreview]);

  // ── Sync traveled path ────────────────────────────────────────────────────
  // PERF (the big win after 50+ stops): the breadcrumb can grow to
  // thousands of points over a workday, and the previous code re-shipped
  // the ENTIRE array across the WebView bridge on every GPS fix. Now we
  // track how many points the WebView has already received and ship
  // only the new tail via a fresh `appendTraveled` message. WebView side
  // concatenates onto its existing source. Falls back to a full replace
  // if the array shrunk (route ended / restarted).
  const lastSentTraveledLenRef = useRef(0);
  useEffect(() => {
    if (!mapReady) return;
    const path = traveledPath || [];
    const lastLen = lastSentTraveledLenRef.current;
    if (path.length === lastLen) return;
    if (path.length < lastLen) {
      // Shrinkage = reset (route ended). Replace, not append.
      lastSentTraveledLenRef.current = path.length;
      sendMsg({ type: 'updateTraveled', coordinates: path });
      return;
    }
    const tail = path.slice(lastLen);
    lastSentTraveledLenRef.current = path.length;
    sendMsg({ type: 'appendTraveled', coordinates: tail });
  }, [traveledPath, mapReady, sendMsg]);

  // ── Sync driver location + (1)(2) driving camera with look-ahead ─────────
  //
  // Camera write policy:
  //   • `updateDriver` (the GeoJSON puck position) is ALWAYS sent — it's just
  //     a marker move, not a camera command, so there is no contention.
  //   • `drivingCamera` (centre + bearing + zoom) is ONLY sent here when no
  //     other writer is active. The parent's `useNavigationCamera` hook
  //     runs an independent 250 ms GPS watch and writes `drivingCamera`
  //     directly to the WebView. If both writers fire, the map snaps
  //     between two slightly different centres/bearings every render —
  //     the original "camera tug-of-war" bug.
  //
  //   When `highFreqCameraActive === true`, this effect defers to the hook
  //   (single writer, runs at 4 Hz, computes look-ahead in pixel-space
  //   inside the WebView so it adapts to zoom/pitch).
  //
  //   When `highFreqCameraActive === false`, this effect retains the legacy
  //   behaviour (lat/lng look-ahead) for callers that haven't wired the
  //   hook yet.
  useEffect(() => {
    if (!mapReady) return;
    // Always update the driver GeoJSON marker position
    sendMsg({ type: 'updateDriver', location: driverLocation });

    if (highFreqCameraActive) return; // hook owns the camera — bail out

    // Legacy single-writer path (used in planning preview / non-nav modes)
    if (driverLocation && followDriver) {
      const hdg = driverLocation.heading ?? 0;
      const rad = hdg * Math.PI / 180;
      // Offset center in the direction of travel so driver sits in bottom third
      const lng = driverLocation.longitude + Math.sin(rad) * LOOK_AHEAD;
      const lat = driverLocation.latitude + Math.cos(rad) * LOOK_AHEAD;

      sendMsg({
        type: 'drivingCamera',
        center: [lng, lat],
        bearing: hdg,
        speedMps: (speed ?? 0) / 3.6, // convert km/h back to m/s for zoom calc
      });
    }
  }, [driverLocation, followDriver, speed, mapReady, sendMsg, highFreqCameraActive]);

  // ── Sync HUD ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapReady) return;
    sendMsg({
      type: 'updateHUD',
      speed: speed ?? null,
      eta: etaMinutes ?? null,
      distance: distanceRemaining ?? null,
      turn: nextTurn?.instruction ?? null,
    });
  }, [speed, etaMinutes, distanceRemaining, nextTurn, mapReady, sendMsg]);

  // ── Next-stop pulse ring ──────────────────────────────────────────────────
  // Pushes the current leg's destination coord into the WebView whenever the
  // parent advances currentLegIndex. The map renders a pulsing amber ring on
  // top of that point so drivers spot their target in a glance.
  useEffect(() => {
    if (!mapReady) return;
    if (nextStopCoord && Array.isArray(nextStopCoord) && nextStopCoord.length >= 2) {
      sendMsg({
        type: 'setNextStop',
        lng: nextStopCoord[0],
        lat: nextStopCoord[1],
        color: nextStopColor || null,
      });
    } else {
      sendMsg({ type: 'setNextStop', lng: null, lat: null });
    }
  }, [nextStopCoord, nextStopColor, mapReady, sendMsg]);

  // ── Handle messages from WebView ──────────────────────────────────────────
  // Track last-fetched bbox key to suppress duplicate fetches across moveends.
  const lastHnKey = useRef<string>('');
  const hnAbortRef = useRef<AbortController | null>(null);

  const fetchHouseNumbersForCamera = useCallback(
    async (centerLng: number, centerLat: number, zoom: number) => {
      if (zoom < 17) return; // below threshold — skip network + clear layer
      const BACKEND = process.env.EXPO_PUBLIC_BACKEND_URL || '';
      if (!BACKEND) return;
      // Approximate bbox from center + zoom-based radius. 1 deg lat ≈ 111 km.
      // Radius widens at lower zooms so we load a useful neighbourhood even
      // if the WebView hasn't pushed bounds explicitly.
      const radiusDeg = zoom >= 19 ? 0.0015 : zoom >= 18 ? 0.0025 : 0.004;
      const lonMin = centerLng - radiusDeg;
      const latMin = centerLat - radiusDeg;
      const lonMax = centerLng + radiusDeg;
      const latMax = centerLat + radiusDeg;
      const bboxKey = [lonMin, latMin, lonMax, latMax]
        .map((v) => v.toFixed(4))
        .join(',');
      if (bboxKey === lastHnKey.current) return;
      lastHnKey.current = bboxKey;

      hnAbortRef.current?.abort();
      const ctrl = new AbortController();
      hnAbortRef.current = ctrl;
      try {
        const resp = await fetch(
          `${BACKEND}/api/housenumbers?bbox=${bboxKey}&limit=400`,
          { signal: ctrl.signal },
        );
        if (!resp.ok) return;
        const data = await resp.json();
        if (!data || !data.features) return;
        sendMsg({ type: 'updateHouseNumbers', data });
      } catch (e: any) {
        if (e?.name !== 'AbortError') {
          if (__DEV__) console.warn('[HouseNumbers] fetch failed', e);
        }
      }
    },
    [sendMsg],
  );

  const onMessage = useCallback((event: { nativeEvent: { data: string } }) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      switch (msg.type) {
        case 'ready':
          setMapReady(true);
          onMapReady?.();
          break;
        case 'stopClick':
          onStopClick?.(msg.id);
          break;
        case 'lassoComplete':
          onLassoComplete?.(msg.stopIds || [], msg.polygon || []);
          break;
        case 'blockRoadTap':
          if (typeof msg.lat === 'number' && typeof msg.lng === 'number') {
            onBlockRoadTap?.(msg.lat, msg.lng);
          }
          break;
        case 'nogoZoneClick':
          if (msg.id) onNogoZoneClick?.(msg.id, msg.name || '');
          break;
        case 'cameraIdle':
          onCameraIdle?.({ lng: msg.lng, lat: msg.lat }, msg.zoom);
          // Piggy-back on the same idle event to refresh house numbers.
          fetchHouseNumbersForCamera(msg.lng, msg.lat, msg.zoom);
          break;
        case 'log':
          if (__DEV__) console.log('[MapWebView]', msg.msg);
          break;
        case 'error':
          console.warn('[MapWebView Error]', msg.message);
          break;
      }
    } catch {}
  }, [onMapReady, onStopClick, onCameraIdle, onLassoComplete, onBlockRoadTap, onNogoZoneClick, fetchHouseNumbersForCamera]);

  // RN-level touch capture for lasso drawing (bypasses WebView touch blocking)
  const drawingActiveRef = useRef(false);
  const handleTouchStart = useCallback((e: any) => {
    if (!drawingActiveRef.current) return;
    const touch = e.nativeEvent;
    const x = touch.locationX;
    const y = touch.locationY;
    webViewRef.current?.injectJavaScript(`
      (function(){
        var pt=map.unproject([${x},${y}]);
        _drawCoords=[[pt.lng,pt.lat]];_drawThrottle=0;
        updateLasso();
        window.ReactNativeWebView.postMessage(JSON.stringify({type:'log',msg:'lasso touchstart: '+pt.lng.toFixed(4)+','+pt.lat.toFixed(4)}));
      })();true;
    `);
  }, []);
  const touchThrottleRef = useRef(0);
  const handleTouchMove = useCallback((e: any) => {
    if (!drawingActiveRef.current) return;
    touchThrottleRef.current++;
    if (touchThrottleRef.current % 2 !== 0) return;
    const touch = e.nativeEvent;
    const x = touch.locationX;
    const y = touch.locationY;
    webViewRef.current?.injectJavaScript(`
      (function(){
        if(_drawCoords.length===0)return;
        var pt=map.unproject([${x},${y}]);
        _drawCoords.push([pt.lng,pt.lat]);
        updateLasso();
      })();true;
    `);
  }, []);
  const handleTouchEnd = useCallback(() => {
    if (!drawingActiveRef.current) return;
    touchThrottleRef.current = 0;
    webViewRef.current?.injectJavaScript(`
      (function(){
        if(_drawCoords.length>=3){
          window.ReactNativeWebView.postMessage(JSON.stringify({type:'log',msg:'lasso touchend: '+_drawCoords.length+' points'}));
          finishLasso();
        }
      })();true;
    `);
  }, []);

  return (
    <View
      style={styles.container}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <WebView
        ref={webViewRef}
        source={{ html }}
        style={styles.webview}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
        onMessage={onMessage}
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        androidLayerType="hardware"
        mixedContentMode="always"
        allowFileAccess
        webviewDebuggingEnabled={__DEV__}
        cacheEnabled
        cacheMode="LOAD_DEFAULT"
        setSupportMultipleWindows={false}
        startInLoadingState={false}
        renderToHardwareTextureAndroid
      />
    </View>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1, overflow: 'hidden' },
  webview: { flex: 1, backgroundColor: '#1a1a2e' },
});

export const DeliveryMap = React.memo(DeliveryMapInner);
export default DeliveryMap;
