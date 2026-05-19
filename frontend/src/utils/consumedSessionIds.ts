/**
 * Persisted dedupe of one-shot OAuth `session_id`s so the guard survives
 * `Updates.reloadAsync()` and process kills.
 *
 * Why: the in-memory `exchangedRef` Set is wiped on any JS-context reset
 * (OTA reload, Force Stop, crash). Android may then redeliver the same
 * auth redirect URL via `Linking.getInitialURL()`, which would trigger a
 * second exchange of an already-consumed `session_id` — demobackend returns
 * 404, our backend 401, and the user sees "Sign-in failed".
 *
 * Shape on disk: `{ [sessionId]: expiresAtMillis }`. Entries auto-prune on
 * every read. TTL of 10 min is comfortably longer than any realistic OTA
 * fetch window and short enough that the storage never grows unbounded.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'consumed_session_ids';
const TTL_MS = 10 * 60 * 1000;

type Store = Record<string, number>;

async function readStore(): Promise<Store> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Store;
    // Prune expired entries on every read so stale IDs never linger.
    const now = Date.now();
    const pruned: Store = {};
    let changed = false;
    for (const [id, exp] of Object.entries(parsed)) {
      if (exp > now) pruned[id] = exp;
      else changed = true;
    }
    if (changed) {
      await AsyncStorage.setItem(KEY, JSON.stringify(pruned)).catch(() => undefined);
    }
    return pruned;
  } catch {
    // Corrupt JSON or storage error — treat as empty rather than crash auth.
    return {};
  }
}

export async function hasConsumedSessionId(sessionId: string): Promise<boolean> {
  if (!sessionId) return false;
  const store = await readStore();
  return Boolean(store[sessionId]);
}

export async function markSessionIdConsumed(sessionId: string): Promise<void> {
  if (!sessionId) return;
  try {
    const store = await readStore();
    store[sessionId] = Date.now() + TTL_MS;
    await AsyncStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Non-fatal: the in-memory `exchangedRef` + token-on-disk guard still
    // protect the common path. We only lose the cross-reload safety net.
  }
}
