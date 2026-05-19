/**
 * Offline sync queue for stop-completion PATCHes.
 *
 * Problem: a driver taps "Delivered" with spotty/no signal. The optimistic UI flips the
 * pin green, but the PATCH fails → the store reverts and the completion silently
 * disappears. Bad for trust.
 *
 * Solution: queue failed actions in AsyncStorage, keep the optimistic state, and flush
 * the queue on every app foreground or subsequent successful network call. Each action
 * is idempotent on the backend (completing an already-completed stop is a no-op).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const QUEUE_KEY = 'sync_queue_v1';

export type QueueAction = {
  id: string;                       // stop id
  op: 'complete' | 'uncomplete';
  ts: number;                       // enqueue timestamp (ms)
};

async function readQueue(): Promise<QueueAction[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function writeQueue(q: QueueAction[]): Promise<void> {
  try {
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  } catch {
    // ignore — nothing we can do if device storage is full
  }
}

export async function enqueue(action: Omit<QueueAction, 'ts'>): Promise<void> {
  const q = await readQueue();
  // Collapse duplicates / opposite-of-last-pending so we don't re-send obsolete actions
  const filtered = q.filter((a) => a.id !== action.id);
  filtered.push({ ...action, ts: Date.now() });
  await writeQueue(filtered);
}

/** Remove a pending action before it gets flushed. Used when a driver realises they
 *  tapped the wrong stop while offline and wants to dismiss the queued PATCH. */
export async function removeById(id: string): Promise<void> {
  const q = await readQueue();
  const filtered = q.filter((a) => a.id !== id);
  if (filtered.length !== q.length) {
    await writeQueue(filtered);
  }
}

export async function getQueuedIds(): Promise<Set<string>> {
  const q = await readQueue();
  return new Set(q.map((a) => a.id));
}

/** Return the full queue (id + op + timestamp). Used for the "what's pending?" UI. */
export async function getQueuedActions(): Promise<QueueAction[]> {
  return readQueue();
}

/**
 * Drain the queue: try each pending action; remove on success, keep on failure.
 * Safe to call repeatedly. Returns the number of actions successfully flushed.
 */
export async function flush(
  fetcher: (url: string, init?: RequestInit) => Promise<Response>,
  backendUrl: string,
): Promise<number> {
  const q = await readQueue();
  if (q.length === 0) return 0;
  const remaining: QueueAction[] = [];
  let flushed = 0;
  for (const action of q) {
    try {
      const resp = await fetcher(`${backendUrl}/api/stops/${action.id}/${action.op}`, { method: 'POST' });
      if (resp.ok) {
        flushed += 1;
      } else {
        remaining.push(action);
      }
    } catch {
      remaining.push(action);
    }
  }
  await writeQueue(remaining);
  return flushed;
}
