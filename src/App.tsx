import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Circle as CircleIcon,
  Crosshair,
  Download,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Grid,
  Hand,
  Image as ImageIcon,
  Layers,
  Loader2,
  Maximize,
  Maximize2,
  Minimize,
  Minus,
  MousePointer,
  Pencil,
  Redo2,
  Ruler,
  Settings,
  Square,
  Trash2,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  exportCanvasPng,
  exportDocumentToDxf,
  exportDrawingPdf,
  exportMeasurementReportPdf,
  exportMeasurementsCsv,
} from './cad/exporters';
import { measureEntity } from './cad/geometry';
import { OSNAP_LABELS } from './cad/osnap';
import { computeFitViewport, createBlankDocument, parseCadFile } from './cad/parsers';
import { SAMPLE_DRAWINGS, SampleDefinition } from './cad/samples';
import {
  clearRecentDrawings,
  deleteRecentDrawing,
  loadRecentDrawings,
  loadSessionSnapshot,
  loadUserSettings,
  RecentDrawingRecord,
  restoreDocumentFromSnapshot,
  saveRecentDrawing,
  saveSessionSnapshot,
  saveUserSettings,
} from './cad/storage';
import {
  CadDocument,
  CadEntity,
  CadUnit,
  CanvasBgTheme,
  EntityMeasurement,
  OsnapSettings,
  OsnapType,
  Point2D,
  ToolId,
  ViewportState,
} from './cad/types';
import { UNIT_SHORT } from './cad/units';
import { CadCanvas } from './components/CadCanvas';
import { FloatingMeasurementPopup } from './components/FloatingMeasurementPopup';
import { PWAInstallButton } from './components/PWAInstallButton';

type MobileSheet = 'measure' | 'settings' | null;
type SettingsTab = 'files' | 'layers' | 'units' | 'snap';

const DRAW_MODIFY_TOOLS: { id: ToolId; label: string }[] = [
  { id: 'line', label: 'Draw Line' },
  { id: 'polyline', label: 'Polyline' },
  { id: 'circle', label: 'Circle' },
  { id: 'rectangle', label: 'Rectangle' },
  { id: 'delete', label: 'Delete Obj' },
];

const DIMENSION_TOOLS: { id: ToolId; label: string; hint: string }[] = [
  { id: 'dim_aligned', label: 'Aligned', hint: 'Exact span between 2 points' },
  { id: 'dim_horizontal', label: 'Horizontal (ΔX)', hint: 'X-axis horizontal distance' },
  { id: 'dim_vertical', label: 'Vertical (ΔY)', hint: 'Y-axis vertical distance' },
  { id: 'dim_linear', label: 'Linear', hint: 'Orthogonal H/V dimension' },
  { id: 'dim_pointToPoint', label: 'Point-to-Point', hint: 'Manual 2-point distance' },
  { id: 'dim_angular', label: 'Angle', hint: '3 points: vertex + 2 rays' },
  { id: 'dim_radius', label: 'Radius', hint: 'Tap any circle or arc' },
  { id: 'dim_diameter', label: 'Diameter', hint: 'Tap any circle or arc' },
  { id: 'dim_arcLength', label: 'Arc Length', hint: 'Tap any arc' },
  { id: 'dim_perpendicular', label: 'Perpendicular', hint: 'Point to nearest line' },
  { id: 'dim_area', label: 'Area', hint: 'Closed shape or corners' },
  { id: 'dim_perimeter', label: 'Perimeter', hint: 'Closed boundary length' },
  { id: 'dim_chain', label: 'Chain', hint: 'Cumulative multi-segment' },
  { id: 'dim_polylineLength', label: 'Polyline Total', hint: 'Tap any polyline' },
];

const OSNAP_KEYS: (keyof Omit<OsnapSettings, 'enabled'>)[] = [
  'endpoint',
  'midpoint',
  'center',
  'intersection',
  'nearest',
  'perpendicular',
  'tangent',
  'quadrant',
];

