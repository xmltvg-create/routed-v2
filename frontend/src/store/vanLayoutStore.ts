import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL || '';

/**
 * Per-driver van bin grid configuration. Drivers pick a shape once
 * (2×3 / 3×3 / 3×4) and we persist it on their account so every
 * subsequent route can render bin labels (A1, B2…) without re-asking.
 *
 * Bin coordinates are spreadsheet-style: row letters A, B, C top→bottom
 * and column digits 1, 2, 3, 4 left→right. So (rows=3, cols=4) gives
 * a 12-bin grid where the bottom-right bin is "C4".
 */
export interface VanLayout {
  rows: number;
  cols: number;
  /** True when the backend returned the default fallback (no saved config yet). */
  is_default: boolean;
}

/** Allowed grid shapes — must match the backend's `ALLOWED_VAN_SHAPES`. */
export const VAN_LAYOUT_OPTIONS: Array<{ rows: number; cols: number; label: string }> = [
  { rows: 2, cols: 3, label: '2×3' },
  { rows: 3, cols: 3, label: '3×3' },
  { rows: 3, cols: 4, label: '3×4' },
];

interface VanLayoutStore {
  layout: VanLayout | null;
  loading: boolean;
  saving: boolean;
  fetchLayout: () => Promise<void>;
  saveLayout: (rows: number, cols: number) => Promise<boolean>;
}

const authFetch = async (url: string, options: RequestInit = {}): Promise<Response> => {
  const token = await AsyncStorage.getItem('session_token');
  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
    credentials: 'include',
  });
};

export const useVanLayoutStore = create<VanLayoutStore>((set) => ({
  layout: null,
  loading: false,
  saving: false,

  fetchLayout: async () => {
    set({ loading: true });
    try {
      const response = await authFetch(`${BACKEND_URL}/api/van-layout`);
      if (response.ok) {
        const data: VanLayout = await response.json();
        set({ layout: data });
      }
    } catch (error) {
      console.error('Fetch van layout error:', error);
    } finally {
      set({ loading: false });
    }
  },

  saveLayout: async (rows: number, cols: number) => {
    set({ saving: true });
    try {
      const response = await authFetch(`${BACKEND_URL}/api/van-layout`, {
        method: 'PUT',
        body: JSON.stringify({ rows, cols }),
      });
      if (!response.ok) return false;
      const data: VanLayout = await response.json();
      set({ layout: data });
      return true;
    } catch (error) {
      console.error('Save van layout error:', error);
      return false;
    } finally {
      set({ saving: false });
    }
  },
}));

/** Convert (row index, col index) → spreadsheet bin label, e.g. (0,0) → "A1". */
export const binLabel = (rowIdx: number, colIdx: number): string =>
  `${String.fromCharCode(65 + rowIdx)}${colIdx + 1}`;

/**
 * Assigns a delivery-ordered stop (0 = first to deliver, N-1 = last) to a
 * grid bin so the driver can load the van for fastest in-route retrieval.
 *
 * Loading rule (from the user spec):
 *   "Reverse-order zone: last-stop-first → bottom-row first"
 *
 * Concretely, we want:
 *   - First stop to deliver  → row A (top, closest to door, last to load)
 *   - Last  stop to deliver  → row C/D (bottom, deepest in van, first to load)
 *
 * We map the stop's index in the optimised sequence onto the flat bin
 * index 0…(rows·cols − 1) using a proportional split: bin = floor(i ·
 * rows·cols / N). The grid is walked row-by-row, top→bottom, left→right.
 * Multiple stops can share a bin when N exceeds rows·cols (the bin acts
 * as a small stack); the order within the stack still follows delivery
 * order so the driver picks the closest stop first.
 *
 * Pure / synchronous / no I/O — easy to unit-test.
 */
export const assignBin = (
  stopIdx: number,
  totalStops: number,
  rows: number,
  cols: number,
): { row: number; col: number; label: string } => {
  if (totalStops <= 0 || rows <= 0 || cols <= 0) {
    return { row: 0, col: 0, label: 'A1' };
  }
  const totalBins = rows * cols;
  const clamped = Math.max(0, Math.min(stopIdx, totalStops - 1));
  // Map the stop's slot in the route onto the flat bin index. Multiplying
  // before dividing keeps integer arithmetic exact and avoids the off-by-one
  // you'd hit with `floor(i / (N/B))`.
  const bin = Math.min(totalBins - 1, Math.floor((clamped * totalBins) / totalStops));
  const row = Math.floor(bin / cols);
  const col = bin % cols;
  return { row, col, label: binLabel(row, col) };
};
