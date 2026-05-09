import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  checkOllamaStatus,
  pullModel,
  deleteModel,
  getModelCatalog,
  createCustomModel,
  onPullProgress,
  onPullDone,
  onPullError,
  onCreateProgress,
  onCreateDone,
  listModels,
} from "../lib/commands";
import type { OllamaStatus, OllamaModel, LibraryModel, PullProgress } from "../types";

export function useOllamaSetup() {
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const [installedModels, setInstalledModels] = useState<OllamaModel[]>([]);
  const [catalog, setCatalog] = useState<LibraryModel[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [pullingModel, setPullingModel] = useState<string | null>(null);
  const [pullProgress, setPullProgress] = useState<PullProgress | null>(null);
  const [creatingModel, setCreatingModel] = useState<string | null>(null);
  const [createStatus, setCreateStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pullUnsubRef = useRef<(() => void)[]>([]);
  const createUnsubRef = useRef<(() => void)[]>([]);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await checkOllamaStatus();
      setStatus(s);
      if (s.running) {
        const models = await listModels();
        setInstalledModels(models);
      }
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const setSearch = useCallback((query: string) => {
    setSearchQuery(query);
  }, []);

  const filteredModels = useMemo(() => {
    if (!searchQuery.trim()) return catalog;
    const q = searchQuery.toLowerCase();
    return catalog.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q) ||
        m.tags?.some((t) => t.toLowerCase().includes(q))
    );
  }, [catalog, searchQuery]);

  const handlePull = useCallback(async (name: string) => {
    setError(null);
    setPullingModel(name);
    setPullProgress(null);

    const unsubProgress = await onPullProgress((p) => {
      setPullProgress(p);
    });
    const unsubDone = await onPullDone(() => {
      setPullingModel(null);
      setPullProgress(null);
      refreshStatus();
    });
    const unsubError = await onPullError((err) => {
      setError(err);
      setPullingModel(null);
      setPullProgress(null);
    });

    pullUnsubRef.current = [unsubProgress, unsubDone, unsubError];

    try {
      await pullModel(name);
    } catch (e) {
      setError(String(e));
      setPullingModel(null);
      setPullProgress(null);
    }
  }, [refreshStatus]);

  const handleCreate = useCallback(async (name: string, baseModel: string, numCtx: number) => {
    setError(null);
    setCreatingModel(name);
    setCreateStatus(null);

    const unsubProgress = await onCreateProgress((s) => {
      setCreateStatus(s);
    });
    const unsubDone = await onCreateDone(() => {
      setCreatingModel(null);
      setCreateStatus(null);
      refreshStatus();
    });

    createUnsubRef.current = [unsubProgress, unsubDone];

    try {
      await createCustomModel(name, baseModel, numCtx);
    } catch (e) {
      setError(String(e));
      setCreatingModel(null);
      setCreateStatus(null);
    }
  }, [refreshStatus]);

  const handleDelete = useCallback(async (name: string) => {
    setError(null);
    try {
      await deleteModel(name);
      await refreshStatus();
    } catch (e) {
      setError(String(e));
    }
  }, [refreshStatus]);

  useEffect(() => {
    refreshStatus();
    getModelCatalog().then(setCatalog).catch(() => {});
    return () => {
      pullUnsubRef.current.forEach((unsub) => unsub());
      createUnsubRef.current.forEach((unsub) => unsub());
    };
  }, [refreshStatus]);

  return {
    status,
    installedModels,
    libraryModels: filteredModels,
    searchQuery,
    pullingModel,
    pullProgress,
    creatingModel,
    createStatus,
    error,
    refreshStatus,
    setSearch,
    handlePull,
    handleCreate,
    handleDelete,
  };
}
