import React, { useState, useEffect, useCallback } from 'react';
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
  Dimensions,
  Keyboard,
  Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useStopsStore } from '../src/store/stopsStore';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || '';

interface GeocodingResult {
  id: string;
  place_name: string;
  formatted_address?: string;
  latitude: number;
  longitude: number;
  rooftop_centroid?: { latitude: number; longitude: number };
  map_pinpoint?: { latitude: number; longitude: number; source?: string };
  place_id?: string;
  location_type?: string;
  place_type?: string[];
  business_name?: string;
  is_business?: boolean;
  brand?: string;
  poi_category?: string;
  category?: string;
  categories?: string[];
  osm_tags?: Record<string, any>;
  admin_areas?: Record<string, any>;
  geometry?: any;
  bbox?: any;
  context_raw?: any[];
}

export default function AddStopScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { addStop } = useStopsStore();
  
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<GeocodingResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedLocation, setSelectedLocation] = useState<GeocodingResult | null>(null);
  
  const [name, setName] = useState('');
  const [suburb, setSuburb] = useState('');
  const [timeStart, setTimeStart] = useState('');
  const [timeEnd, setTimeEnd] = useState('');
  const [notes, setNotes] = useState('');
  const [weight, setWeight] = useState('');
  const [quantity, setQuantity] = useState('');
  const [saving, setSaving] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
    const hideSub = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  useEffect(() => {
    const searchTimeout = setTimeout(() => {
      if (searchQuery.length >= 3 && !selectedLocation) {
        searchAddress();
      } else if (searchQuery.length < 3) {
        setSearchResults([]);
      }
    }, 300);

    return () => clearTimeout(searchTimeout);
  }, [searchQuery]);

  const searchAddress = async () => {
    setSearching(true);
    try {
      const response = await fetch(
        `${BACKEND_URL}/api/geocode?query=${encodeURIComponent(searchQuery)}`
      );
      const data = await response.json();
      setSearchResults(data);
    } catch (error) {
      console.error('Search error:', error);
    } finally {
      setSearching(false);
    }
  };

  const selectLocation = useCallback((result: GeocodingResult) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedLocation(result);
    setSearchQuery(result.formatted_address || result.place_name);
    setSearchResults([]);
    if (!name) {
      const shortName = (result.formatted_address || result.place_name).split(',')[0];
      setName(shortName);
    }
    Keyboard.dismiss();
  }, [name]);

  const clearLocation = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedLocation(null);
    setSearchQuery('');
  };

  const handlePriorityChange = (p: 'high' | 'medium' | 'low') => {
    // Priority removed
  };

  const handleSave = async () => {
    if (!selectedLocation) return;

    const mapPin = selectedLocation.map_pinpoint || selectedLocation.rooftop_centroid;
    const pinLat = mapPin?.latitude ?? selectedLocation.latitude;
    const pinLng = mapPin?.longitude ?? selectedLocation.longitude;
    
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setSaving(true);
    try {
      await addStop({
        address: selectedLocation.formatted_address || selectedLocation.place_name,
        name: name || undefined,
        suburb: suburb || undefined,
        latitude: pinLat,
        longitude: pinLng,
        geocode_metadata: selectedLocation,
        time_window: (timeStart || timeEnd) ? {
          start: timeStart || undefined,
          end: timeEnd || undefined,
        } : undefined,
        notes: notes || undefined,
        weight: weight ? parseFloat(weight) : undefined,
        quantity: quantity ? parseInt(quantity) : undefined,
      });
      router.back();
    } catch (error) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      console.error('Save error:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.back();
  };

  return (
    <View style={styles.container}>
      {/* Drag Handle for bottom sheet feel */}
      <View style={[styles.dragHandleContainer, { paddingTop: insets.top }]}>
        <View style={styles.dragHandle} />
      </View>

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity 
          style={styles.headerButton} 
          onPress={handleClose}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="close" size={24} color="#94a3b8" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Add Stop</Text>
        <TouchableOpacity
          style={[styles.saveButton, !selectedLocation && styles.saveButtonDisabled]}
          onPress={handleSave}
          disabled={!selectedLocation || saving}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          {saving ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={[styles.saveButtonText, !selectedLocation && styles.saveButtonTextDisabled]}>
              Save
            </Text>
          )}
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
        keyboardVerticalOffset={10}
      >
        <ScrollView 
          style={styles.content} 
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: keyboardVisible ? 100 : 40 }}
        >
          {/* Address Search */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              <Ionicons name="location" size={14} color="#3b82f6" /> DELIVERY ADDRESS
            </Text>
            <View style={styles.searchContainer}>
              <Ionicons name="search" size={20} color="#64748b" style={styles.searchIcon} />
              <TextInput
                style={styles.searchInput}
                placeholder="Search for an address..."
                placeholderTextColor="#64748b"
                value={searchQuery}
                onChangeText={(text) => {
                  setSearchQuery(text);
                  if (selectedLocation) setSelectedLocation(null);
                }}
                autoFocus
                returnKeyType="search"
              />
              {searching && <ActivityIndicator size="small" color="#3b82f6" />}
              {selectedLocation && (
                <TouchableOpacity onPress={clearLocation} style={styles.clearButton}>
                  <Ionicons name="close-circle" size={20} color="#64748b" />
                </TouchableOpacity>
              )}
            </View>

            {/* Search Results */}
            {searchResults.length > 0 && !selectedLocation && (
              <View style={styles.searchResults}>
                {searchResults.map((result, index) => (
                  <TouchableOpacity
                    key={result.id}
                    style={[
                      styles.searchResultItem,
                      index === searchResults.length - 1 && styles.searchResultItemLast
                    ]}
                    onPress={() => selectLocation(result)}
                    activeOpacity={0.7}
                  >
                    <View style={styles.resultIconContainer}>
                      <Ionicons name="location" size={18} color="#3b82f6" />
                    </View>
                    <View style={styles.searchResultTextWrap}>
                      {!!result.business_name && result.business_name !== (result.formatted_address || result.place_name) && (
                        <Text
                          style={styles.searchResultBusinessName}
                          numberOfLines={1}
                          testID={`add-stop-search-result-business-name-${result.id}`}
                        >
                          {result.business_name}
                        </Text>
                      )}
                      <Text
                        style={styles.searchResultText}
                        numberOfLines={2}
                        testID={`add-stop-search-result-address-${result.id}`}
                      >
                        {result.formatted_address || result.place_name}
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color="#475569" />
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {/* Selected Location */}
            {selectedLocation && (
              <View style={styles.selectedLocation}>
                <View style={styles.selectedIconContainer}>
                  <Ionicons name="checkmark-circle" size={20} color="#10b981" />
                </View>
                <Text style={styles.selectedLocationText} numberOfLines={2}>
                  {selectedLocation.formatted_address || selectedLocation.place_name}
                </Text>
              </View>
            )}
          </View>

          {/* Stop Name */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              <Ionicons name="pricetag" size={14} color="#8b5cf6" /> NAME (OPTIONAL)
            </Text>
            <TextInput
              style={styles.input}
              placeholder="e.g., John's House, Office Building"
              placeholderTextColor="#64748b"
              value={name}
              onChangeText={setName}
              returnKeyType="next"
            />
          </View>

          {/* Suburb */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              <Ionicons name="business" size={14} color="#f59e0b" /> SUBURB (OPTIONAL)
            </Text>
            <TextInput
              style={styles.input}
              placeholder="Auto-detected or enter manually"
              placeholderTextColor="#64748b"
              value={suburb}
              onChangeText={setSuburb}
              returnKeyType="next"
            />
            <Text style={styles.helperText}>
              Leave empty to auto-detect from address
            </Text>
          </View>

          {/* Time Window */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              <Ionicons name="time" size={14} color="#10b981" /> TIME WINDOW (OPTIONAL)
            </Text>
            <View style={styles.timeRow}>
              <View style={styles.timeInputContainer}>
                <Text style={styles.timeLabel}>From</Text>
                <TextInput
                  style={styles.timeInput}
                  placeholder="09:00"
                  placeholderTextColor="#64748b"
                  value={timeStart}
                  onChangeText={setTimeStart}
                  keyboardType="numbers-and-punctuation"
                  maxLength={5}
                />
              </View>
              <View style={styles.timeArrow}>
                <Ionicons name="arrow-forward" size={18} color="#475569" />
              </View>
              <View style={styles.timeInputContainer}>
                <Text style={styles.timeLabel}>To</Text>
                <TextInput
                  style={styles.timeInput}
                  placeholder="17:00"
                  placeholderTextColor="#64748b"
                  value={timeEnd}
                  onChangeText={setTimeEnd}
                  keyboardType="numbers-and-punctuation"
                  maxLength={5}
                />
              </View>
            </View>
          </View>

          {/* Weight & Quantity */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              <Ionicons name="cube" size={14} color="#ec4899" /> PACKAGE INFO (OPTIONAL)
            </Text>
            <View style={styles.packageRow}>
              <View style={styles.packageInputContainer}>
                <Ionicons name="scale-outline" size={18} color="#64748b" style={styles.packageIcon} />
                <TextInput
                  style={styles.packageInput}
                  placeholder="Weight (kg)"
                  placeholderTextColor="#64748b"
                  value={weight}
                  onChangeText={setWeight}
                  keyboardType="decimal-pad"
                />
              </View>
              <View style={styles.packageInputContainer}>
                <Ionicons name="layers-outline" size={18} color="#64748b" style={styles.packageIcon} />
                <TextInput
                  style={styles.packageInput}
                  placeholder="Quantity"
                  placeholderTextColor="#64748b"
                  value={quantity}
                  onChangeText={setQuantity}
                  keyboardType="number-pad"
                />
              </View>
            </View>
          </View>

          {/* Notes */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              <Ionicons name="document-text" size={14} color="#64748b" /> NOTES (OPTIONAL)
            </Text>
            <TextInput
              style={styles.notesInput}
              placeholder="Add delivery instructions, gate codes, etc..."
              placeholderTextColor="#64748b"
              value={notes}
              onChangeText={setNotes}
              multiline
              numberOfLines={4}
              textAlignVertical="top"
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Bottom Save Button (fixed) */}
      {!keyboardVisible && (
        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 16 }]}>
          <TouchableOpacity
            style={[styles.bottomSaveButton, !selectedLocation && styles.bottomSaveButtonDisabled]}
            onPress={handleSave}
            disabled={!selectedLocation || saving}
            activeOpacity={0.8}
          >
            {saving ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Ionicons name="add-circle" size={22} color="#fff" />
                <Text style={styles.bottomSaveButtonText}>Add Stop</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  dragHandleContainer: {
    alignItems: 'center',
    paddingBottom: 8,
  },
  dragHandle: {
    width: 40,
    height: 4,
    backgroundColor: '#cbd5e1',
    borderRadius: 2,
    marginTop: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  headerButton: {
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 22,
    backgroundColor: '#f1f5f9',
  },
  headerTitle: {
    color: '#0f172a',
    fontSize: 18,
    fontWeight: '700',
  },
  saveButton: {
    backgroundColor: '#3b82f6',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
  },
  saveButtonDisabled: {
    backgroundColor: '#e2e8f0',
  },
  saveButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  saveButtonTextDisabled: {
    color: '#94a3b8',
  },
  keyboardView: {
    flex: 1,
  },
  content: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 20,
  },
  section: {
    marginBottom: 28,
  },
  sectionTitle: {
    color: '#64748b',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 12,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderRadius: 16,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  searchIcon: {
    marginRight: 12,
  },
  searchInput: {
    flex: 1,
    color: '#0f172a',
    fontSize: 16,
    paddingVertical: 16,
  },
  clearButton: {
    padding: 8,
    marginLeft: 8,
  },
  searchResults: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    marginTop: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  searchResultItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    minHeight: 60,
  },
  searchResultItemLast: {
    borderBottomWidth: 0,
  },
  resultIconContainer: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  searchResultText: {
    color: '#334155',
    fontSize: 14,
    lineHeight: 20,
  },
  searchResultTextWrap: {
    flex: 1,
  },
  searchResultBusinessName: {
    color: '#0f172a',
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 2,
  },
  selectedLocation: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
    borderRadius: 16,
    padding: 16,
    marginTop: 12,
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.3)',
  },
  selectedIconContainer: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(16, 185, 129, 0.2)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  selectedLocationText: {
    flex: 1,
    color: '#10b981',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '500',
  },
  input: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 16,
    color: '#0f172a',
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  helperText: {
    color: '#64748b',
    fontSize: 12,
    marginTop: 8,
    marginLeft: 4,
  },
  priorityContainer: {
    flexDirection: 'row',
  },
  priorityOption: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ffffff',
    paddingVertical: 16,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: '#e2e8f0',
    minHeight: 56,
  },
  priorityOptionSelected: {
    borderColor: 'transparent',
  },
  priorityHigh: {
    backgroundColor: '#ef4444',
  },
  priorityMedium: {
    backgroundColor: '#3b82f6',
  },
  priorityLow: {
    backgroundColor: '#6b7280',
  },
  priorityText: {
    color: '#64748b',
    fontSize: 14,
    fontWeight: '600',
  },
  priorityTextSelected: {
    color: '#fff',
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  timeInputContainer: {
    flex: 1,
  },
  timeLabel: {
    color: '#64748b',
    fontSize: 12,
    fontWeight: '500',
    marginBottom: 8,
    marginLeft: 4,
  },
  timeInput: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 16,
    color: '#0f172a',
    fontSize: 16,
    textAlign: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  timeArrow: {
    paddingTop: 24,
  },
  packageRow: {
    flexDirection: 'row',
  },
  packageInputContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderRadius: 16,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  packageIcon: {
    marginRight: 12,
  },
  packageInput: {
    flex: 1,
    color: '#0f172a',
    fontSize: 16,
    paddingVertical: 16,
  },
  notesInput: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 16,
    color: '#0f172a',
    fontSize: 16,
    minHeight: 120,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  bottomBar: {
    paddingHorizontal: 16,
    paddingTop: 16,
    backgroundColor: '#f8fafc',
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  bottomSaveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#10b981',
    paddingVertical: 18,
    borderRadius: 16,
  },
  bottomSaveButtonDisabled: {
    backgroundColor: '#e2e8f0',
  },
  bottomSaveButtonText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
  },
});
