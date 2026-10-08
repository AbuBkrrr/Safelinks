import { useCallback, useEffect, useRef, useState } from "react";
import * as offlineStore from "./offlineStore.js";

/**
 * Same shape as useResource â€” { data, loading, error, refetch, setData }
 * â€” plus `isFromCache` and `cachedAt`, so the UI can show "showing
 * data from 5 minutes ago" instead of pretending it's live.
 *
 * `cacheKey` identifies this resource in IndexedDB (e.g.
 * "pendingActivations", "vouchers") â€” pick something stable and
 * unique per resource type, not per-request.
 *
 * Deliberately a SEPARATE hook from useResource rather than a change
 * to it â€” useResource is used all over this app for things that don't
 * need offline support (settings forms, one-off lookups), and adding
 * IndexedDB reads/writes to every one of those unconditionally isn't
 * worth the risk for no benefit. Opt in per-resource instead.
 */
export function useOfflineResource(fetcher, cacheKey, deps = [], select = (x) => x) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isFromCache, setIsFromCache] = useState(false);
  const [cachedAt, setCachedAt] = useState(null);
  const selectRef = useRef(select);
  selectRef.current = select;

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetcher();
      const selected = selectRef.current(res);
      setData(selected);
      setIsFromCache(false);
      setCachedAt(null);
      // Fire-and-forget cache write - a failure here (e.g. storage
      // quota) shouldn't block showing data the user already has.
      offlineStore.setCachedCollection(cacheKey, selected).catch(() => {});
    } catch (err) {
      const cached = await offlineStore.getCachedCollection(cacheKey).catch(() => null);
      if (cached) {
        setData(cached.data);
        setIsFromCache(true);
        setCachedAt(cached.cachedAt);
        setError(null); // showing real (if stale) data, not an error state
      } else {
        // Never cached before and the live fetch failed - nothing to
        // fall back to, so this really is an error, same as
        // useResource's normal behavior.
        setError(err.message || "Something went wrong");
      }
    } finally {
      setLoading(false);
    }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { refetch(); }, [refetch]);

  return { data, loading, error, refetch, setData, isFromCache, cachedAt };
}
