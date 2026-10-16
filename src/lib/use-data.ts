import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "./api";

export function useData<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState(path);
  const latestRequest = useRef(0);

  if (currentPath !== path) {
    setCurrentPath(path);
    setData(null);
    setPending(true);
    setError(null);
  }

  const reload = useCallback(async () => {
    const request = ++latestRequest.current;
    setPending(true);
    setError(null);
    try {
      const result = await api<T>(path);
      if (request === latestRequest.current) setData(result);
    } catch (caught) {
      if (request === latestRequest.current)
        setError(caught instanceof Error ? caught.message : "Unable to load data.");
    } finally {
      if (request === latestRequest.current) setPending(false);
    }
  }, [path]);

  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, loading: pending && data === null, error, reload };
}
