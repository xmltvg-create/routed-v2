import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useStopsStore } from '../src/store/stopsStore';

export default function EditStopScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { stops, updateStop } = useStopsStore();
  
  const stop = stops.find((s) => s.id === id);
  
  const [name, setName] = useState(stop?.name || '');
  const [priority, setPriority] = useState<'high' | 'medium' | 'low'>(
    (stop?.priority as 'high' | 'medium' | 'low') || 'medium'
  );
  const [timeStart, setTimeStart] = useState(stop?.time_window?.start || '');
  const [timeEnd, setTimeEnd] = useState(stop?.time_window?.end || '');
  const [notes, setNotes] = useState(stop?.notes || '');
  const [saving, setSaving] = useState(false);

  if (!stop) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>Stop not found</Text>
          <TouchableOpacity onPress={() => router.back()}>
            <Text style={styles.backLink}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateStop(stop.id, {
        name: name || undefined,
        priority,
        time_window: (timeStart || timeEnd) ? {
          start: timeStart || undefined,
          end: timeEnd || undefined,
        } : undefined,
        notes: notes || undefined,
      });
      router.back();
    } catch (error) {
      console.error('Save error:', error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()}>
            <Ionicons name="close" size={28} color="#f8fafc" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Edit Stop</Text>
          <TouchableOpacity onPress={handleSave} disabled={saving}>
            {saving ? (
              <ActivityIndicator size="small" color="#3b82f6" />
            ) : (
              <Text style={styles.saveButton}>Save</Text>
            )}
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.content}>
          {/* Address (Read-only) */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Location</Text>
            <View style={styles.addressCard}>
              <Ionicons name="location" size={20} color="#3b82f6" />
              <Text style={styles.addressText}>{stop.address}</Text>
            </View>
          </View>

          {/* Stop Name */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Name (Optional)</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g., John's House, Office"
              placeholderTextColor="#64748b"
              value={name}
              onChangeText={setName}
            />
          </View>

          {/* Priority */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Priority</Text>
            <View style={styles.priorityButtons}>
              {(['high', 'medium', 'low'] as const).map((p) => (
                <TouchableOpacity
                  key={p}
                  style={[
                    styles.priorityButton,
                    priority === p && styles.priorityButtonActive,
                    priority === p && p === 'high' && styles.priorityHigh,
                    priority === p && p === 'low' && styles.priorityLow,
                  ]}
                  onPress={() => setPriority(p)}
                >
                  <Ionicons
                    name={p === 'high' ? 'flag' : 'flag-outline'}
                    size={18}
                    color={priority === p ? '#fff' : '#94a3b8'}
                  />
                  <Text
                    style={[
                      styles.priorityButtonText,
                      priority === p && styles.priorityButtonTextActive,
                    ]}
                  >
                    {p.charAt(0).toUpperCase() + p.slice(1)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Time Window */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Time Window (Optional)</Text>
            <View style={styles.timeInputs}>
              <View style={styles.timeInputWrapper}>
                <Text style={styles.timeLabel}>From</Text>
                <TextInput
                  style={styles.timeInput}
                  placeholder="09:00"
                  placeholderTextColor="#64748b"
                  value={timeStart}
                  onChangeText={setTimeStart}
                  keyboardType="numbers-and-punctuation"
                />
              </View>
              <View style={styles.timeDivider}>
                <Ionicons name="arrow-forward" size={20} color="#64748b" />
              </View>
              <View style={styles.timeInputWrapper}>
                <Text style={styles.timeLabel}>To</Text>
                <TextInput
                  style={styles.timeInput}
                  placeholder="17:00"
                  placeholderTextColor="#64748b"
                  value={timeEnd}
                  onChangeText={setTimeEnd}
                  keyboardType="numbers-and-punctuation"
                />
              </View>
            </View>
          </View>

          {/* Notes */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Notes (Optional)</Text>
            <TextInput
              style={[styles.input, styles.notesInput]}
              placeholder="Add any delivery notes..."
              placeholderTextColor="#64748b"
              value={notes}
              onChangeText={setNotes}
              multiline
              numberOfLines={3}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  keyboardView: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  headerTitle: {
    color: '#f8fafc',
    fontSize: 18,
    fontWeight: '600',
  },
  saveButton: {
    color: '#3b82f6',
    fontSize: 16,
    fontWeight: '600',
  },
  content: {
    flex: 1,
    padding: 16,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    color: '#94a3b8',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 12,
  },
  addressCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 16,
  },
  addressText: {
    flex: 1,
    color: '#e2e8f0',
    fontSize: 14,
  },
  input: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: '#f8fafc',
    fontSize: 16,
  },
  notesInput: {
    height: 100,
    textAlignVertical: 'top',
  },
  priorityButtons: {
    flexDirection: 'row',
  },
  priorityButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1e293b',
    paddingVertical: 14,
    borderRadius: 12,
  },
  priorityButtonActive: {
    backgroundColor: '#3b82f6',
  },
  priorityHigh: {
    backgroundColor: '#ef4444',
  },
  priorityLow: {
    backgroundColor: '#6b7280',
  },
  priorityButtonText: {
    color: '#94a3b8',
    fontSize: 14,
    fontWeight: '600',
  },
  priorityButtonTextActive: {
    color: '#fff',
  },
  timeInputs: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  timeInputWrapper: {
    flex: 1,
  },
  timeLabel: {
    color: '#64748b',
    fontSize: 12,
    marginBottom: 6,
  },
  timeInput: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: '#f8fafc',
    fontSize: 16,
    textAlign: 'center',
  },
  timeDivider: {
    paddingTop: 20,
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorText: {
    color: '#ef4444',
    fontSize: 16,
    marginBottom: 16,
  },
  backLink: {
    color: '#3b82f6',
    fontSize: 16,
  },
});
