import React, { useEffect } from 'react';
import { Tabs, usePathname } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as NavigationBar from 'expo-navigation-bar';

export default function TabLayout() {
  const pathname = usePathname();
  const isMapTab = pathname === '/' || pathname === '';
  // Safe-area inset reflects the height of the Android system nav bar (or
  // iOS home-indicator). Without this, the tab bar sits UNDER the system
  // gesture pill / 3-button bar — taps on Stops/Profile get swallowed by
  // Android. We only pad when the system bar is actually visible (i.e.
  // NOT the map tab, where we go immersive).
  const insets = useSafeAreaInsets();

  // Immersive mode: only hide Android nav bar on map tab, keep status bar
  useEffect(() => {
    if (Platform.OS !== 'android') return;

    if (isMapTab) {
      NavigationBar.setVisibilityAsync('hidden');
      NavigationBar.setBehaviorAsync('overlay-swipe');
      NavigationBar.setBackgroundColorAsync('#00000000');
    } else {
      NavigationBar.setVisibilityAsync('visible');
    }
  }, [isMapTab]);

  // Additional space we need to clear the system nav bar. On the map tab
  // the bar is hidden so no pad required; elsewhere use the inset (with a
  // small minimum so the labels never kiss the edge on devices that
  // report 0 inset).
  const systemNavPad = isMapTab ? 0 : Math.max(insets.bottom, 8);

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: '#3b82f6',
        tabBarInactiveTintColor: '#94a3b8',
        tabBarStyle: {
          backgroundColor: '#ffffff',
          borderTopColor: '#e2e8f0',
          borderTopWidth: 1,
          height: (Platform.OS === 'android' ? 60 : 85) + systemNavPad,
          paddingBottom: (Platform.OS === 'android' ? 8 : 28) + systemNavPad,
          paddingTop: 6,
          elevation: 8,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: -2 },
          shadowOpacity: 0.08,
          shadowRadius: 4,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '600',
        },
        headerShown: false,
      }}
      sceneContainerStyle={{ backgroundColor: '#f8fafc' }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Route',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="map" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="stops"
        options={{
          title: 'Stops',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="location" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="person" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
