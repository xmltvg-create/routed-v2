import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

export default function AndroidAutoSetupScreen() {
  const router = useRouter();

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <View style={styles.headerRow}>
          <Ionicons name="car-sport-outline" size={24} color="#2563eb" />
          <Text style={styles.title}>Android Auto</Text>
        </View>
        <Text style={styles.subtitle}>
          Full Android Auto support is enabled for Development Build mode.
        </Text>

        <View style={styles.badgeRow}>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>Mode: Dev Build</Text>
          </View>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>Platform: Android</Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Included</Text>
          <Text style={styles.line}>• Android Auto manifest + service wiring via config plugin</Text>
          <Text style={styles.line}>• Car screens: next stops list + stop details</Text>
          <Text style={styles.line}>• In-car actions: delivered / skip / failed</Text>
          <Text style={styles.line}>• Backend APIs: /api/car/next-stops and /api/car/stop-action</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Build Steps</Text>
          <Text style={styles.code}>npx expo prebuild --platform android</Text>
          <Text style={styles.code}>npx expo run:android</Text>
          <Text style={styles.code}># or use EAS dev build for real head unit testing</Text>
        </View>

        {Platform.OS !== 'android' && (
          <View style={styles.warning}>
            <Ionicons name="alert-circle-outline" size={16} color="#b45309" />
            <Text style={styles.warningText}>This screen is informational on non-Android platforms.</Text>
          </View>
        )}
      </View>

      <TouchableOpacity
        style={styles.backButton}
        onPress={() => router.back()}
        testID="android-auto-back-button"
      >
        <Ionicons name="arrow-back" size={18} color="#fff" />
        <Text style={styles.backText}>Back</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  content: { padding: 16, gap: 16 },
  card: { backgroundColor: '#fff', borderRadius: 16, borderWidth: 1, borderColor: '#dbeafe', padding: 16 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  title: { fontSize: 24, fontWeight: '700', color: '#1e3a8a' },
  subtitle: { fontSize: 14, color: '#334155', lineHeight: 22 },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  badge: { backgroundColor: '#eff6ff', borderColor: '#bfdbfe', borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  badgeText: { color: '#1d4ed8', fontSize: 12, fontWeight: '600' },
  section: { marginTop: 16, gap: 6 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: '#475569', textTransform: 'uppercase' },
  line: { fontSize: 14, color: '#0f172a' },
  code: { fontFamily: 'monospace', fontSize: 12, color: '#0f172a', backgroundColor: '#f1f5f9', padding: 10, borderRadius: 8 },
  warning: { marginTop: 12, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#fef3c7', borderRadius: 8, padding: 10 },
  warningText: { color: '#92400e', fontSize: 12, flex: 1 },
  backButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#2563eb', borderRadius: 12, paddingVertical: 14 },
  backText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
