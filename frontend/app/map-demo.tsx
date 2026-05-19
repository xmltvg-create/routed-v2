/**
 * DeliveryMapDemo — standalone demo page for the react-map-gl DeliveryMap.
 * Tests: GPS simulation, 3D buildings, smooth camera, HUD overlays, route pulse.
 */

import React, { useRef, useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, Pressable, Platform } from 'react-native';
import { DeliveryMap, DeliveryMapRef, DeliveryStop, DriverLocation } from '../src/components/DeliveryMap';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || '';

export default function MapDemoPage() {
  const mapRef = useRef<DeliveryMapRef>(null);
  const [stops, setStops] = useState<DeliveryStop[]>([]);
  const [routeCoords, setRouteCoords] = useState<number[][] | null>(null);
  const [driverLoc, setDriverLoc] = useState<DriverLocation | null>(null);
  const [followDriver, setFollowDriver] = useState(false);
  const [traveledPath, setTraveledPath] = useState<number[][] | null>(null);
  const [simRunning, setSimRunning] = useState(false);
  const simRef = useRef<ReturnType<typeof setInterval>>();
  const simIdx = useRef(0);
  const [mapReady, setMapReady] = useState(false);
  const [cameraInfo, setCameraInfo] = useState('idle');

  // HUD state for demo
  const [speed, setSpeed] = useState<number | null>(null);
  const [eta, setEta] = useState<number | null>(null);
  const [distLeft, setDistLeft] = useState<string | null>(null);
  const [nextTurn, setNextTurn] = useState<{ instruction: string; distance: string } | null>(null);

  // Fetch stops from API
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/api/stops`);
        const data = await res.json();
        const mapped: DeliveryStop[] = (data || []).map((s: any) => ({
          id: s.id,
          latitude: s.latitude,
          longitude: s.longitude,
          address: s.address,
          name: s.name,
          order: s.order ?? 0,
          completed: s.completed ?? false,
        }));
        setStops(mapped);

        if (mapped.length >= 2) {
          const coords = mapped.map(s => `${s.longitude},${s.latitude}`).join(';');
          const routeRes = await fetch(`${BACKEND_URL}/api/directions?coordinates=${coords}`);
          const routeData = await routeRes.json();
          if (routeData?.geometry?.coordinates) {
            setRouteCoords(routeData.geometry.coordinates);
          }
        }
      } catch (e) {
        console.error('Failed to load stops:', e);
      }
    })();
  }, []);

  // Simulate GPS along the route with HUD data
  const startSimulation = useCallback(() => {
    if (!routeCoords || routeCoords.length < 2) return;
    simIdx.current = 0;
    setFollowDriver(true);
    setSimRunning(true);
    const traveled: number[][] = [];
    const totalPts = routeCoords.length;

    const turnInstructions = [
      'Turn right onto Bokarina Blvd',
      'Continue straight',
      'Turn left onto Offshore St',
      'Bear right onto Quiver St',
      'Arrive at destination',
    ];

    simRef.current = setInterval(() => {
      if (simIdx.current >= totalPts) {
        clearInterval(simRef.current);
        setSimRunning(false);
        setSpeed(null);
        setEta(null);
        setDistLeft(null);
        setNextTurn(null);
        return;
      }
      const curr = routeCoords[simIdx.current];
      const next = routeCoords[Math.min(simIdx.current + 1, totalPts - 1)];
      const heading = Math.atan2(next[0] - curr[0], next[1] - curr[1]) * (180 / Math.PI);

      setDriverLoc({ latitude: curr[1], longitude: curr[0], heading });
      traveled.push(curr);
      setTraveledPath([...traveled]);

      // Simulate HUD values
      const progress = simIdx.current / totalPts;
      setSpeed(35 + Math.random() * 25);
      setEta(Math.max(1, Math.round((1 - progress) * 12)));
      setDistLeft(`${((1 - progress) * 1.9).toFixed(1)} km`);
      const turnIdx = Math.min(Math.floor(progress * turnInstructions.length), turnInstructions.length - 1);
      const turnDist = Math.max(50, Math.round((1 - (progress % 0.2) / 0.2) * 400));
      setNextTurn({
        instruction: turnInstructions[turnIdx],
        distance: `${turnDist} m`,
      });

      simIdx.current += 3;
    }, 500);
  }, [routeCoords]);

  const stopSimulation = useCallback(() => {
    clearInterval(simRef.current);
    setSimRunning(false);
    setFollowDriver(false);
    setSpeed(null);
    setEta(null);
    setDistLeft(null);
    setNextTurn(null);
  }, []);

  const handleStopClick = useCallback((stopId: string) => {
    const s = stops.find(st => st.id === stopId);
    if (s) console.log('Stop clicked:', s.address);
  }, [stops]);

  const handleCameraIdle = useCallback((center: { lng: number; lat: number }, zoom: number) => {
    setCameraInfo(`${center.lat.toFixed(4)}, ${center.lng.toFixed(4)} z${zoom.toFixed(1)}`);
  }, []);

  const handleFitRoute = useCallback(() => {
    if (!stops.length) return;
    const lngs = stops.map(s => s.longitude);
    const lats = stops.map(s => s.latitude);
    mapRef.current?.fitBounds(
      [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      80,
    );
  }, [stops]);

  return (
    <View style={styles.container}>
      <DeliveryMap
        ref={mapRef}
        stops={stops}
        routeCoordinates={routeCoords}
        driverLocation={driverLoc}
        traveledPath={traveledPath}
        followDriver={followDriver}
        onStopClick={handleStopClick}
        onCameraIdle={handleCameraIdle}
        onMapReady={() => setMapReady(true)}
        speed={speed}
        etaMinutes={eta}
        distanceRemaining={distLeft}
        nextTurn={nextTurn}
      />

      {/* Control overlay */}
      <View style={styles.controls}>
        <Text style={styles.title}>DeliveryMap Demo</Text>
        <Text style={styles.info}>
          {stops.length} stops | {routeCoords?.length ?? 0} route pts | {mapReady ? 'ready' : 'loading'}
        </Text>
        <Text style={styles.info}>Camera: {cameraInfo}</Text>

        <View style={styles.row}>
          <Pressable style={styles.btn} onPress={handleFitRoute}>
            <Text style={styles.btnText}>Fit Route</Text>
          </Pressable>

          {!simRunning ? (
            <Pressable style={[styles.btn, styles.btnGreen]} onPress={startSimulation}>
              <Text style={styles.btnText}>Simulate GPS</Text>
            </Pressable>
          ) : (
            <Pressable style={[styles.btn, styles.btnRed]} onPress={stopSimulation}>
              <Text style={styles.btnText}>Stop Sim</Text>
            </Pressable>
          )}

          <Pressable
            style={[styles.btn, followDriver && styles.btnActive]}
            onPress={() => setFollowDriver(f => !f)}
          >
            <Text style={styles.btnText}>Follow: {followDriver ? 'ON' : 'OFF'}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  controls: {
    position: 'absolute',
    top: Platform.OS === 'web' ? 12 : 50,
    left: 12,
    right: 12,
    backgroundColor: 'rgba(15,23,42,0.88)',
    borderRadius: 12,
    padding: 14,
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(8px)' } : {}),
    zIndex: 20,
  },
  title: { color: '#f1f5f9', fontWeight: '700', fontSize: 16, marginBottom: 4 },
  info: { color: '#94a3b8', fontSize: 12, marginBottom: 2 },
  row: { flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' },
  btn: {
    backgroundColor: '#334155',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  btnGreen: { backgroundColor: '#16a34a' },
  btnRed: { backgroundColor: '#dc2626' },
  btnActive: { backgroundColor: '#6366f1' },
  btnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
});
