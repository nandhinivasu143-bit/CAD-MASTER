import { createDefaultDimStyle } from './parsers';
import { CadDocument, CanvasBgTheme, DimensionStyleConfig, OsnapSettings } from './types';

const SETTINGS_KEY = 'cad_master_user_settings_v1';
const DB_NAME = 'cad_master_offline_db';
const DB_VERSION = 1;
const STORE_RECENT = 'recent_drawings';
const STORE_SESSION = 'session_state';
const MAX_RECENT = 15;

export interface UserSettings {
  bgTheme: CanvasBgTheme;
  showGrid: boolean;
  osnap: OsnapSettings;
  continuousMeasure: boolean;
  dimStyle: DimensionStyleConfig;
}

export interface RecentDrawingRecord {
  id: string; // key: name + format + acadVersion (or unique key)
  name: string;
  format: CadDocument['format'];
  acadVersion: string;
  nativeUnit: CadDocument['nativeUnit'];
  entityCount: number;
  layerCount: number;
  fileSize?: number;
  lastOpenedAt: number;
  document: Omit<CadDocument, 'undoStack' | 'redoStack'>;
}

export interface SessionSnapshot {
  documents: Omit<CadDocument, 'undoStack' | 'redoStack'>[];
  activeDocId: string;
  savedAt: number;
}

export function getDefaultUserSettings(): UserSettings {
  return {
    bgTheme: 'black',
    showGrid: true,
    osnap: {
      enabled: true,
      endpoint: true,
      midpoint: true,
      center: true,
      intersection: true,
      nearest: true,
      perpendicular: true,
      tangent: true,
      quadrant: true,
      node: true,
    },
    continuousMeasure: true,
    dimStyle: createDefaultDimStyle(),
  };
}

export function loadUserSettings(): UserSettings {
  const defaults = getDefaultUserSettings();
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return {
      bgTheme: parsed.bgTheme || defaults.bgTheme,
      showGrid: typeof parsed.showGrid === 'boolean' ? parsed.showGrid : defaults.showGrid,
      osnap: { ...defaults.osnap, ...(parsed.osnap || {}) },
      continuousMeasure:
        typeof parsed.continuousMeasure === 'boolean' ? parsed.continuousMeasure : defaults.continuousMeasure,
      dimStyle: { ...defaults.dimStyle, ...(parsed.dimStyle || {}) },
    };
  } catch {
    return defaults;
  }
}

export function saveUserSettings(settings: UserSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // ignore quota errors
  }
}

function openOfflineDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_RECENT)) {
        db.createObjectStore(STORE_RECENT, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_SESSION)) {
        db.createObjectStore(STORE_SESSION, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
  });
}

function stripUndoHistory(doc: CadDocument): Omit<CadDocument, 'undoStack' | 'redoStack'> {
  const { undoStack: _u, redoStack: _r, ...rest } = doc;
  return rest;
}

export function restoreDocumentFromSnapshot(snap: Omit<CadDocument, 'undoStack' | 'redoStack'>): CadDocument {
  return {
    ...snap,
    undoStack: [],
    redoStack: [],
  };
}

export async function saveRecentDrawing(doc: CadDocument): Promise<void> {
  if (!doc || doc.entities.length === 0) return;
  try {
    const db = await openOfflineDb();
    const tx = db.transaction(STORE_RECENT, 'readwrite');
    const store = tx.objectStore(STORE_RECENT);

    // Key by filename + format so re-opening the same drawing updates its recent entry cleanly
    const recentKey = `${doc.format}::${doc.name}`;
    const record: RecentDrawingRecord = {
      id: recentKey,
      name: doc.name,
      format: doc.format,
      acadVersion: doc.acadVersion,
      nativeUnit: doc.nativeUnit,
      entityCount: doc.entities.length,
      layerCount: Object.keys(doc.layers).length,
      fileSize: doc.fileSize,
      lastOpenedAt: Date.now(),
      document: stripUndoHistory(doc),
    };
    store.put(record);

    // Prune beyond MAX_RECENT
    const allReq = store.getAll();
    allReq.onsuccess = () => {
      const items = (allReq.result as RecentDrawingRecord[]).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
      for (let i = MAX_RECENT; i < items.length; i++) {
        store.delete(items[i].id);
      }
    };
  } catch {
    // ignore storage failures silently
  }
}

export async function loadRecentDrawings(): Promise<RecentDrawingRecord[]> {
  try {
    const db = await openOfflineDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_RECENT, 'readonly');
      const req = tx.objectStore(STORE_RECENT).getAll();
      req.onsuccess = () => {
        const list = (req.result as RecentDrawingRecord[]) || [];
        resolve(list.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt));
      };
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

export async function deleteRecentDrawing(id: string): Promise<void> {
  try {
    const db = await openOfflineDb();
    const tx = db.transaction(STORE_RECENT, 'readwrite');
    tx.objectStore(STORE_RECENT).delete(id);
  } catch {
    // ignore
  }
}

export async function clearRecentDrawings(): Promise<void> {
  try {
    const db = await openOfflineDb();
    const tx = db.transaction(STORE_RECENT, 'readwrite');
    tx.objectStore(STORE_RECENT).clear();
  } catch {
    // ignore
  }
}

export async function saveSessionSnapshot(documents: CadDocument[], activeDocId: string): Promise<void> {
  try {
    const db = await openOfflineDb();
    const tx = db.transaction(STORE_SESSION, 'readwrite');
    const snapshot: SessionSnapshot & { key: string } = {
      key: 'active_workspace',
      documents: documents.map(stripUndoHistory),
      activeDocId,
      savedAt: Date.now(),
    };
    tx.objectStore(STORE_SESSION).put(snapshot);
  } catch {
    // ignore
  }
}

export async function loadSessionSnapshot(): Promise<SessionSnapshot | null> {
  try {
    const db = await openOfflineDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_SESSION, 'readonly');
      const req = tx.objectStore(STORE_SESSION).get('active_workspace');
      req.onsuccess = () => {
        const res = req.result as (SessionSnapshot & { key: string }) | undefined;
        if (!res || !Array.isArray(res.documents) || res.documents.length === 0) {
          resolve(null);
          return;
        }
        resolve(res);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}
