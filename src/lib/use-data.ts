import { useCallback, useEffect, useState } from "react";

import { api } from "./api";

export function useData<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api<T>(path));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load data.");
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, loading, error, reload };
}
