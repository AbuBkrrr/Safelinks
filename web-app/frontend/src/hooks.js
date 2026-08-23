import { useCallback, useEffect, useRef, useState } from "react";

// Fetches `fetcher()` on mount and whenever `deps` change, exposes
// { data, loading, error, refetch }. `select` optionally reshapes the
// raw API response before it lands in `data` (e.g. pulling `.vouchers`
// out of `{ vouchers: [...] }`).
export function useResource(fetcher, deps = [], select = (x) => x) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const selectRef = useRef(select);
  selectRef.current = select;

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetcher();
      setData(selectRef.current(res));
    } catch (err) {
      setError(err.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { refetch(); }, [refetch]);

  return { data, loading, error, refetch, setData };
}
