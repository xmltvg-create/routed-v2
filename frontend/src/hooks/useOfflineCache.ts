import { useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const CACHE_KEYS = {
  STOPS: 'offline_stops',
  ROUTE_GEOMETRY: 'offline_route_geometry',
  NAVIGATION_DATA: 'offline_navigation_data',
  LAST_SYNC: 'offline_last_sync',
};

interface OfflineState {
  isOffline: boolean;
  lastSyncTime: string | null;
  hasCachedData: boolean;
}

export function useOfflineCache() {
  const [offlineState, setOfflineState] = useState<OfflineState>({
    isOffline: false,
    lastSyncTime: null,
    hasCachedData: false,
  });

  // Check for cached data on mount
  useEffect(() => {
    (async () => {
      const lastSync = await AsyncStorage.getItem(CACHE_KEYS.LAST_SYNC);
      const cachedStops = await AsyncStorage.getItem(CACHE_KEYS.STOPS);
      setOfflineState(prev => ({
        ...prev,
        lastSyncTime: lastSync,
        hasCachedData: !!cachedStops,
      }));
    })();
  }, []);

  // Save stops to offline cache
  const cacheStops = useCallback(async (stops: any[]) => {
    try {
      await AsyncStorage.setItem(CACHE_KEYS.STOPS, JSON.stringify(stops));
      const now = new Date().toISOString();
      await AsyncStorage.setItem(CACHE_KEYS.LAST_SYNC, now);
      setOfflineState(prev => ({ ...prev, lastSyncTime: now, hasCachedData: true }));
    } catch (e) {
      console.warn('Failed to cache stops:', e);
    }
  }, []);

  // Save route geometry to offline cache
  const cacheRouteGeometry = useCallback(async (geometry: any) => {
    try {
      if (geometry) {
        await AsyncStorage.setItem(CACHE_KEYS.ROUTE_GEOMETRY, JSON.stringify(geometry));
      }
    } catch (e) {
      console.warn('Failed to cache route geometry:', e);
    }
  }, []);

  // Save navigation data to offline cache
  const cacheNavigationData = useCallback(async (navData: any) => {
    try {
      if (navData) {
        await AsyncStorage.setItem(CACHE_KEYS.NAVIGATION_DATA, JSON.stringify(navData));
      }
    } catch (e) {
      console.warn('Failed to cache navigation data:', e);
    }
  }, []);

  // Load cached stops
  const loadCachedStops = useCallback(async (): Promise<any[] | null> => {
    try {
      const data = await AsyncStorage.getItem(CACHE_KEYS.STOPS);
      return data ? JSON.parse(data) : null;
    } catch (e) {
      console.warn('Failed to load cached stops:', e);
      return null;
    }
  }, []);

  // Load cached route geometry
  const loadCachedRouteGeometry = useCallback(async (): Promise<any | null> => {
    try {
      const data = await AsyncStorage.getItem(CACHE_KEYS.ROUTE_GEOMETRY);
      return data ? JSON.parse(data) : null;
    } catch (e) {
      console.warn('Failed to load cached route geometry:', e);
      return null;
    }
  }, []);

  // Load cached navigation data
  const loadCachedNavigationData = useCallback(async (): Promise<any | null> => {
    try {
      const data = await AsyncStorage.getItem(CACHE_KEYS.NAVIGATION_DATA);
      return data ? JSON.parse(data) : null;
    } catch (e) {
      console.warn('Failed to load cached navigation data:', e);
      return null;
    }
  }, []);

  // Set offline status
  const setIsOffline = useCallback((offline: boolean) => {
    setOfflineState(prev => ({ ...prev, isOffline: offline }));
  }, []);

  // Clear all cached data
  const clearCache = useCallback(async () => {
    try {
      await AsyncStorage.multiRemove(Object.values(CACHE_KEYS));
      setOfflineState({ isOffline: false, lastSyncTime: null, hasCachedData: false });
    } catch (e) {
      console.warn('Failed to clear cache:', e);
    }
  }, []);

  return {
    ...offlineState,
    setIsOffline,
    cacheStops,
    cacheRouteGeometry,
    cacheNavigationData,
    loadCachedStops,
    loadCachedRouteGeometry,
    loadCachedNavigationData,
    clearCache,
  };
}
