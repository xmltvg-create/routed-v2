/**
 * authBridge.ts
 * ----------------------------------------------------------------
 * The store's `authFetch` is defined at module scope (no React
 * lifecycle), so it can't read from `AuthContext` directly. This
 * tiny singleton is the bridge: AuthProvider registers its
 * `reconnect()` here on mount, and `authFetch` reads it back at
 * 401 time. We also coalesce concurrent reconnects into a single
 * in-flight Promise — five parallel 401s should NOT pop five
 * browser tabs.
 *
 * Kept deliberately tiny (no React, no zustand) so it has zero
 * import-cycle risk with either the store or the AuthContext.
 */

type ReconnectFn = () => Promise<boolean>;

let registered: ReconnectFn | null = null;
let inFlight: Promise<boolean> | null = null;

export const setReconnectImpl = (fn: ReconnectFn | null) => {
  registered = fn;
};

/**
 * Returns a Promise that resolves to true iff the user is now
 * re-authenticated. Multiple callers within the same OAuth flow
 * receive the SAME Promise — no duplicate browser tabs.
 *
 * If no impl was registered (DEV mode, or AuthProvider not mounted
 * yet), resolves to false immediately so the caller can fall
 * through to its own error handling.
 */
export const triggerReconnect = (): Promise<boolean> => {
  if (!registered) return Promise.resolve(false);
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      return await registered!();
    } catch {
      return false;
    } finally {
      // Tear down on the next tick so anyone who awaited *this*
      // promise sees its terminal value, but a brand-new 401
      // five seconds later starts a fresh attempt.
      setTimeout(() => { inFlight = null; }, 0);
    }
  })();
  return inFlight;
};