export default function App() {
  const initialSettings = useMemo(() => loadUserSettings(), []);

  const [documents, setDocuments] = useState<CadDocument[]>(() => [
    { ...createBlankDocument('Loading...', 'mm'), dimStyle: initialSettings.dimStyle },
  ]);
  const [activeDocId, setActiveDocId] = useState<string>(() => documents[0].id);
  const [recentDrawings, setRecentDrawings] = useState<RecentDrawingRecord[]>([]);
  const [sessionHydrated, setSessionHydrated] = useState(false);

  const [activeTool, setActiveTool] = useState<ToolId>('measureInstant');
  const [osnap, setOsnap] = useState<OsnapSettings>(initialSettings.osnap);
  const [showGrid, setShowGrid] = useState<boolean>(initialSettings.showGrid);
  const [bgTheme, setBgTheme] = useState<CanvasBgTheme>(initialSettings.bgTheme);
  const [activeSheet, setActiveSheet] = useState<MobileSheet>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('files');
  const [isFullscreen, setIsFullscreen] = useState(false);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [activeMeasurement, setActiveMeasurement] = useState<EntityMeasurement | null>(null);
  const [cursorWorld, setCursorWorld] = useState<Point2D | null>(null);
  const [statusPrompt, setStatusPrompt] = useState('Tap any line or object to inspect length');

  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [unitPromptDismissed, setUnitPromptDismissed] = useState<Set<string>>(new Set());

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const canvasElementRef = useRef<HTMLCanvasElement | null>(null);
  const canvasDimsRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });
  const fittedDocIdsRef = useRef<Set<string>>(new Set());
  const workspaceRef = useRef<HTMLDivElement>(null);

  // Hydrate offline session + recent drawings from IndexedDB, or load built-in local sample
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [recent, session] = await Promise.all([loadRecentDrawings(), loadSessionSnapshot()]);
      if (cancelled) return;
      setRecentDrawings(recent);

      if (session && session.documents.length > 0) {
        const restored = session.documents.map(restoreDocumentFromSnapshot);
        setDocuments(restored);
        const validActive = restored.some((d) => d.id === session.activeDocId)
          ? session.activeDocId
          : restored[0].id;
        setActiveDocId(validActive);
        setSessionHydrated(true);
        return;
      }

      try {
        const sampleDoc = await SAMPLE_DRAWINGS[0].load();
        if (cancelled) return;
        sampleDoc.dimStyle = initialSettings.dimStyle;
        setDocuments([sampleDoc]);
        setActiveDocId(sampleDoc.id);
      } catch {
        // fallback already present
      } finally {
        if (!cancelled) setSessionHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialSettings.dimStyle]);

  const activeDoc = useMemo(
    () => documents.find((d) => d.id === activeDocId) || documents[0],
    [documents, activeDocId]
  );

  // Persist user preferences locally
  useEffect(() => {
    saveUserSettings({
      bgTheme,
      showGrid,
      osnap,
      continuousMeasure: false,
      dimStyle: activeDoc?.dimStyle || initialSettings.dimStyle,
    });
  }, [bgTheme, showGrid, osnap, activeDoc?.dimStyle, initialSettings.dimStyle]);

  // Persist open drawings locally
  useEffect(() => {
    if (!sessionHydrated) return;
    const timer = setTimeout(() => {
      void saveSessionSnapshot(documents, activeDocId);
    }, 500);
    return () => clearTimeout(timer);
  }, [documents, activeDocId, sessionHydrated]);

  const updateActiveDoc = useCallback(
    (updater: (doc: CadDocument) => CadDocument) => {
      setDocuments((prev) => prev.map((d) => (d.id === activeDocId ? updater(d) : d)));
    },
    [activeDocId]
  );

  const fitDocToSize = useCallback(
    (docId: string, width: number, height: number) => {
      if (width < 50 || height < 50) return;
      setDocuments((prev) =>
        prev.map((d) => {
          if (d.id !== docId || d.entities.length === 0) return d;
          const vis = new Set(
            Object.values(d.layers)
              .filter((l) => l.visible)
              .map((l) => l.name)
          );
          return { ...d, viewport: computeFitViewport(d.entities, vis, width, height) };
        })
      );
    },
    []
  );

  // Auto-fit drawing whenever activeDoc changes or real mobile canvas dimensions arrive
  useEffect(() => {
    const { width, height } = canvasDimsRef.current;
    if (width >= 50 && height >= 50 && activeDoc.entities.length > 0 && !fittedDocIdsRef.current.has(activeDoc.id)) {
      fittedDocIdsRef.current.add(activeDoc.id);
      fitDocToSize(activeDoc.id, width, height);
    }
  }, [activeDoc.id, activeDoc.entities.length, fitDocToSize]);

  const handleCanvasResize = useCallback(
    (width: number, height: number) => {
      const prev = canvasDimsRef.current;
      canvasDimsRef.current = { width, height };
      if (activeDoc.entities.length > 0) {
        if (!fittedDocIdsRef.current.has(activeDoc.id) || Math.abs(prev.width - width) > 20 || Math.abs(prev.height - height) > 20) {
          fittedDocIdsRef.current.add(activeDoc.id);
          fitDocToSize(activeDoc.id, width, height);
        }
      }
    },
    [activeDoc.id, activeDoc.entities.length, fitDocToSize]
  );

  const rememberRecent = useCallback(async (doc: CadDocument) => {
    await saveRecentDrawing(doc);
    setRecentDrawings(await loadRecentDrawings());
  }, []);

  const handleOpenFiles = useCallback(
    async (files: FileList) => {
      setIsLoadingFile(true);
      setErrorBanner(null);
      setActiveSheet(null);
      const loaded: CadDocument[] = [];
      const errors: string[] = [];

      for (const file of Array.from(files)) {
        try {
          const doc = await parseCadFile(file);
          doc.dimStyle = { ...initialSettings.dimStyle };
          const w = canvasDimsRef.current.width || canvasElementRef.current?.clientWidth || 390;
          const h = canvasDimsRef.current.height || canvasElementRef.current?.clientHeight || 680;
          const vis = new Set(
            Object.values(doc.layers)
              .filter((l) => l.visible)
              .map((l) => l.name)
          );
          doc.viewport = computeFitViewport(doc.entities, vis, w, h);
          fittedDocIdsRef.current.add(doc.id);
          loaded.push(doc);
          void rememberRecent(doc);
        } catch (err: any) {
          errors.push(`${file.name}: ${err?.message || 'Unable to read CAD file'}`);
        }
      }

      if (loaded.length > 0) {
        setDocuments((prev) => {
          const filtered = prev.length === 1 && prev[0].entities.length === 0 ? [] : prev;
          return [...filtered, ...loaded];
        });
        setActiveDocId(loaded[loaded.length - 1].id);
        setSelectedIds(new Set());
        setActiveMeasurement(null);
      }

      if (errors.length > 0) {
        setErrorBanner(errors.join(' | '));
      }
      setIsLoadingFile(false);
    },
    [initialSettings.dimStyle, rememberRecent]
  );

  const handleOpenRecent = useCallback(
    (record: RecentDrawingRecord) => {
      setActiveSheet(null);
      const existing = documents.find((d) => `${d.format}::${d.name}` === record.id);
      if (existing) {
        fittedDocIdsRef.current.delete(existing.id);
        setActiveDocId(existing.id);
        setSelectedIds(new Set());
        setActiveMeasurement(null);
        return;
      }
      const restored = restoreDocumentFromSnapshot({
        ...record.document,
        id: `doc_${Date.now()}`,
      });
      const w = canvasDimsRef.current.width || canvasElementRef.current?.clientWidth || 390;
      const h = canvasDimsRef.current.height || canvasElementRef.current?.clientHeight || 680;
      const vis = new Set(
        Object.values(restored.layers)
          .filter((l) => l.visible)
          .map((l) => l.name)
      );
      restored.viewport = computeFitViewport(restored.entities, vis, w, h);
      fittedDocIdsRef.current.add(restored.id);
      setDocuments((prev) => [...prev, restored]);
      setActiveDocId(restored.id);
      setSelectedIds(new Set());
      setActiveMeasurement(null);
      void rememberRecent(restored);
    },
    [documents, rememberRecent]
  );

  const handleLoadSample = useCallback(
    async (sample: SampleDefinition) => {
      setIsLoadingFile(true);
      setErrorBanner(null);
      setActiveSheet(null);
      try {
        const doc = await sample.load();
        doc.dimStyle = { ...initialSettings.dimStyle };
        const w = canvasDimsRef.current.width || canvasElementRef.current?.clientWidth || 390;
        const h = canvasDimsRef.current.height || canvasElementRef.current?.clientHeight || 680;
        const vis = new Set(
          Object.values(doc.layers)
            .filter((l) => l.visible)
            .map((l) => l.name)
        );
        doc.viewport = computeFitViewport(doc.entities, vis, w, h);
        fittedDocIdsRef.current.add(doc.id);
        setDocuments((prev) => [...prev, doc]);
        setActiveDocId(doc.id);
        setSelectedIds(new Set());
        setActiveMeasurement(null);
        void rememberRecent(doc);
      } catch (err: any) {
        setErrorBanner(err?.message || 'Failed to load sample drawing');
      } finally {
        setIsLoadingFile(false);
      }
    },
    [initialSettings.dimStyle, rememberRecent]
  );

  const handleCloseDoc = useCallback(
    (id: string) => {
      setDocuments((prev) => {
        if (prev.length <= 1) return prev;
        const idx = prev.findIndex((d) => d.id === id);
        const next = prev.filter((d) => d.id !== id);
        if (activeDocId === id) {
          const fallback = next[Math.max(0, idx - 1)] || next[0];
          setActiveDocId(fallback.id);
          setSelectedIds(new Set());
          setActiveMeasurement(null);
        }
        return next;
      });
    },
    [activeDocId]
  );

  const handleCommitEntities = useCallback(
    (nextEntities: CadEntity[], pushUndo = true) => {
      updateActiveDoc((doc) => ({
        ...doc,
        entities: nextEntities,
        undoStack: pushUndo ? [...doc.undoStack.slice(-49), doc.entities] : doc.undoStack,
        redoStack: pushUndo ? [] : doc.redoStack,
        isDirty: true,
      }));
    },
    [updateActiveDoc]
  );

  const syncSelectionAfterHistory = useCallback((entities: CadEntity[]) => {
    setSelectedIds((prev) => {
      const next = new Set(Array.from(prev).filter((id) => entities.some((e) => e.id === id)));
      if (next.size === 1) {
        const ent = entities.find((e) => next.has(e.id));
        setActiveMeasurement(ent ? measureEntity(ent) : null);
      } else {
        setActiveMeasurement(null);
      }
      return next;
    });
  }, []);

  const canUndo = (activeDoc?.undoStack.length ?? 0) > 0;
  const canRedo = (activeDoc?.redoStack.length ?? 0) > 0;

  const handleUndo = useCallback(() => {
    if (!activeDoc || activeDoc.undoStack.length === 0) return;
    const prevEntities = activeDoc.undoStack[activeDoc.undoStack.length - 1];
    updateActiveDoc((doc) => {
      if (doc.undoStack.length === 0) return doc;
      const target = doc.undoStack[doc.undoStack.length - 1];
      return {
        ...doc,
        entities: target,
        undoStack: doc.undoStack.slice(0, -1),
        redoStack: [...doc.redoStack.slice(-49), doc.entities],
        isDirty: true,
      };
    });
    syncSelectionAfterHistory(prevEntities);
  }, [activeDoc, syncSelectionAfterHistory, updateActiveDoc]);

  const handleRedo = useCallback(() => {
    if (!activeDoc || activeDoc.redoStack.length === 0) return;
    const nextEntities = activeDoc.redoStack[activeDoc.redoStack.length - 1];
    updateActiveDoc((doc) => {
      if (doc.redoStack.length === 0) return doc;
      const target = doc.redoStack[doc.redoStack.length - 1];
      return {
        ...doc,
        entities: target,
        undoStack: [...doc.undoStack.slice(-49), doc.entities],
        redoStack: doc.redoStack.slice(0, -1),
        isDirty: true,
      };
    });
    syncSelectionAfterHistory(nextEntities);
  }, [activeDoc, syncSelectionAfterHistory, updateActiveDoc]);

  const handleDeleteSelected = useCallback(() => {
    if (!activeDoc || selectedIds.size === 0) return;
    handleCommitEntities(
      activeDoc.entities.filter((e) => !selectedIds.has(e.id)),
      true
    );
    setSelectedIds(new Set());
    setActiveMeasurement(null);
  }, [activeDoc, handleCommitEntities, selectedIds]);

  const handleChangeDisplayUnit = useCallback(
    (unit: CadUnit | 'drawing') => {
      updateActiveDoc((doc) => {
        if (unit !== 'drawing' && doc.nativeUnit === 'undefined') {
          return {
            ...doc,
            nativeUnit: unit,
            dimStyle: { ...doc.dimStyle, displayUnit: 'drawing' },
          };
        }
        return {
          ...doc,
          dimStyle: { ...doc.dimStyle, displayUnit: unit },
        };
      });
    },
    [updateActiveDoc]
  );

  // Global Undo / Redo keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      } else if (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleUndo, handleRedo]);

  const checkDimCount = useMemo(
    () => activeDoc.entities.filter((e) => e.type === 'DIMENSION' && e.id.startsWith('dim_')).length,
    [activeDoc.entities]
  );

  const handleClearCheckedDims = useCallback(() => {
    handleCommitEntities(
      activeDoc.entities.filter((e) => !(e.type === 'DIMENSION' && e.id.startsWith('dim_'))),
      true
    );
    setSelectedIds(new Set());
    setActiveMeasurement(null);
    setActiveSheet(null);
  }, [activeDoc.entities, handleCommitEntities]);

  const handleZoomBy = useCallback(
    (factor: number) => {
      const w = canvasDimsRef.current.width || canvasElementRef.current?.clientWidth || 390;
      const h = canvasDimsRef.current.height || canvasElementRef.current?.clientHeight || 680;
      const cx = w / 2;
      const cy = h / 2;
      updateActiveDoc((doc) => {
        const vp = doc.viewport;
        const newScale = Math.max(1e-5, Math.min(50000, vp.scale * factor));
        const wx = (cx - vp.offsetX) / vp.scale;
        const wy = -(cy - vp.offsetY) / vp.scale;
        return {
          ...doc,
          viewport: {
            scale: newScale,
            offsetX: cx - wx * newScale,
            offsetY: cy + wy * newScale,
          },
        };
      });
    },
    [updateActiveDoc]
  );

  const handleZoomFit = useCallback(() => {
    const w = canvasDimsRef.current.width || canvasElementRef.current?.clientWidth || 390;
    const h = canvasDimsRef.current.height || canvasElementRef.current?.clientHeight || 680;
    fitDocToSize(activeDoc.id, w, h);
  }, [activeDoc.id, fitDocToSize]);

  const handleToggleFullscreen = useCallback(() => {
    const el = workspaceRef.current || document.documentElement;
    if (!document.fullscreenElement) {
      el.requestFullscreen?.().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen?.().catch(() => {});
      setIsFullscreen(false);
    }
  }, []);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const handleSelectPolylineSegment = useCallback(
    (segIndex: number) => {
      if (!activeMeasurement || !activeDoc) return;
      const ent = activeDoc.entities.find((e) => e.id === activeMeasurement.entityId);
      if (!ent) return;
      setActiveMeasurement(measureEntity(ent, segIndex));
    },
    [activeMeasurement, activeDoc]
  );

  const activeDimInfo = DIMENSION_TOOLS.find((t) => t.id === activeTool);
  const activeEditInfo = DRAW_MODIFY_TOOLS.find((t) => t.id === activeTool);

  return (
    <div
      ref={workspaceRef}
      className="h-[100dvh] w-[100vw] max-w-[100vw] flex flex-col bg-[#090B0F] text-slate-100 overflow-hidden select-none"
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".dwg,.dxf,application/acad,application/dxf,application/dwg,application/octet-stream,*/*"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            void handleOpenFiles(e.target.files);
            e.target.value = '';
          }
        }}
      />

      {/* Mobile Top Bar: Logo, Undo, Redo, Open File, Settings */}
      <header className="safe-top bg-[#0D1119] border-b border-slate-800/90 shrink-0 z-30">
        <div className="px-2.5 h-[54px] flex items-center justify-between gap-1.5">
          {/* App Logo */}
          <div className="flex items-center gap-1.5 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-sky-500/15 border border-sky-500/40 flex items-center justify-center text-sky-400 shrink-0">
              <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.2">
                <path d="M4 20L20 4M4 20H12M4 20V12M15 4H20V9" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <span className="font-semibold text-[13px] tracking-tight text-white truncate">CAD Master</span>
          </div>

          {/* Undo, Redo, Open File & Settings */}
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={handleUndo}
              disabled={!canUndo}
              aria-label="Undo"
              title="Undo (Ctrl+Z)"
              className={`w-9 h-10 rounded-xl border flex items-center justify-center transition-colors shrink-0 ${
                canUndo
                  ? 'bg-[#151C28] border-slate-700/80 text-slate-100 active:bg-slate-700 cursor-pointer'
                  : 'bg-[#101520] border-slate-800/70 text-slate-600 cursor-not-allowed'
              }`}
            >
              <Undo2 className="w-4 h-4" />
            </button>

            <button
              type="button"
              onClick={handleRedo}
              disabled={!canRedo}
              aria-label="Redo"
              title="Redo (Ctrl+Y)"
              className={`w-9 h-10 rounded-xl border flex items-center justify-center transition-colors shrink-0 ${
                canRedo
                  ? 'bg-[#151C28] border-slate-700/80 text-slate-100 active:bg-slate-700 cursor-pointer'
                  : 'bg-[#101520] border-slate-800/70 text-slate-600 cursor-not-allowed'
              }`}
            >
              <Redo2 className="w-4 h-4" />
            </button>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1.5 px-2.5 min-h-[40px] rounded-xl bg-sky-600 active:bg-sky-500 text-white text-xs font-semibold cursor-pointer whitespace-nowrap shrink-0"
            >
              <FolderOpen className="w-4 h-4 shrink-0" />
              <span>Open</span>
              <span className="hidden min-[380px]:inline">File</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveSheet((s) => (s === 'settings' ? null : 'settings'))}
              aria-label="Settings"
              className={`w-10 h-10 rounded-xl border flex items-center justify-center cursor-pointer transition-colors shrink-0 ${
                activeSheet === 'settings'
                  ? 'bg-sky-500/20 border-sky-500 text-sky-300'
                  : 'bg-[#151C28] border-slate-700/80 text-slate-200'
              }`}
            >
              <Settings className="w-4.5 h-4.5" />
            </button>
          </div>
        </div>
      </header>

      {/* Error Notice */}
      {errorBanner && (
        <div className="bg-rose-950/95 border-b border-rose-500/40 px-3 py-2 flex items-center justify-between gap-2 text-xs text-rose-100 z-30 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
            <span className="truncate">{errorBanner}</span>
          </div>
          <button onClick={() => setErrorBanner(null)} className="p-1.5 cursor-pointer shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Undefined Unit Quick Prompt */}
      {activeDoc.nativeUnit === 'undefined' && !unitPromptDismissed.has(activeDoc.id) && (
        <div className="bg-amber-950/90 border-b border-amber-500/40 px-3 py-1.5 flex items-center justify-between gap-2 text-xs text-amber-100 z-30 shrink-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span>Unit:</span>
            {(['mm', 'cm', 'm', 'in', 'ft'] as CadUnit[]).map((u) => (
              <button
                key={u}
                onClick={() => updateActiveDoc((d) => ({ ...d, nativeUnit: u }))}
                className="px-2 py-1 rounded-lg bg-amber-500/25 border border-amber-400/40 font-mono-cad cursor-pointer"
              >
                {u}
              </button>
            ))}
          </div>
          <button
            onClick={() => setUnitPromptDismissed((prev) => new Set(prev).add(activeDoc.id))}
            className="p-1.5 cursor-pointer shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Main Area: Full-Width CAD Drawing Viewer */}
      <main className="flex-1 w-full min-h-0 relative overflow-hidden flex flex-col">
        <CadCanvas
          doc={activeDoc}
          activeTool={activeTool}
          continuousMeasure={false}
          osnap={osnap}
          showGrid={showGrid}
          bgTheme={bgTheme}
          selectedIds={selectedIds}
          activeMeasurement={activeMeasurement}
          onCanvasReady={(c) => {
            canvasElementRef.current = c;
          }}
          onCanvasResize={handleCanvasResize}
          onViewportChange={(vp: ViewportState) =>
            updateActiveDoc((d) => ({ ...d, viewport: vp }))
          }
          onCursorMove={setCursorWorld}
          onSelectEntities={(ids, meas) => {
            setSelectedIds(ids);
            setActiveMeasurement(meas);
          }}
          onCommitEntities={handleCommitEntities}
          onUpdateStatusPrompt={setStatusPrompt}
          onSetTool={setActiveTool}
          onFileDrop={handleOpenFiles}
        />

        {/* Non-overlapping Top-Left Drawing Pill */}
        <div className="absolute top-2.5 left-2.5 right-14 z-10 pointer-events-none flex flex-col items-start gap-1.5">
          <button
            onClick={() => {
              setSettingsTab('files');
              setActiveSheet('settings');
            }}
            className="pointer-events-auto max-w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-[#0D1119]/85 backdrop-blur-xs border border-slate-800 text-[11px] text-slate-200 cursor-pointer"
          >
            <span className="font-medium truncate">{activeDoc.name}</span>
            <span className="text-sky-400 font-mono-cad shrink-0">
              {activeDoc.nativeUnit === 'undefined' ? 'units' : UNIT_SHORT[activeDoc.nativeUnit]}
            </span>
          </button>

          {(activeDimInfo || activeEditInfo) && (
            <div className="px-2.5 py-1 rounded-lg bg-sky-950/90 border border-sky-500/40 text-[11px] text-sky-200 max-w-full truncate">
              {activeDimInfo
                ? `${activeDimInfo.label}: ${activeDimInfo.hint}`
                : `${activeEditInfo!.label}: ${statusPrompt}`}
            </div>
          )}

          {cursorWorld && (activeTool.startsWith('dim_') || activeEditInfo) && (
            <div className="px-2 py-0.5 rounded-md bg-[#0D1119]/80 border border-slate-800 text-[10px] font-mono-cad text-slate-300">
              X:{cursorWorld.x.toFixed(activeDoc.dimStyle.precision)} Y:{cursorWorld.y.toFixed(activeDoc.dimStyle.precision)}
            </div>
          )}
        </div>

        {/* Non-overlapping Top-Right Compact Viewport Controls */}
        <div className="absolute top-2.5 right-2.5 z-10 flex flex-col gap-1.5">
          <button
            onClick={handleZoomFit}
            aria-label="Fit Drawing to Screen"
            className="w-10 h-10 rounded-xl bg-[#0D1119]/85 backdrop-blur-xs border border-slate-700/80 text-sky-300 flex items-center justify-center shadow-lg cursor-pointer"
          >
            <Maximize2 className="w-4 h-4" />
          </button>
          <button
            onClick={() => handleZoomBy(1.28)}
            aria-label="Zoom In"
            className="w-10 h-10 rounded-xl bg-[#0D1119]/85 backdrop-blur-xs border border-slate-800 text-slate-200 flex items-center justify-center shadow-lg cursor-pointer"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <button
            onClick={() => handleZoomBy(0.78)}
            aria-label="Zoom Out"
            className="w-10 h-10 rounded-xl bg-[#0D1119]/85 backdrop-blur-xs border border-slate-800 text-slate-200 flex items-center justify-center shadow-lg cursor-pointer"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          {checkDimCount > 0 && (
            <button
              onClick={handleClearCheckedDims}
              aria-label="Clear Checked Dimensions"
              className="w-10 h-10 rounded-xl bg-rose-950/90 border border-rose-500/40 text-rose-200 flex items-center justify-center shadow-lg cursor-pointer"
              title={`Clear ${checkDimCount} check(s)`}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Loading Overlay */}
        {isLoadingFile && (
          <div className="absolute inset-0 z-40 bg-slate-950/75 backdrop-blur-xs flex items-center justify-center p-4">
            <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-[#151C28] border border-slate-700 text-xs text-slate-100">
              <Loader2 className="w-4 h-4 text-sky-400 animate-spin" />
              <span>Opening CAD drawing locally...</span>
            </div>
          </div>
        )}
      </main>

      {/* Fixed Bottom Line Measurement Information Panel */}
      <FloatingMeasurementPopup
        measurement={activeMeasurement}
        activeTool={activeTool}
        nativeUnit={activeDoc.nativeUnit}
        dimStyle={activeDoc.dimStyle}
        canDeleteSelected={selectedIds.size > 0}
        onChangeDisplayUnit={handleChangeDisplayUnit}
        onDeleteSelected={handleDeleteSelected}
        onClose={() => {
          setActiveMeasurement(null);
          setSelectedIds(new Set());
        }}
        onSelectSegment={handleSelectPolylineSegment}
      />

      {/* Mobile Bottom Toolbar: Select, Pan, Line Length, Measure */}
      <nav className="safe-bottom bg-[#0D1119] border-t border-slate-800 shrink-0 z-30">
        <div className="px-2 py-1.5 grid grid-cols-4 gap-1.5">
          <button
            type="button"
            onClick={() => {
              setActiveTool('select');
              setActiveSheet(null);
            }}
            className={`min-h-[54px] flex flex-col items-center justify-center rounded-xl text-[11px] font-medium cursor-pointer transition-colors ${
              activeTool === 'select' && !activeSheet
                ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                : 'text-slate-400 active:bg-slate-800/70'
            }`}
          >
            <MousePointer className="w-5 h-5 mb-0.5" />
            <span>Select</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setActiveTool('pan');
              setActiveSheet(null);
            }}
            className={`min-h-[54px] flex flex-col items-center justify-center rounded-xl text-[11px] font-medium cursor-pointer transition-colors ${
              activeTool === 'pan' && !activeSheet
                ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                : 'text-slate-400 active:bg-slate-800/70'
            }`}
          >
            <Hand className="w-5 h-5 mb-0.5" />
            <span>Pan</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setActiveTool('measureInstant');
              setActiveSheet(null);
            }}
            className={`min-h-[54px] flex flex-col items-center justify-center rounded-xl text-[11px] font-medium cursor-pointer transition-colors ${
              activeTool === 'measureInstant' && !activeSheet
                ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                : 'text-slate-400 active:bg-slate-800/70'
            }`}
          >
            <Minus className="w-5 h-5 mb-0.5 -rotate-45" />
            <span>Line Length</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveSheet((s) => (s === 'measure' ? null : 'measure'))}
            className={`min-h-[54px] flex flex-col items-center justify-center rounded-xl text-[11px] font-medium cursor-pointer transition-colors ${
              activeSheet === 'measure' || ((activeTool.startsWith('dim_') || Boolean(activeEditInfo)) && !activeSheet)
                ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                : 'text-slate-400 active:bg-slate-800/70'
            }`}
          >
            <Ruler className="w-5 h-5 mb-0.5" />
            <span>Measure</span>
          </button>
        </div>
      </nav>

      {/* Mobile Bottom Sheet: Measure & Draw Tools */}
      {activeSheet === 'measure' && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-xs flex items-end justify-center"
          onClick={() => setActiveSheet(null)}
        >
          <div
            className="w-full max-w-lg rounded-t-2xl bg-[#111622] border-t border-slate-700/80 p-4 safe-bottom max-h-[78dvh] flex flex-col text-slate-100"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-10 h-1 bg-slate-700 rounded-full mx-auto mb-3 shrink-0" />
            <div className="flex items-center justify-between pb-2.5 border-b border-slate-800 shrink-0">
              <div>
                <h2 className="text-sm font-semibold">Measure &amp; Draw Tools</h2>
                <p className="text-[11px] text-slate-400">{statusPrompt}</p>
              </div>
              <button
                onClick={() => setActiveSheet(null)}
                className="w-9 h-9 rounded-xl bg-slate-800/80 flex items-center justify-center text-slate-300 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="pt-3 pb-2 overflow-y-auto space-y-3">
              {/* Primary Measurement Tool */}
              <button
                type="button"
                onClick={() => {
                  setActiveTool('measureInstant');
                  setActiveSheet(null);
                }}
                className={`w-full text-left p-3 rounded-xl border flex items-center justify-between gap-3 cursor-pointer transition-colors ${
                  activeTool === 'measureInstant'
                    ? 'bg-sky-500/20 border-sky-500 text-sky-200'
                    : 'bg-[#161D2C] border-slate-800 text-slate-100'
                }`}
              >
                <div>
                  <div className="text-xs font-semibold flex items-center gap-2">
                    <span>Line Select Measurement</span>
                    <span className="px-1.5 py-0.5 rounded bg-sky-500/25 text-sky-300 text-[10px] font-medium">
                      Primary
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    Tap any line or polyline to instantly show total length
                  </div>
                </div>
                <Minus className="w-5 h-5 text-sky-400 -rotate-45 shrink-0" />
              </button>

              {/* Quick Draw & Edit (Undo/Redo compatible) */}
              <div>
                <div className="text-[11px] font-semibold text-slate-400 uppercase mb-1.5">
                  Draw &amp; Edit
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {DRAW_MODIFY_TOOLS.map((tool) => {
                    const active = activeTool === tool.id;
                    const Icon =
                      tool.id === 'line'
                        ? Minus
                        : tool.id === 'polyline'
                          ? Pencil
                          : tool.id === 'circle'
                            ? CircleIcon
                            : tool.id === 'rectangle'
                              ? Square
                              : Trash2;
                    return (
                      <button
                        key={tool.id}
                        type="button"
                        onClick={() => {
                          setActiveTool(tool.id);
                          setActiveSheet(null);
                        }}
                        className={`flex items-center justify-center gap-1.5 px-2.5 min-h-[44px] rounded-xl border text-xs font-medium cursor-pointer ${
                          active
                            ? 'bg-sky-500/20 border-sky-500 text-sky-200'
                            : 'bg-[#161D2C] border-slate-800 text-slate-200'
                        }`}
                      >
                        <Icon className="w-3.5 h-3.5 shrink-0" />
                        <span>{tool.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Additional Dimension Tools */}
              <div>
                <div className="text-[11px] font-semibold text-slate-400 uppercase mb-1.5">
                  Dimension Annotations
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {DIMENSION_TOOLS.map((tool) => {
                    const active = activeTool === tool.id;
                    return (
                      <button
                        key={tool.id}
                        type="button"
                        onClick={() => {
                          setActiveTool(tool.id);
                          setActiveSheet(null);
                        }}
                        className={`text-left p-3 rounded-xl border min-h-[56px] cursor-pointer transition-colors ${
                          active
                            ? 'bg-sky-500/20 border-sky-500 text-sky-200'
                            : 'bg-[#161D2C] border-slate-800 text-slate-200'
                        }`}
                      >
                        <div className="text-xs font-semibold">{tool.label}</div>
                        <div className="text-[10px] text-slate-400 mt-0.5 leading-snug">{tool.hint}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {checkDimCount > 0 && (
              <button
                type="button"
                onClick={handleClearCheckedDims}
                className="mt-2 w-full py-3 rounded-xl bg-rose-950/75 border border-rose-500/40 text-xs text-rose-200 font-semibold cursor-pointer shrink-0"
              >
                Clear Checked Dimensions ({checkDimCount})
              </button>
            )}
          </div>
        </div>
      )}

      {/* Mobile Bottom Sheet: Settings (Files, Layers, Units, Snap & View) */}
      {activeSheet === 'settings' && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-xs flex items-end justify-center"
          onClick={() => setActiveSheet(null)}
        >
          <div
            className="w-full max-w-lg rounded-t-2xl bg-[#111622] border-t border-slate-700/80 p-4 safe-bottom max-h-[82dvh] flex flex-col text-slate-100"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-10 h-1 bg-slate-700 rounded-full mx-auto mb-3 shrink-0" />
            <div className="flex items-center justify-between pb-2.5 border-b border-slate-800 shrink-0">
              <h2 className="text-sm font-semibold">Viewer Settings & Files</h2>
              <button
                onClick={() => setActiveSheet(null)}
                className="w-9 h-9 rounded-xl bg-slate-800/80 flex items-center justify-center text-slate-300 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Settings Sub-Tabs (fits 360px cleanly without horizontal scroll) */}
            <div className="grid grid-cols-4 gap-1.5 py-2.5 shrink-0">
              {(
                [
                  { id: 'files', label: 'Files' },
                  { id: 'layers', label: 'Layers' },
                  { id: 'units', label: 'Units' },
                  { id: 'snap', label: 'Snap' },
                ] as { id: SettingsTab; label: string }[]
              ).map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setSettingsTab(tab.id)}
                  className={`py-2 rounded-xl text-xs font-semibold cursor-pointer ${
                    settingsTab === tab.id
                      ? 'bg-sky-600 text-white'
                      : 'bg-[#161D2C] text-slate-300 border border-slate-800'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto space-y-4 pt-1 pb-3 text-xs">
              {/* Tab 1: Files, Samples, Recent, Display Actions */}
              {settingsTab === 'files' && (
                <div className="space-y-4">
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full py-3 rounded-xl bg-sky-600 text-white font-semibold flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <FolderOpen className="w-4 h-4" />
                    <span>Open DWG / DXF from Device</span>
                  </button>

                  {documents.length > 1 && (
                    <div className="space-y-1.5">
                      <div className="text-[11px] font-semibold text-slate-400 uppercase">Open Drawings</div>
                      {documents.map((doc) => (
                        <div
                          key={doc.id}
                          onClick={() => {
                            setActiveDocId(doc.id);
                            setSelectedIds(new Set());
                            setActiveMeasurement(null);
                            setActiveSheet(null);
                          }}
                          className={`flex items-center justify-between px-3 py-2.5 rounded-xl border cursor-pointer ${
                            doc.id === activeDocId
                              ? 'bg-sky-500/15 border-sky-500/50 text-sky-200'
                              : 'bg-[#161D2C] border-slate-800 text-slate-200'
                          }`}
                        >
                          <span className="truncate font-medium">{doc.name}</span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCloseDoc(doc.id);
                            }}
                            className="p-1 text-slate-400 hover:text-rose-400"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="space-y-1.5">
                    <div className="text-[11px] font-semibold text-slate-400 uppercase">Sample Drawings</div>
                    <div className="grid grid-cols-1 gap-2">
                      {SAMPLE_DRAWINGS.map((s) => (
                        <button
                          key={s.id}
                          onClick={() => handleLoadSample(s)}
                          className="text-left px-3 py-2.5 rounded-xl bg-[#161D2C] border border-slate-800 cursor-pointer"
                        >
                          <div className="font-medium text-slate-100">{s.title}</div>
                          <div className="text-[11px] text-slate-400 mt-0.5">{s.subtitle}</div>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold text-slate-400 uppercase">Recent Files</span>
                      {recentDrawings.length > 0 && (
                        <button
                          onClick={async () => {
                            await clearRecentDrawings();
                            setRecentDrawings([]);
                          }}
                          className="text-[11px] text-rose-400 cursor-pointer"
                        >
                          Clear
                        </button>
                      )}
                    </div>
                    {recentDrawings.length === 0 ? (
                      <div className="text-slate-500 py-1">No recent files cached locally yet.</div>
                    ) : (
                      recentDrawings.map((rec) => (
                        <div
                          key={rec.id}
                          onClick={() => handleOpenRecent(rec)}
                          className="flex items-center justify-between px-3 py-2 rounded-xl bg-[#161D2C] border border-slate-800 cursor-pointer"
                        >
                          <div className="min-w-0">
                            <div className="font-medium truncate">{rec.name}</div>
                            <div className="text-[11px] text-slate-400 font-mono-cad">
                              {rec.format} · {rec.entityCount} objs · {UNIT_SHORT[rec.nativeUnit]}
                            </div>
                          </div>
                          <button
                            onClick={async (e) => {
                              e.stopPropagation();
                              await deleteRecentDrawing(rec.id);
                              setRecentDrawings(await loadRecentDrawings());
                            }}
                            className="p-1.5 text-slate-500 hover:text-rose-400 cursor-pointer"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      ))
                    )}
                  </div>

                  {/* Local Offline Exports */}
                  <div className="space-y-1.5">
                    <div className="text-[11px] font-semibold text-slate-400 uppercase">
                      Export Locally (Offline)
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => exportDocumentToDxf(activeDoc)}
                        className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[#161D2C] border border-slate-800 text-slate-200 font-medium cursor-pointer"
                      >
                        <Download className="w-4 h-4 text-sky-400" />
                        <span>Save DXF</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => exportMeasurementsCsv(activeDoc, selectedIds)}
                        className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[#161D2C] border border-slate-800 text-slate-200 font-medium cursor-pointer"
                      >
                        <FileSpreadsheet className="w-4 h-4 text-emerald-400" />
                        <span>CSV Report</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (canvasElementRef.current) exportDrawingPdf(canvasElementRef.current, activeDoc);
                        }}
                        className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[#161D2C] border border-slate-800 text-slate-200 font-medium cursor-pointer"
                      >
                        <FileText className="w-4 h-4 text-rose-400" />
                        <span>Drawing PDF</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => exportMeasurementReportPdf(activeDoc, selectedIds)}
                        className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[#161D2C] border border-slate-800 text-slate-200 font-medium cursor-pointer"
                      >
                        <FileText className="w-4 h-4 text-amber-400" />
                        <span>Report PDF</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (canvasElementRef.current) exportCanvasPng(canvasElementRef.current, activeDoc.name);
                        }}
                        className="col-span-2 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[#161D2C] border border-slate-800 text-slate-200 font-medium cursor-pointer"
                      >
                        <ImageIcon className="w-4 h-4 text-indigo-400" />
                        <span>Export PNG Snapshot</span>
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <button
                      onClick={() => {
                        handleZoomFit();
                        setActiveSheet(null);
                      }}
                      className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[#161D2C] border border-slate-800 text-sky-300 font-medium cursor-pointer"
                    >
                      <Maximize2 className="w-4 h-4" />
                      <span>Fit Screen</span>
                    </button>
                    <button
                      onClick={handleToggleFullscreen}
                      className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[#161D2C] border border-slate-800 text-slate-200 font-medium cursor-pointer"
                    >
                      {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
                      <span>{isFullscreen ? 'Exit Full' : 'Full Screen'}</span>
                    </button>
                  </div>

                  <div className="flex justify-center">
                    <PWAInstallButton />
                  </div>
                </div>
              )}

              {/* Tab 2: Layers */}
              {settingsTab === 'layers' && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-slate-400">
                      <Layers className="w-4 h-4 text-sky-400" />
                      <span>{Object.keys(activeDoc.layers).length} Layers</span>
                    </div>
                    <div className="flex gap-3">
                      <button
                        onClick={() =>
                          updateActiveDoc((d) => {
                            const next = { ...d.layers };
                            Object.keys(next).forEach((k) => {
                              next[k] = { ...next[k], visible: true };
                            });
                            return { ...d, layers: next };
                          })
                        }
                        className="text-sky-400 font-semibold cursor-pointer"
                      >
                        Show All
                      </button>
                      <button
                        onClick={() =>
                          updateActiveDoc((d) => {
                            const next = { ...d.layers };
                            Object.keys(next).forEach((k) => {
                              next[k] = { ...next[k], visible: false };
                            });
                            return { ...d, layers: next };
                          })
                        }
                        className="text-rose-400 font-semibold cursor-pointer"
                      >
                        Hide All
                      </button>
                    </div>
                  </div>

                  {Object.values(activeDoc.layers).map((layer) => (
                    <button
                      key={layer.name}
                      onClick={() =>
                        updateActiveDoc((d) => ({
                          ...d,
                          layers: {
                            ...d.layers,
                            [layer.name]: { ...layer, visible: !layer.visible },
                          },
                        }))
                      }
                      className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl bg-[#161D2C] border border-slate-800 cursor-pointer"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span
                          className="w-3.5 h-3.5 rounded-full shrink-0 border border-white/20"
                          style={{ backgroundColor: layer.color }}
                        />
                        <span className="truncate font-medium">{layer.name}</span>
                      </div>
                      <span
                        className={`px-2.5 py-0.5 rounded-lg text-[11px] font-semibold ${
                          layer.visible ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-800 text-slate-500'
                        }`}
                      >
                        {layer.visible ? 'ON' : 'OFF'}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {/* Tab 3: Units & Display */}
              {settingsTab === 'units' && (
                <div className="space-y-4">
                  <div>
                    <div className="text-slate-400 mb-1.5 font-medium">Drawing Native Units</div>
                    <div className="grid grid-cols-5 gap-1.5">
                      {(['mm', 'cm', 'm', 'in', 'ft'] as CadUnit[]).map((u) => (
                        <button
                          key={u}
                          onClick={() => updateActiveDoc((d) => ({ ...d, nativeUnit: u }))}
                          className={`py-2.5 rounded-xl border font-mono-cad font-semibold cursor-pointer ${
                            activeDoc.nativeUnit === u
                              ? 'bg-sky-500/20 border-sky-500 text-sky-300'
                              : 'bg-[#161D2C] border-slate-800 text-slate-300'
                          }`}
                        >
                          {u}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="text-slate-400 mb-1.5 font-medium">Convert Measurement Display</div>
                    <div className="grid grid-cols-3 gap-1.5">
                      {(['drawing', 'mm', 'cm', 'm', 'in', 'ft'] as const).map((u) => (
                        <button
                          key={u}
                          onClick={() => handleChangeDisplayUnit(u)}
                          className={`py-2 rounded-xl border font-mono-cad font-semibold cursor-pointer ${
                            activeDoc.dimStyle.displayUnit === u
                              ? 'bg-sky-500/20 border-sky-500 text-sky-300'
                              : 'bg-[#161D2C] border-slate-800 text-slate-300'
                          }`}
                        >
                          {u === 'drawing' ? 'Native' : u}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="text-slate-400 mb-1.5 font-medium">Decimal Precision</div>
                    <div className="grid grid-cols-5 gap-1.5">
                      {[0, 1, 2, 3, 4].map((p) => (
                        <button
                          key={p}
                          onClick={() =>
                            updateActiveDoc((d) => ({ ...d, dimStyle: { ...d.dimStyle, precision: p } }))
                          }
                          className={`py-2.5 rounded-xl border font-mono-cad font-semibold cursor-pointer ${
                            activeDoc.dimStyle.precision === p
                              ? 'bg-sky-500/20 border-sky-500 text-sky-300'
                              : 'bg-[#161D2C] border-slate-800 text-slate-300'
                          }`}
                        >
                          .{Array(p).fill('0').join('') || '0'}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="text-slate-400 mb-1.5 font-medium">Canvas Background</div>
                    <div className="grid grid-cols-3 gap-1.5">
                      {(['black', 'darkblue', 'white'] as CanvasBgTheme[]).map((bg) => (
                        <button
                          key={bg}
                          onClick={() => setBgTheme(bg)}
                          className={`py-2.5 rounded-xl border font-medium cursor-pointer ${
                            bgTheme === bg
                              ? 'bg-sky-500/20 border-sky-500 text-sky-300'
                              : 'bg-[#161D2C] border-slate-800 text-slate-300'
                          }`}
                        >
                          {bg === 'darkblue' ? 'Dark Blue' : bg === 'black' ? 'Black' : 'White'}
                        </button>
                      ))}
                    </div>
                  </div>

                  <button
                    onClick={() => setShowGrid((g) => !g)}
                    className={`w-full flex items-center justify-between px-3 py-3 rounded-xl border cursor-pointer ${
                      showGrid
                        ? 'bg-sky-500/15 border-sky-500/50 text-sky-200'
                        : 'bg-[#161D2C] border-slate-800 text-slate-400'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <Grid className="w-4 h-4" />
                      <span>Coordinate Grid</span>
                    </div>
                    <span className="font-semibold">{showGrid ? 'ON' : 'OFF'}</span>
                  </button>
                </div>
              )}

              {/* Tab 4: OSNAP */}
              {settingsTab === 'snap' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-[#161D2C] border border-slate-800">
                    <div className="flex items-center gap-2 font-medium text-slate-200">
                      <Crosshair className="w-4 h-4 text-emerald-400" />
                      <span>Object Snap (OSNAP)</span>
                    </div>
                    <button
                      onClick={() => setOsnap((o) => ({ ...o, enabled: !o.enabled }))}
                      className={`px-3 py-1 rounded-lg font-semibold cursor-pointer ${
                        osnap.enabled ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-800 text-slate-400'
                      }`}
                    >
                      {osnap.enabled ? 'ON' : 'OFF'}
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    {OSNAP_KEYS.map((k) => (
                      <button
                        key={k}
                        onClick={() => setOsnap((o) => ({ ...o, [k]: !o[k] }))}
                        className={`flex items-center justify-between px-3 py-2.5 rounded-xl border cursor-pointer ${
                          osnap[k]
                            ? 'bg-emerald-500/15 border-emerald-500/50 text-emerald-200'
                            : 'bg-[#161D2C] border-slate-800 text-slate-400'
                        }`}
                      >
                        <span>{OSNAP_LABELS[k as OsnapType]}</span>
                        {osnap[k] && <Check className="w-4 h-4" />}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
