import { Stop } from '../store/stopsStore';
import { stopPinNumber } from './stopPinNumber';

export interface StopGroup {
  key: string;
  stops: Stop[];
  address: string;
  allCompleted: boolean;
  completedCount: number;
}

/**
 * Groups stops by identical coordinates (rounded to ~1m precision).
 * Single-stop groups are kept as-is.
 * Multi-stop groups are consolidated into one entry with a count badge.
 */
export function groupStopsByLocation(stops: Stop[]): StopGroup[] {
  const map = new Map<string, Stop[]>();
  const order: string[] = [];

  for (const stop of stops) {
    // Round to 5 decimal places (~1.1m precision) to catch same-building stops
    const key = `${stop.latitude.toFixed(5)},${stop.longitude.toFixed(5)}`;
    if (!map.has(key)) {
      map.set(key, []);
      order.push(key);
    }
    map.get(key)!.push(stop);
  }

  return order.map((key) => {
    const group = map.get(key)!;
    // Use the first stop's address as the shared address
    const address = group[0].address;
    const completedCount = group.filter((s) => s.completed).length;
    return {
      key,
      stops: group,
      address,
      allCompleted: completedCount === group.length,
      completedCount,
    };
  });
}

/**
 * Extracts a short label for a stop within a group.
 * Prefers `name`, falls back to unit/apartment from address diff, or stop order.
 */
export function getStopLabel(stop: Stop, groupAddress: string): string {
  if (stop.name && stop.name.trim()) return stop.name.trim();

  // Try to extract a differentiator from the address vs the group address
  const addr = stop.address.trim();
  const base = groupAddress.trim();
  if (addr !== base) {
    // Check for unit prefix patterns like "Unit 3/", "3/", "Apt 5,"
    const unitMatch = addr.match(/^(unit\s*\d+\w?|apt\.?\s*\d+\w?|\d+[a-z]?\s*[\/,])/i);
    if (unitMatch) return unitMatch[0].replace(/[\/,]\s*$/, '').trim();
    // If address is longer/different, show the first distinct part
    if (addr.length > base.length) {
      const diff = addr.replace(base, '').trim().replace(/^[\/,\-]\s*/, '');
      if (diff) return diff.substring(0, 20);
    }
  }

  // Final fallback — Sharpie-marker badge if the route has been confirmed,
  // otherwise the dynamic order+1. Defers to stopPinNumber for a single
  // source of truth on what number gets painted on the box.
  const pin = stopPinNumber(stop);
  return pin != null ? `Stop #${pin}` : `Stop #${(stop.order ?? 0) + 1}`;
}
