import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useStopsStore } from '../src/store/stopsStore';
import { useAuth } from '../src/context/AuthContext';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || '';

interface PreviewData {
  columns: string[];
  sample_rows: Record<string, any>[];
  total_rows: number;
  suggested_mapping?: Record<string, string>;
}

interface FieldMapping {
  address: string;
  mobile_number?: string;
  notes?: string;
  weight?: string;
  quantity?: string;
  // Carrier tracking column ("Source Reference" for the user's CSV).
  // Populates Stop.tracking_number — used by the Van Loading Assistant
  // camera scanner for O(1) barcode → stop matching.
  tracking_number?: string;
}

const FIELD_OPTIONS = [
  { key: 'address', label: 'Address', required: true },
  { key: 'mobile_number', label: 'Customer Number / Phone', required: false },
  { key: 'notes', label: 'Notes', required: false },
  { key: 'weight', label: 'Weight', required: false },
  { key: 'quantity', label: 'Quantity', required: false },
  { key: 'tracking_number', label: 'Tracking / Source Reference', required: false },
];

export default function ImportScreen() {
  const router = useRouter();
  const { fetchStops, stops } = useStopsStore();
  const { reconnect } = useAuth();
  
  const [step, setStep] = useState<'upload' | 'mapping' | 'processing' | 'done'>('upload');
  const [selectedFile, setSelectedFile] = useState<DocumentPicker.DocumentPickerAsset | null>(null);
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [mapping, setMapping] = useState<FieldMapping>({ address: '' });
  const [loading, setLoading] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [replaceExisting, setReplaceExisting] = useState(true);
  const [importResult, setImportResult] = useState<{
    success_count: number;
    failed_count: number;
    failed_addresses: string[];
    auto_archived_count?: number;
  } | null>(null);

  const getAuthHeaders = async (): Promise<Record<string, string>> => {
    const token = await AsyncStorage.getItem('session_token');
    return token ? { 'Authorization': `Bearer ${token}` } : {};
  };

  // Safely parse a response body that may be JSON, HTML, or plain text
  // (e.g. ingress returns "413 Payload Too Large" as text, not JSON).
  const safeParseJSON = async (response: Response): Promise<any | null> => {
    try {
      const text = await response.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return { __raw: text };
      }
    } catch {
      return null;
    }
  };

  const extractErrorMessage = async (
    response: Response,
    fallback: string,
  ): Promise<string> => {
    const status = response.status;
    if (status === 413) {
      return 'File is too large. Please split it into smaller files (try < 5 MB).';
    }
    const parsed = await safeParseJSON(response);
    if (parsed) {
      if (typeof parsed === 'string') return parsed;
      if (parsed.detail) {
        return typeof parsed.detail === 'string'
          ? parsed.detail
          : JSON.stringify(parsed.detail);
      }
      if (parsed.message) return String(parsed.message);
      if (parsed.__raw) {
        const trimmed = String(parsed.__raw).trim().slice(0, 200);
        if (trimmed) return `${fallback} (${status}): ${trimmed}`;
      }
    }
    return `${fallback} (${status})`;
  };

  const pickFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [
          'application/vnd.ms-excel',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'text/csv',
        ],
        copyToCacheDirectory: true,
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        const file = result.assets[0];
        setSelectedFile(file);
        await uploadPreview(file);
      }
    } catch (error) {
      console.error('File pick error:', error);
      Alert.alert('Error', 'Failed to select file');
    }
  };

  const uploadPreview = async (file: DocumentPicker.DocumentPickerAsset) => {
    setLoading(true);
    try {
      const headers = await getAuthHeaders();
      const formData = new FormData();
      
      // Handle file for different platforms
      if (Platform.OS === 'web') {
        const response = await fetch(file.uri);
        const blob = await response.blob();
        formData.append('file', blob, file.name);
      } else {
        formData.append('file', {
          uri: file.uri,
          name: file.name,
          type: file.mimeType || 'application/octet-stream',
        } as any);
      }

      // Timeout-armoured fetch — preview should be fast (<5s for parse).
      // Without a timeout, a hung connection leaves the user staring at
      // a spinner forever ("xls import isn't loading").
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      let response: Response;
      try {
        response = await fetch(`${BACKEND_URL}/api/import/preview`, {
          method: 'POST',
          headers: {
            ...headers,
          },
          body: formData,
          signal: controller.signal,
        });
      } catch (fetchErr: any) {
        if (fetchErr?.name === 'AbortError') {
          throw new Error('Upload timed out after 30s. Check your connection and try again.');
        }
        throw new Error(`Network error: ${fetchErr?.message || 'Could not reach server'}. Check your internet connection.`);
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        throw new Error(await extractErrorMessage(response, 'Upload failed'));
      }

      const data = await safeParseJSON(response);
      if (!data || data.__raw) {
        throw new Error('Server returned an invalid response. Please try again.');
      }
      setPreviewData(data);
      
      // Use backend-provided suggested_mapping (bypasses mobile JS cache issues)
      const newMapping: FieldMapping = { address: '' };
      if (data.suggested_mapping) {
        if (data.suggested_mapping.address) newMapping.address = data.suggested_mapping.address;
        if (data.suggested_mapping.mobile_number) newMapping.mobile_number = data.suggested_mapping.mobile_number;
        if (data.suggested_mapping.notes) newMapping.notes = data.suggested_mapping.notes;
        if (data.suggested_mapping.weight) newMapping.weight = data.suggested_mapping.weight;
        if (data.suggested_mapping.quantity) newMapping.quantity = data.suggested_mapping.quantity;
        if (data.suggested_mapping.tracking_number) newMapping.tracking_number = data.suggested_mapping.tracking_number;
      }
      setMapping(newMapping);
      
      setStep('mapping');
    } catch (error: any) {
      console.error('Upload error:', error);
      Alert.alert('Import Error', error.message || 'Failed to upload file. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const processImport = async () => {
    if (!mapping.address) {
      Alert.alert('Error', 'Please select an address column');
      return;
    }

    if (!selectedFile) {
      Alert.alert('Error', 'No file selected');
      return;
    }

    setStep('processing');
    setLoading(true);

    try {
      const headers = await getAuthHeaders();
      const formData = new FormData();
      
      // Handle file for different platforms
      if (Platform.OS === 'web') {
        const response = await fetch(selectedFile.uri);
        const blob = await response.blob();
        formData.append('file', blob, selectedFile.name);
      } else {
        formData.append('file', {
          uri: selectedFile.uri,
          name: selectedFile.name,
          type: selectedFile.mimeType || 'application/octet-stream',
        } as any);
      }
      
      // Clean mapping - remove empty values
      const cleanMapping: Record<string, string> = {};
      Object.entries(mapping).forEach(([key, value]) => {
        if (value) cleanMapping[key] = value;
      });
      
      formData.append('mapping', JSON.stringify(cleanMapping));
      formData.append('clear_existing', replaceExisting ? 'true' : 'false');

      // 3-minute timeout — geocoding 190 stops can take 60-120s on production.
      // Without this, a hung connection shows a spinner forever.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 180000);

      let response: Response;
      try {
        response = await fetch(`${BACKEND_URL}/api/import/process`, {
          method: 'POST',
          headers: {
            ...headers,
          },
          body: formData,
          signal: controller.signal,
        });
      } catch (fetchErr: any) {
        if (fetchErr?.name === 'AbortError') {
          throw new Error('Import timed out (3 min). Your stops may have been partially imported — check the map.');
        }
        throw new Error(`Network error: ${fetchErr?.message || 'Could not reach server'}. Check your internet connection.`);
      } finally {
        clearTimeout(timeoutId);
      }

      // Handle async job pattern (202) for large files
      if (response.status === 202) {
        const jobData = await safeParseJSON(response);
        if (!jobData?.job_id) throw new Error('Server started import but returned no job ID');
        
        setImportStatus?.(`Geocoding ${jobData.total_rows} addresses...`);
        
        // Poll until done or error (5 min max)
        const pollStart = Date.now();
        const POLL_TIMEOUT = 300000; // 5 minutes
        while (Date.now() - pollStart < POLL_TIMEOUT) {
          await new Promise(r => setTimeout(r, 3000)); // poll every 3s
          const pollResp = await fetch(`${BACKEND_URL}/api/import/jobs/${jobData.job_id}`, {
            headers: { ...headers },
          });
          if (!pollResp.ok) continue;
          const poll = await safeParseJSON(pollResp);
          if (poll?.status === 'done') {
            setImportResult(poll.result);
            setStep('result');
            return;
          }
          if (poll?.status === 'error') {
            throw new Error(poll.error || 'Import failed on server');
          }
        }
        throw new Error('Import timed out after 5 minutes. Check the map — stops may have been partially imported.');
      }

      if (!response.ok) {
        throw new Error(await extractErrorMessage(response, 'Import failed'));
      }

      const result = await safeParseJSON(response);
      if (!result || result.__raw) {
        throw new Error('Server returned an invalid response. Please try again.');
      }
      setImportResult(result);

      // Refresh the global stops store BEFORE flipping to the Done screen.
      // Earlier order was: setStep('done') → await fetchStops(). On flaky
      // carriers users routinely tapped "View Stops" inside the ~1–3 s
      // window before the fetch resolved, dismissed the modal, landed on
      // the underlying tab while the store was still empty (or worse, the
      // fetch failed silently after navigation and never refreshed). Doing
      // the fetch first guarantees the store reflects the new stops before
      // the user can navigate away. We re-try once on transient failures
      // (most "empty list" reports correlated with one-off 5xx/timeout).
      try {
        await fetchStops();
      } catch (e) {
        console.warn('[import] first fetchStops failed, retrying once:', e);
        try { await fetchStops(); } catch (e2) {
          console.warn('[import] second fetchStops also failed:', e2);
        }
      }
      // Auth-specific path: import POST itself succeeded (so the token is
      // alive on the path that goes through ingress), but GET /api/stops
      // came back 401 — the token is expired for read scope, or the
      // user_id Mongo wrote vs the user_id auth resolves no longer match.
      // Surface this loudly: the alternative is a "successful" Done screen
      // followed by a phantom-empty list, which is exactly the bug being
      // fixed here.
      const fetchErr = useStopsStore.getState().lastFetchError;
      if (fetchErr && fetchErr.status === 401) {
        // Best-effort silent recovery: kick off the OAuth re-auth flow
        // immediately. WebBrowser opens a single tab; in 90% of cases
        // the device's existing Google cookie redirects right back
        // with a fresh session_id and login() exchanges it. If it
        // works, refresh stops one more time so the Done screen can
        // show the imported list once the user navigates back.
        const ok = await reconnect();
        if (ok) {
          try { await fetchStops(); } catch { /* swallow */ }
        } else {
          Alert.alert(
            'Imported, but please sign in again',
            'Your stops were saved on the server, but your session expired. Tap "Reconnect" on the stops screen to refresh, or sign out and back in via Profile.',
          );
        }
      }
      setStep('done');
    } catch (error: any) {
      console.error('Import error:', error);
      Alert.alert('Error', error.message || 'Failed to import stops');
      setStep('mapping');
    } finally {
      setLoading(false);
    }
  };

  const updateMapping = (field: string, column: string) => {
    setMapping(prev => ({
      ...prev,
      [field]: column || undefined,
    }));
  };

  const renderUploadStep = () => (
    <View style={styles.stepContent}>
      <View style={styles.iconContainer}>
        <Ionicons name="document" size={64} color="#3b82f6" />
      </View>
      <Text style={styles.stepTitle}>Import Stops from File</Text>
      <Text style={styles.stepDescription}>
        Upload an Excel (.xls, .xlsx) or CSV file containing your delivery addresses.
        The file will be geocoded to get coordinates.
      </Text>
      
      <TouchableOpacity style={styles.uploadButton} onPress={pickFile}>
        <Ionicons name="cloud-upload" size={24} color="#fff" />
        <Text style={styles.uploadButtonText}>Select File</Text>
      </TouchableOpacity>

      <View style={styles.formatInfo}>
        <Text style={styles.formatTitle}>Supported Formats</Text>
        <View style={styles.formatList}>
          <View style={styles.formatItem}>
            <Ionicons name="checkmark-circle" size={16} color="#10b981" />
            <Text style={styles.formatText}>.xlsx (Excel)</Text>
          </View>
          <View style={styles.formatItem}>
            <Ionicons name="checkmark-circle" size={16} color="#10b981" />
            <Text style={styles.formatText}>.xls (Excel 97-2003)</Text>
          </View>
          <View style={styles.formatItem}>
            <Ionicons name="checkmark-circle" size={16} color="#10b981" />
            <Text style={styles.formatText}>.csv (Comma Separated)</Text>
          </View>
        </View>
      </View>
    </View>
  );

  const renderMappingStep = () => (
    <ScrollView style={styles.stepContent}>
      {selectedFile && (
        <View style={styles.fileInfo}>
          <Ionicons name="document-text" size={24} color="#3b82f6" />
          <View style={styles.fileDetails}>
            <Text style={styles.fileName}>{selectedFile.name}</Text>
            <Text style={styles.fileRows}>{previewData?.total_rows} rows found</Text>
          </View>
        </View>
      )}

      <Text style={styles.sectionTitle}>Map Your Columns</Text>
      <Text style={styles.sectionDescription}>
        Match your file columns to the stop fields. Address is required.
      </Text>

      <TouchableOpacity
        style={styles.replaceToggle}
        onPress={() => setReplaceExisting(!replaceExisting)}
        data-testid="replace-existing-toggle"
      >
        <Ionicons
          name={replaceExisting ? 'checkbox' : 'square-outline'}
          size={24}
          color={replaceExisting ? '#3b82f6' : '#94a3b8'}
        />
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={styles.replaceToggleText}>Replace existing route</Text>
          <Text style={styles.replaceToggleHint}>
            {replaceExisting
              ? 'Current stops will be cleared before import'
              : 'New stops will be added to existing route'}
          </Text>
        </View>
      </TouchableOpacity>

      {FIELD_OPTIONS.map((field) => (
        <View key={field.key} style={styles.mappingRow}>
          <View style={styles.mappingLabel}>
            <Text style={styles.mappingLabelText}>{field.label}</Text>
            {field.required && <Text style={styles.requiredBadge}>Required</Text>}
          </View>
          <ScrollView 
            horizontal 
            showsHorizontalScrollIndicator={false}
            style={styles.columnSelector}
          >
            <TouchableOpacity
              style={[
                styles.columnChip,
                !mapping[field.key as keyof FieldMapping] && styles.columnChipSelected,
              ]}
              onPress={() => updateMapping(field.key, '')}
            >
              <Text style={styles.columnChipText}>None</Text>
            </TouchableOpacity>
            {previewData?.columns.map((col) => (
              <TouchableOpacity
                key={col}
                style={[
                  styles.columnChip,
                  mapping[field.key as keyof FieldMapping] === col && styles.columnChipSelected,
                ]}
                onPress={() => updateMapping(field.key, col)}
              >
                <Text style={[
                  styles.columnChipText,
                  mapping[field.key as keyof FieldMapping] === col && styles.columnChipTextSelected,
                ]}>
                  {col}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      ))}

      {previewData && previewData.sample_rows.length > 0 && (
        <View style={styles.previewSection}>
          <Text style={styles.sectionTitle}>Preview (First 5 Rows)</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={true}>
            <View>
              <View style={styles.previewHeader}>
                {previewData.columns.map((col) => (
                  <Text key={col} style={styles.previewHeaderCell}>{col}</Text>
                ))}
              </View>
              {previewData.sample_rows.map((row, idx) => (
                <View key={idx} style={styles.previewRow}>
                  {previewData.columns.map((col) => (
                    <Text key={col} style={styles.previewCell}>
                      {String(row[col] || '-').substring(0, 30)}
                    </Text>
                  ))}
                </View>
              ))}
            </View>
          </ScrollView>
        </View>
      )}

      <TouchableOpacity
        style={[styles.importButton, !mapping.address && styles.buttonDisabled]}
        onPress={processImport}
        disabled={!mapping.address}
      >
        <Ionicons name="cloud-download" size={24} color="#fff" />
        <Text style={styles.importButtonText}>Import Stops</Text>
      </TouchableOpacity>
    </ScrollView>
  );

  const renderProcessingStep = () => (
    <View style={styles.stepContent}>
      <ActivityIndicator size="large" color="#3b82f6" />
      <Text style={styles.processingText}>Importing and geocoding addresses...</Text>
      <Text style={styles.processingSubtext}>This may take a few moments</Text>
    </View>
  );

  const renderDoneStep = () => (
    <View style={styles.stepContent}>
      <View style={[styles.iconContainer, { backgroundColor: 'rgba(16, 185, 129, 0.1)' }]}>
        <Ionicons name="checkmark-circle" size={64} color="#10b981" />
      </View>
      <Text style={styles.stepTitle}>Import Complete!</Text>
      
      <View style={styles.resultStats}>
        <View style={styles.resultItem}>
          <Text style={styles.resultNumber}>{importResult?.success_count || 0}</Text>
          <Text style={styles.resultLabel}>Imported</Text>
        </View>
        <View style={styles.resultDivider} />
        <View style={styles.resultItem}>
          <Text style={[styles.resultNumber, { color: '#ef4444' }]}>
            {importResult?.failed_count || 0}
          </Text>
          <Text style={styles.resultLabel}>Failed</Text>
        </View>
      </View>

      {importResult?.failed_addresses && importResult.failed_addresses.length > 0 && (
        <View style={styles.failedList}>
          <Text style={styles.failedTitle}>Failed Addresses:</Text>
          {importResult.failed_addresses.slice(0, 5).map((addr, idx) => (
            <Text key={idx} style={styles.failedAddress}>{addr}</Text>
          ))}
          {importResult.failed_addresses.length > 5 && (
            <Text style={styles.failedMore}>
              +{importResult.failed_addresses.length - 5} more
            </Text>
          )}
        </View>
      )}

      {/* Auto-archive confirmation. Backend preserves any completed stops
          from the previous route into route_history BEFORE wiping for the
          new manifest (added 2026-05-05 after a destructive-import bug
          silently destroyed 490 deliveries). The badge surfaces this so
          drivers have visible proof their data wasn't lost. Hidden when
          there were no completed stops to archive (typical first-import
          of the day). */}
      {(importResult?.auto_archived_count ?? 0) > 0 && (
        <View style={styles.archiveBanner} data-testid="import-archive-banner">
          <Ionicons name="shield-checkmark" size={18} color="#10b981" />
          <Text style={styles.archiveBannerText}>
            Auto-archived {importResult!.auto_archived_count} completed stop
            {importResult!.auto_archived_count === 1 ? '' : 's'} to route history
          </Text>
        </View>
      )}

      <TouchableOpacity
        style={styles.doneButton}
        onPress={() => router.back()}
      >
        <Text style={styles.doneButtonText}>View Stops</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="close" size={28} color="#f8fafc" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Import Stops</Text>
        <View style={{ width: 28 }} />
      </View>

      {loading && step !== 'processing' && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#3b82f6" />
        </View>
      )}

      {step === 'upload' && renderUploadStep()}
      {step === 'mapping' && renderMappingStep()}
      {step === 'processing' && renderProcessingStep()}
      {step === 'done' && renderDoneStep()}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
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
  headerTitle: {
    color: '#0f172a',
    fontSize: 18,
    fontWeight: '600',
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(248, 250, 252, 0.9)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  stepContent: {
    flex: 1,
    padding: 20,
  },
  iconContainer: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'center',
    marginTop: 40,
    marginBottom: 24,
  },
  stepTitle: {
    color: '#0f172a',
    fontSize: 24,
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 12,
  },
  stepDescription: {
    color: '#64748b',
    fontSize: 16,
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 32,
  },
  uploadButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#3b82f6',
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderRadius: 12,
    alignSelf: 'center',
  },
  uploadButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  formatInfo: {
    marginTop: 40,
    padding: 20,
    backgroundColor: '#ffffff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  formatTitle: {
    color: '#0f172a',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 16,
  },
  formatList: {
  },
  formatItem: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  formatText: {
    color: '#64748b',
    fontSize: 14,
  },
  fileInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    padding: 16,
    borderRadius: 12,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  fileDetails: {
    flex: 1,
  },
  fileName: {
    color: '#0f172a',
    fontSize: 16,
    fontWeight: '500',
  },
  fileRows: {
    color: '#64748b',
    fontSize: 14,
    marginTop: 2,
  },
  sectionTitle: {
    color: '#0f172a',
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
  },
  sectionDescription: {
    color: '#64748b',
    fontSize: 14,
    marginBottom: 20,
  },
  replaceToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f0f9ff',
    padding: 16,
    borderRadius: 12,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#bae6fd',
  },
  replaceToggleText: {
    color: '#0f172a',
    fontSize: 15,
    fontWeight: '600',
  },
  replaceToggleHint: {
    color: '#64748b',
    fontSize: 12,
    marginTop: 2,
  },
  mappingRow: {
    marginBottom: 20,
  },
  mappingLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  mappingLabelText: {
    color: '#334155',
    fontSize: 14,
    fontWeight: '500',
  },
  requiredBadge: {
    color: '#ef4444',
    fontSize: 12,
    fontWeight: '600',
  },
  columnSelector: {
    flexDirection: 'row',
  },
  columnChip: {
    backgroundColor: '#f1f5f9',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    marginRight: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  columnChipSelected: {
    backgroundColor: '#3b82f6',
    borderColor: '#3b82f6',
  },
  columnChipText: {
    color: '#64748b',
    fontSize: 14,
  },
  columnChipTextSelected: {
    color: '#fff',
  },
  previewSection: {
    marginTop: 24,
    marginBottom: 24,
  },
  previewHeader: {
    flexDirection: 'row',
    backgroundColor: '#e2e8f0',
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
  },
  previewHeaderCell: {
    color: '#0f172a',
    fontSize: 12,
    fontWeight: '600',
    padding: 10,
    minWidth: 120,
    maxWidth: 150,
  },
  previewRow: {
    flexDirection: 'row',
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  previewCell: {
    color: '#64748b',
    fontSize: 12,
    padding: 10,
    minWidth: 120,
    maxWidth: 150,
  },
  importButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#3b82f6',
    paddingVertical: 16,
    borderRadius: 12,
    marginBottom: 40,
  },
  importButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  processingText: {
    color: '#0f172a',
    fontSize: 18,
    textAlign: 'center',
    marginTop: 24,
  },
  processingSubtext: {
    color: '#64748b',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 8,
  },
  resultStats: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 24,
    marginVertical: 24,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  resultItem: {
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  resultDivider: {
    width: 1,
    height: 40,
    backgroundColor: '#e2e8f0',
  },
  resultNumber: {
    color: '#10b981',
    fontSize: 36,
    fontWeight: 'bold',
  },
  resultLabel: {
    color: '#64748b',
    fontSize: 14,
    marginTop: 4,
  },
  failedList: {
    backgroundColor: '#fef2f2',
    borderRadius: 12,
    padding: 16,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  failedTitle: {
    color: '#ef4444',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 12,
  },
  failedAddress: {
    color: '#64748b',
    fontSize: 13,
    marginBottom: 6,
  },
  failedMore: {
    color: '#64748b',
    fontSize: 12,
    fontStyle: 'italic',
    marginTop: 8,
  },
  archiveBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
    borderColor: 'rgba(16, 185, 129, 0.3)',
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginTop: 16,
    marginHorizontal: 4,
  },
  archiveBannerText: {
    color: '#10b981',
    fontSize: 13,
    fontWeight: '600',
    marginLeft: 10,
    flex: 1,
  },
  doneButton: {
    backgroundColor: '#3b82f6',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  doneButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
