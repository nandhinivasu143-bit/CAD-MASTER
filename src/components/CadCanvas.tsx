import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  copyEntities,
  extendLineAtPoint,
  genEntityId,
  mirrorEntities,
  moveEntities,
  offsetEntity,
  rotateEntities,
  trimEntityAtPoint,
} from '../cad/editing';
import {
  angleDeg,
  computePointsPolygonArea,
  computePolygonArea,
  computePolylineLength,
  dist,
  findNearestLineAndPerpendicular,
  getArcSweepCCW,
  getPolylineSegments,
  hitTestEntity,
  isEntityCrossing,
  isEntityEnclosed,
  measureEntity,
} from '../cad/geometry';
import { findBestSnap } from '../cad/osnap';
import { renderCadCanvas, screenToWorld } from '../cad/renderer';
import {
  CadDocument,
  CadEntity,
  CanvasBgTheme,
  DimensionEntity,
  EntityMeasurement,
  OsnapSettings,
  Point2D,
  SnapResult,
  ToolId,
  ViewportState,
} from '../cad/types';
import { formatAngle, formatLength } from '../cad/units';

interface CadCanvasProps {
  doc: CadDocument;
  activeTool: ToolId;
  continuousMeasure: boolean;
  osnap: OsnapSettings;
  showGrid: boolean;
  bgTheme: CanvasBgTheme;
  selectedIds: Set<string>;
  activeMeasurement: EntityMeasurement | null;
  onCanvasReady: (canvas: HTMLCanvasElement | null) => void;
  onCanvasResize?: (width: number, height: number) => void;
  onViewportChange: (vp: ViewportState) => void;
  onCursorMove: (worldPt: Point2D | null) => void;
  onSelectEntities: (ids: Set<string>, measurement: EntityMeasurement | null, segIdx?: number) => void;
  onCommitEntities: (nextEntities: CadEntity[], pushUndo?: boolean) => void;
  onUpdateStatusPrompt: (msg: string) => void;
  onSetTool: (tool: ToolId) => void;
  onFileDrop: (files: FileList) => void;
}

export const CadCanvas: React.FC<CadCanvasProps> = ({
  doc,
  activeTool,
  continuousMeasure,
  osnap,
  showGrid,
  bgTheme,
  selectedIds,
  activeMeasurement,
  onCanvasReady,
  onCanvasResize,
  onViewportChange,
  onCursorMove,
  onSelectEntities,
  onCommitEntities,
  onUpdateStatusPrompt,
  onSetTool,
  onFileDrop,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [canvasSize, setCanvasSize] = useState({ width: 1000, height: 700 });
  const [cursorScreen, setCursorScreen] = useState<Point2D | null>(null);
  const [cursorWorld, setCursorWorld] = useState<Point2D | null>(null);
  const [snap, setSnap] = useState<SnapResult | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [draftPoints, setDraftPoints] = useState<Point2D[]>([]);
  const [selectionBox, setSelectionBox] = useState<{
    start: Point2D;
    end: Point2D;
    isCrossing: boolean;
  } | null>(null);
  const [offsetDistInput, setOffsetDistInput] = useState('50');
  const [offsetPendingEntityId, setOffsetPendingEntityId] = useState<string | null>(null);
  const [rotateAngleInput, setRotateAngleInput] = useState('45');
  const [isDragOver, setIsDragOver] = useState(false);

  // Baseline / Continue dimension memory
  const [lastDimAnchor, setLastDimAnchor] = useState<{
    p1: Point2D;
    p2: Point2D;
    textPoint: Point2D;
    stackCount: number;
  } | null>(null);

  // Pan & touch pinch tracking refs
  const panStateRef = useRef<{
    active: boolean;
    startScreen: Point2D;
    startVp: ViewportState;
    moved: boolean;
  } | null>(null);
  const boxDragRef = useRef<{ active: boolean; startScreen: Point2D } | null>(null);
  const pinchRef = useRef<{
    active: boolean;
    startDist: number;
    startMid: Point2D;
    startVp: ViewportState;
  } | null>(null);
  const spaceDownRef = useRef(false);

  const visibleLayers = React.useMemo(
    () =>
      new Set(
        Object.values(doc.layers)
          .filter((l) => l.visible)
          .map((l) => l.name)
      ),
    [doc.layers]
  );

  // Reset draft state on tool change
  useEffect(() => {
    setDraftPoints([]);
    setOffsetPendingEntityId(null);
    setSelectionBox(null);
  }, [activeTool, doc.id]);

  // Update helpful status prompt based on active tool & draft progress
  useEffect(() => {
    const prompts: Record<ToolId, string> = {
      select: 'Click any object to measure or select · Drag L→R for Window, R→L for Crossing selection',
      pan: 'Drag to pan · Scroll wheel or pinch to zoom',
      measureInstant: 'Click or tap any line, polyline segment, arc, circle, or spline to measure instantly',
      line: draftPoints.length === 0 ? 'LINE: Specify first point' : 'LINE: Specify next point (Esc or Right-Click to finish)',
      polyline: draftPoints.length === 0 ? 'POLYLINE: Specify start point' : 'POLYLINE: Click next vertex · Double-click or Enter to finish',
      circle: draftPoints.length === 0 ? 'CIRCLE: Specify center point' : 'CIRCLE: Specify radius point',
      rectangle: draftPoints.length === 0 ? 'RECTANGLE: Specify first corner' : 'RECTANGLE: Specify opposite corner',
      arc:
        draftPoints.length === 0
          ? 'ARC (3-Point): Specify start point'
          : draftPoints.length === 1
            ? 'ARC: Specify second point on arc'
            : 'ARC: Specify end point',
      move:
        selectedIds.size === 0
          ? 'MOVE: Click object(s) to move first'
          : draftPoints.length === 0
            ? 'MOVE: Specify base point'
            : 'MOVE: Specify destination point',
      copy:
        selectedIds.size === 0
          ? 'COPY: Click object(s) to copy first'
          : draftPoints.length === 0
            ? 'COPY: Specify base point'
            : 'COPY: Specify destination point',
      rotate:
        selectedIds.size === 0
          ? 'ROTATE: Click object(s) to rotate first'
          : 'ROTATE: Click rotation pivot point (uses angle input at top)',
      mirror:
        selectedIds.size === 0
          ? 'MIRROR: Click object(s) to mirror first'
          : draftPoints.length === 0
            ? 'MIRROR: Specify first point of mirror axis'
            : 'MIRROR: Specify second point of mirror axis',
      offset: offsetPendingEntityId
        ? 'OFFSET: Click on side to place offset copy'
        : 'OFFSET: Enter distance above, then click line, polyline, arc, or circle',
      trim: 'TRIM: Click segment to trim at nearest intersections',
      extend: 'EXTEND: Click near line endpoint to extend to nearest boundary',
      delete: 'DELETE: Click entity to delete',
      dim_pointToPoint:
        draftPoints.length === 0
          ? `POINT MEASURE${continuousMeasure ? ' (Continuous)' : ''}: Click first point`
          : 'POINT MEASURE: Click second point',
      dim_linear:
        draftPoints.length === 0
          ? 'LINEAR DIM: Click first extension origin'
          : draftPoints.length === 1
            ? 'LINEAR DIM: Click second extension origin'
            : 'LINEAR DIM: Click dimension line position',
      dim_aligned:
        draftPoints.length === 0
          ? 'ALIGNED DIM: Click first point'
          : draftPoints.length === 1
            ? 'ALIGNED DIM: Click second point'
            : 'ALIGNED DIM: Click offset position',
      dim_horizontal:
        draftPoints.length === 0
          ? 'HORIZONTAL DIM: Click first point'
          : draftPoints.length === 1
            ? 'HORIZONTAL DIM: Click second point'
            : 'HORIZONTAL DIM: Click dimension line height',
      dim_vertical:
        draftPoints.length === 0
          ? 'VERTICAL DIM: Click first point'
          : draftPoints.length === 1
            ? 'VERTICAL DIM: Click second point'
            : 'VERTICAL DIM: Click dimension line offset',
      dim_angular:
        draftPoints.length === 0
          ? 'ANGULAR DIM: Click vertex point'
          : draftPoints.length === 1
            ? 'ANGULAR DIM: Click point on first ray'
            : 'ANGULAR DIM: Click point on second ray',
      dim_radius: 'RADIUS DIM: Click any circle or arc',
      dim_diameter: 'DIAMETER DIM: Click any circle or arc',
      dim_arcLength: 'ARC LENGTH DIM: Click any arc',
      dim_baseline: lastDimAnchor
        ? 'BASELINE DIM: Click next target point from shared datum (Esc to reset datum)'
        : draftPoints.length === 0
          ? 'BASELINE DIM: Click datum origin point'
          : 'BASELINE DIM: Click first measured point',
      dim_continue: lastDimAnchor
        ? 'CONTINUE DIM: Click next chained point (Esc to reset chain)'
        : draftPoints.length === 0
          ? 'CONTINUE DIM: Click start point'
          : 'CONTINUE DIM: Click second point',
      dim_ordinate:
        draftPoints.length === 0
          ? 'ORDINATE DIM: Click feature point'
          : 'ORDINATE DIM: Move cursor horizontally/vertically and click leader end',
      dim_perpendicular:
        draftPoints.length === 0
          ? 'PERPENDICULAR DIST: Click target point first'
          : 'PERPENDICULAR DIST: Click reference line or segment',
      dim_area:
        draftPoints.length === 0
          ? 'AREA MEASURE: Click closed shape/circle OR click polygon vertices (Double-Click/Enter to finish)'
          : `AREA MEASURE: ${draftPoints.length} vertices · Double-Click or Enter to compute area`,
      dim_perimeter:
        draftPoints.length === 0
          ? 'PERIMETER: Click closed shape OR trace boundary vertices (Double-Click/Enter to finish)'
          : `PERIMETER: ${draftPoints.length} vertices · Double-Click or Enter to finish`,
      dim_chain:
        draftPoints.length === 0
          ? 'CHAIN MEASURE: Click start point'
          : `CHAIN MEASURE: ${draftPoints.length} points · Double-Click or Enter to finish`,
      dim_polylineLength: 'POLYLINE TOTAL: Click any polyline, line, or spline',
    };
    onUpdateStatusPrompt(prompts[activeTool] || '');
  }, [activeTool, draftPoints.length, selectedIds.size, offsetPendingEntityId, lastDimAnchor, continuousMeasure, onUpdateStatusPrompt]);

  // ResizeObserver for crisp HiDPI canvas
  useEffect(() => {
    const el = containerRef.current;
    const canvas = canvasRef.current;
    if (!el || !canvas) return;
    onCanvasReady(canvas);

    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(100, Math.floor(rect.width));
      const h = Math.max(100, Math.floor(rect.height));
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      setCanvasSize({ width: w, height: h });
      onCanvasResize?.(w, h);
    };

    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => {
      ro.disconnect();
      onCanvasReady(null);
    };
  }, [onCanvasReady, onCanvasResize]);

  // Render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let draftKind: any = 'none';
    if (activeTool === 'line') draftKind = 'line';
    else if (activeTool === 'polyline') draftKind = 'polyline';
    else if (activeTool === 'circle') draftKind = 'circle';
    else if (activeTool === 'rectangle') draftKind = 'rectangle';
    else if (activeTool === 'dim_pointToPoint') draftKind = 'measure_p2p';
    else if (activeTool === 'dim_linear') draftKind = 'dim_linear';
    else if (activeTool === 'dim_aligned') draftKind = 'dim_aligned';
    else if (activeTool === 'dim_horizontal') draftKind = 'dim_horizontal';
    else if (activeTool === 'dim_vertical') draftKind = 'dim_vertical';
    else if (activeTool === 'dim_area') draftKind = 'dim_area';
    else if (activeTool === 'dim_perimeter') draftKind = 'dim_perimeter';
    else if (activeTool === 'dim_chain') draftKind = 'dim_chain';
    else if (activeTool === 'move' || activeTool === 'copy') draftKind = 'move_copy';
    else if (activeTool === 'mirror') draftKind = 'mirror';

    renderCadCanvas(ctx, canvasSize.width, canvasSize.height, doc, {
      cursorScreen,
      cursorWorld,
      snap,
      selectedIds,
      hoveredId,
      activePolylineSegment:
        activeMeasurement?.entityType === 'LWPOLYLINE' && activeMeasurement.activeSegmentIndex !== undefined
          ? { entityId: activeMeasurement.entityId, segmentIndex: activeMeasurement.activeSegmentIndex }
          : null,
      selectionBox,
      draftPoints,
      draftKind,
      showGrid,
      bgTheme,
      showCrosshair: activeTool !== 'pan',
    });

    ctx.restore();
  }, [
    doc,
    canvasSize,
    cursorScreen,
    cursorWorld,
    snap,
    selectedIds,
    hoveredId,
    activeMeasurement,
    selectionBox,
    draftPoints,
    activeTool,
    showGrid,
    bgTheme,
  ]);

  const finishMultiPointTool = useCallback(() => {
    if (draftPoints.length < 2) {
      setDraftPoints([]);
      return;
    }
    if (activeTool === 'polyline') {
      const newPoly: CadEntity = {
        id: genEntityId('poly'),
        type: 'LWPOLYLINE',
        layer: '0',
        color: 'BYLAYER',
        closed: false,
        vertices: draftPoints.map((p) => ({ x: p.x, y: p.y, bulge: 0 })),
      };
      onCommitEntities([...doc.entities, newPoly]);
      setDraftPoints([]);
    } else if (activeTool === 'dim_area' && draftPoints.length >= 3) {
      const area = computePointsPolygonArea(draftPoints);
      const cx = draftPoints.reduce((s, p) => s + p.x, 0) / draftPoints.length;
      const cy = draftPoints.reduce((s, p) => s + p.y, 0) / draftPoints.length;
      const dim: DimensionEntity = {
        id: genEntityId('dim'),
        type: 'DIMENSION',
        kind: 'area',
        layer: '0',
        color: doc.dimStyle.color,
        p1: draftPoints[0],
        p2: draftPoints[1],
        textPoint: { x: cx, y: cy },
        points: [...draftPoints],
        value: area,
        style: {},
      };
      onCommitEntities([...doc.entities, dim]);
      setDraftPoints([]);
    } else if (activeTool === 'dim_perimeter' && draftPoints.length >= 2) {
      const perim = computePolylineLength(draftPoints, true);
      const cx = draftPoints.reduce((s, p) => s + p.x, 0) / draftPoints.length;
      const cy = draftPoints.reduce((s, p) => s + p.y, 0) / draftPoints.length;
      const dim: DimensionEntity = {
        id: genEntityId('dim'),
        type: 'DIMENSION',
        kind: 'perimeter',
        layer: '0',
        color: doc.dimStyle.color,
        p1: draftPoints[0],
        p2: draftPoints[1],
        textPoint: { x: cx, y: cy },
        points: [...draftPoints, draftPoints[0]],
        value: perim,
        style: {},
      };
      onCommitEntities([...doc.entities, dim]);
      setDraftPoints([]);
    } else if (activeTool === 'dim_chain' && draftPoints.length >= 2) {
      const total = computePolylineLength(draftPoints, false);
      const dim: DimensionEntity = {
        id: genEntityId('dim'),
        type: 'DIMENSION',
        kind: 'chain',
        layer: '0',
        color: doc.dimStyle.color,
        p1: draftPoints[0],
        p2: draftPoints[draftPoints.length - 1],
        textPoint: draftPoints[Math.floor(draftPoints.length / 2)],
        points: [...draftPoints],
        value: total,
        style: {},
      };
      onCommitEntities([...doc.entities, dim]);
      setDraftPoints([]);
    }
  }, [activeTool, draftPoints, doc.entities, doc.dimStyle.color, onCommitEntities]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.code === 'Space') {
        spaceDownRef.current = true;
      } else if (e.key === 'Escape') {
        setDraftPoints([]);
        setLastDimAnchor(null);
        setOffsetPendingEntityId(null);
        if (activeTool !== 'select') {
          onSetTool('select');
        } else {
          onSelectEntities(new Set(), null);
        }
      } else if (e.key === 'Enter') {
        finishMultiPointTool();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceDownRef.current = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [activeTool, finishMultiPointTool, onSelectEntities, onSetTool]);

  const hitTestTopEntity = useCallback(
    (worldPt: Point2D): { entity: CadEntity; segmentIndex?: number } | null => {
      const pickTol = 16 / Math.max(1e-6, doc.viewport.scale);
      let best: { entity: CadEntity; dist: number; segmentIndex?: number } | null = null;
      // Prefer later (top-rendered) entities on tie
      for (let i = doc.entities.length - 1; i >= 0; i--) {
        const ent = doc.entities[i];
        if (!visibleLayers.has(ent.layer)) continue;
        const res = hitTestEntity(ent, worldPt, pickTol);
        if (res.hit && (!best || res.dist < best.dist - 1e-6)) {
          best = { entity: ent, dist: res.dist, segmentIndex: res.segmentIndex };
        }
      }
      return best ? { entity: best.entity, segmentIndex: best.segmentIndex } : null;
    },
    [doc.entities, doc.viewport.scale, visibleLayers]
  );

  const getLocalScreen = (clientX: number, clientY: number): Point2D => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const handlePointerInteraction = useCallback(
    (screenPt: Point2D, shiftKey: boolean) => {
      const rawWorld = screenToWorld(screenPt, doc.viewport);
      const refPt = draftPoints.length > 0 ? draftPoints[draftPoints.length - 1] : null;
      const snapRes = findBestSnap(rawWorld, doc.entities, visibleLayers, doc.viewport.scale, osnap, refPt);
      const pt = snapRes ? snapRes.point : rawWorld;

      // 1. SELECT or INSTANT MEASURE
      if (activeTool === 'select' || activeTool === 'measureInstant') {
        const hit = hitTestTopEntity(rawWorld);
        if (!hit) {
          if (!shiftKey) onSelectEntities(new Set(), null);
          return;
        }
        const nextIds = new Set(shiftKey ? selectedIds : []);
        if (shiftKey && nextIds.has(hit.entity.id)) {
          nextIds.delete(hit.entity.id);
        } else {
          nextIds.add(hit.entity.id);
        }
        const meas = measureEntity(hit.entity, hit.segmentIndex);
        onSelectEntities(nextIds, meas, hit.segmentIndex);
        return;
      }

      // 2. DELETE
      if (activeTool === 'delete') {
        const hit = hitTestTopEntity(rawWorld);
        if (hit) {
          onCommitEntities(doc.entities.filter((e) => e.id !== hit.entity.id));
          onSelectEntities(new Set(), null);
        }
        return;
      }

      // 3. TRIM & EXTEND
      if (activeTool === 'trim') {
        const hit = hitTestTopEntity(rawWorld);
        if (hit) {
          const updated = trimEntityAtPoint(doc.entities, hit.entity.id, rawWorld, visibleLayers);
          if (updated) onCommitEntities(updated);
        }
        return;
      }
      if (activeTool === 'extend') {
        const hit = hitTestTopEntity(rawWorld);
        if (hit) {
          const updated = extendLineAtPoint(doc.entities, hit.entity.id, rawWorld, visibleLayers);
          if (updated) onCommitEntities(updated);
        }
        return;
      }

      // 4. OFFSET
      if (activeTool === 'offset') {
        if (!offsetPendingEntityId) {
          const hit = hitTestTopEntity(rawWorld);
          if (hit) setOffsetPendingEntityId(hit.entity.id);
        } else {
          const target = doc.entities.find((e) => e.id === offsetPendingEntityId);
          const d = Math.max(0.001, Number(offsetDistInput) || 50);
          if (target) {
            const off = offsetEntity(target, rawWorld, d);
            if (off) onCommitEntities([...doc.entities, off]);
          }
          setOffsetPendingEntityId(null);
        }
        return;
      }

      // 5. MOVE / COPY / ROTATE / MIRROR
      if (activeTool === 'move' || activeTool === 'copy' || activeTool === 'rotate' || activeTool === 'mirror') {
        if (selectedIds.size === 0) {
          const hit = hitTestTopEntity(rawWorld);
          if (hit) onSelectEntities(new Set([hit.entity.id]), null);
          return;
        }
        if (activeTool === 'rotate') {
          const deg = Number(rotateAngleInput) || 0;
          const rad = (deg * Math.PI) / 180;
          onCommitEntities(rotateEntities(doc.entities, selectedIds, pt, rad));
          return;
        }
        if (draftPoints.length === 0) {
          setDraftPoints([pt]);
        } else {
          const base = draftPoints[0];
          if (activeTool === 'move') {
            onCommitEntities(moveEntities(doc.entities, selectedIds, pt.x - base.x, pt.y - base.y));
          } else if (activeTool === 'copy') {
            onCommitEntities(copyEntities(doc.entities, selectedIds, pt.x - base.x, pt.y - base.y));
          } else if (activeTool === 'mirror') {
            onCommitEntities(mirrorEntities(doc.entities, selectedIds, base, pt, true));
          }
          setDraftPoints([]);
        }
        return;
      }

      // 6. DRAWING TOOLS (Line, Polyline, Circle, Rectangle, Arc)
      if (activeTool === 'line') {
        if (draftPoints.length === 0) {
          setDraftPoints([pt]);
        } else {
          const newLine: CadEntity = {
            id: genEntityId('line'),
            type: 'LINE',
            layer: '0',
            color: 'BYLAYER',
            start: draftPoints[0],
            end: pt,
          };
          onCommitEntities([...doc.entities, newLine]);
          setDraftPoints([pt]); // Continuous line chain like AutoCAD
        }
        return;
      }

      if (activeTool === 'polyline') {
        setDraftPoints((prev) => [...prev, pt]);
        return;
      }

      if (activeTool === 'circle') {
        if (draftPoints.length === 0) {
          setDraftPoints([pt]);
        } else {
          const r = dist(draftPoints[0], pt);
          if (r > 1e-6) {
            onCommitEntities([
              ...doc.entities,
              {
                id: genEntityId('cir'),
                type: 'CIRCLE',
                layer: '0',
                color: 'BYLAYER',
                center: draftPoints[0],
                radius: r,
              },
            ]);
          }
          setDraftPoints([]);
        }
        return;
      }

      if (activeTool === 'rectangle') {
        if (draftPoints.length === 0) {
          setDraftPoints([pt]);
        } else {
          const a = draftPoints[0];
          const b = pt;
          onCommitEntities([
            ...doc.entities,
            {
              id: genEntityId('rect'),
              type: 'LWPOLYLINE',
              layer: '0',
              color: 'BYLAYER',
              closed: true,
              vertices: [
                { x: a.x, y: a.y, bulge: 0 },
                { x: b.x, y: a.y, bulge: 0 },
                { x: b.x, y: b.y, bulge: 0 },
                { x: a.x, y: b.y, bulge: 0 },
              ],
            },
          ]);
          setDraftPoints([]);
        }
        return;
      }

      if (activeTool === 'arc') {
        if (draftPoints.length < 2) {
          setDraftPoints((prev) => [...prev, pt]);
        } else {
          // Fit circle through 3 points p1, p2, p3
          const p1 = draftPoints[0];
          const p2 = draftPoints[1];
          const p3 = pt;
          const d = 2 * (p1.x * (p2.y - p3.y) + p2.x * (p3.y - p1.y) + p3.x * (p1.y - p2.y));
          if (Math.abs(d) > 1e-9) {
            const p1Sq = p1.x * p1.x + p1.y * p1.y;
            const p2Sq = p2.x * p2.x + p2.y * p2.y;
            const p3Sq = p3.x * p3.x + p3.y * p3.y;
            const cx = (p1Sq * (p2.y - p3.y) + p2Sq * (p3.y - p1.y) + p3Sq * (p1.y - p2.y)) / d;
            const cy = (p1Sq * (p3.x - p2.x) + p2Sq * (p1.x - p3.x) + p3Sq * (p2.x - p1.x)) / d;
            const center = { x: cx, y: cy };
            const radius = dist(center, p1);
            const a1 = Math.atan2(p1.y - cy, p1.x - cx);
            const a2 = Math.atan2(p2.y - cy, p2.x - cx);
            const a3 = Math.atan2(p3.y - cy, p3.x - cx);
            // Determine CCW order so p2 lies between startAngle and endAngle
            const cross = (p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x);
            const startAngle = cross >= 0 ? a1 : a3;
            const endAngle = cross >= 0 ? a3 : a1;
            void a2;
            onCommitEntities([
              ...doc.entities,
              {
                id: genEntityId('arc'),
                type: 'ARC',
                layer: '0',
                color: 'BYLAYER',
                center,
                radius,
                startAngle,
                endAngle,
              },
            ]);
          }
          setDraftPoints([]);
        }
        return;
      }

      // 7. DIMENSION & MEASUREMENT TOOLS
      const placeDim = (dim: DimensionEntity) => {
        onCommitEntities([...doc.entities, dim]);
        const meas = measureEntity(dim);
        onSelectEntities(new Set([dim.id]), meas);
      };

      if (activeTool === 'dim_pointToPoint') {
        if (draftPoints.length === 0) {
          setDraftPoints([pt]);
        } else {
          const p1 = draftPoints[0];
          const p2 = pt;
          const d = dist(p1, p2);
          const dim: DimensionEntity = {
            id: genEntityId('dim'),
            type: 'DIMENSION',
            kind: 'pointToPoint',
            layer: '0',
            color: '#F59E0B',
            p1,
            p2,
            textPoint: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
            value: d,
            style: {},
          };
          placeDim(dim);
          setDraftPoints(continuousMeasure ? [p2] : []);
        }
        return;
      }

      if (
        activeTool === 'dim_linear' ||
        activeTool === 'dim_aligned' ||
        activeTool === 'dim_horizontal' ||
        activeTool === 'dim_vertical'
      ) {
        if (draftPoints.length < 2) {
          setDraftPoints((prev) => [...prev, pt]);
        } else {
          const p1 = draftPoints[0];
          const p2 = draftPoints[1];
          const tp = pt;
          let kind: DimensionEntity['kind'] = 'aligned';
          let value = dist(p1, p2);

          if (activeTool === 'dim_horizontal') {
            kind = 'horizontal';
            value = Math.abs(p2.x - p1.x);
          } else if (activeTool === 'dim_vertical') {
            kind = 'vertical';
            value = Math.abs(p2.y - p1.y);
          } else if (activeTool === 'dim_linear') {
            const offX = Math.abs(tp.x - (p1.x + p2.x) / 2);
            const offY = Math.abs(tp.y - (p1.y + p2.y) / 2);
            if (offX > offY) {
              kind = 'vertical';
              value = Math.abs(p2.y - p1.y);
            } else {
              kind = 'horizontal';
              value = Math.abs(p2.x - p1.x);
            }
          }

          const dim: DimensionEntity = {
            id: genEntityId('dim'),
            type: 'DIMENSION',
            kind,
            layer: '0',
            color: doc.dimStyle.color,
            p1,
            p2,
            textPoint: tp,
            value,
            style: {},
          };
          placeDim(dim);
          setLastDimAnchor({ p1, p2, textPoint: tp, stackCount: 1 });
          setDraftPoints([]);
        }
        return;
      }

      if (activeTool === 'dim_baseline') {
        if (!lastDimAnchor) {
          if (draftPoints.length === 0) {
            setDraftPoints([pt]);
          } else {
            const p1 = draftPoints[0];
            const p2 = pt;
            const offset = 28 / doc.viewport.scale;
            const tp = { x: (p1.x + p2.x) / 2, y: Math.max(p1.y, p2.y) + offset };
            const dim: DimensionEntity = {
              id: genEntityId('dim'),
              type: 'DIMENSION',
              kind: 'aligned',
              layer: '0',
              color: doc.dimStyle.color,
              p1,
              p2,
              textPoint: tp,
              value: dist(p1, p2),
              style: {},
            };
            placeDim(dim);
            setLastDimAnchor({ p1, p2, textPoint: tp, stackCount: 1 });
            setDraftPoints([]);
          }
        } else {
          const p1 = lastDimAnchor.p1;
          const p2 = pt;
          const stepWorld = (26 * lastDimAnchor.stackCount) / doc.viewport.scale;
          const dx = p2.x - p1.x;
          const dy = p2.y - p1.y;
          const len = Math.hypot(dx, dy) || 1;
          const nx = -dy / len;
          const ny = dx / len;
          const tp = {
            x: (p1.x + p2.x) / 2 + nx * stepWorld,
            y: (p1.y + p2.y) / 2 + ny * stepWorld,
          };
          const dim: DimensionEntity = {
            id: genEntityId('dim'),
            type: 'DIMENSION',
            kind: 'aligned',
            layer: '0',
            color: doc.dimStyle.color,
            p1,
            p2,
            textPoint: tp,
            value: dist(p1, p2),
            style: {},
          };
          placeDim(dim);
          setLastDimAnchor({ ...lastDimAnchor, stackCount: lastDimAnchor.stackCount + 1 });
        }
        return;
      }

      if (activeTool === 'dim_continue') {
        if (!lastDimAnchor) {
          if (draftPoints.length === 0) {
            setDraftPoints([pt]);
          } else {
            const p1 = draftPoints[0];
            const p2 = pt;
            const offset = 28 / doc.viewport.scale;
            const tp = { x: (p1.x + p2.x) / 2, y: Math.max(p1.y, p2.y) + offset };
            const dim: DimensionEntity = {
              id: genEntityId('dim'),
              type: 'DIMENSION',
              kind: 'aligned',
              layer: '0',
              color: doc.dimStyle.color,
              p1,
              p2,
              textPoint: tp,
              value: dist(p1, p2),
              style: {},
            };
            placeDim(dim);
            setLastDimAnchor({ p1, p2, textPoint: tp, stackCount: 1 });
            setDraftPoints([]);
          }
        } else {
          const p1 = lastDimAnchor.p2;
          const p2 = pt;
          const offset = 28 / doc.viewport.scale;
          const tp = { x: (p1.x + p2.x) / 2, y: Math.max(p1.y, p2.y) + offset };
          const dim: DimensionEntity = {
            id: genEntityId('dim'),
            type: 'DIMENSION',
            kind: 'aligned',
            layer: '0',
            color: doc.dimStyle.color,
            p1,
            p2,
            textPoint: tp,
            value: dist(p1, p2),
            style: {},
          };
          placeDim(dim);
          setLastDimAnchor({ p1, p2, textPoint: tp, stackCount: 1 });
        }
        return;
      }

      if (activeTool === 'dim_angular') {
        if (draftPoints.length < 2) {
          setDraftPoints((prev) => [...prev, pt]);
        } else {
          const vertex = draftPoints[0];
          const r1 = draftPoints[1];
          const r2 = pt;
          const a1 = Math.atan2(r1.y - vertex.y, r1.x - vertex.x);
          const a2 = Math.atan2(r2.y - vertex.y, r2.x - vertex.x);
          let diff = Math.abs(((a2 - a1) * 180) / Math.PI);
          if (diff > 180) diff = 360 - diff;
          const midR = Math.max(dist(vertex, r1), dist(vertex, r2)) * 0.6;
          const midA = a1 + (a2 - a1) / 2;
          const dim: DimensionEntity = {
            id: genEntityId('dim'),
            type: 'DIMENSION',
            kind: 'angular',
            layer: '0',
            color: doc.dimStyle.color,
            p1: vertex,
            p2: r1,
            p3: r2,
            textPoint: { x: vertex.x + midR * Math.cos(midA), y: vertex.y + midR * Math.sin(midA) },
            value: diff,
            style: {},
          };
          placeDim(dim);
          setDraftPoints([]);
        }
        return;
      }

      if (activeTool === 'dim_radius' || activeTool === 'dim_diameter' || activeTool === 'dim_arcLength') {
        const hit = hitTestTopEntity(rawWorld);
        if (!hit) return;
        const e = hit.entity;
        if (e.type === 'CIRCLE' || e.type === 'ARC') {
          if (activeTool === 'dim_arcLength' && e.type === 'ARC') {
            const sweep = getArcSweepCCW(e.startAngle, e.endAngle);
            const arcLen = e.radius * sweep;
            const midA = e.startAngle + sweep / 2;
            const rOut = e.radius + 24 / doc.viewport.scale;
            const dim: DimensionEntity = {
              id: genEntityId('dim'),
              type: 'DIMENSION',
              kind: 'arcLength',
              layer: '0',
              color: doc.dimStyle.color,
              p1: { x: e.center.x + e.radius * Math.cos(e.startAngle), y: e.center.y + e.radius * Math.sin(e.startAngle) },
              p2: { x: e.center.x + e.radius * Math.cos(e.endAngle), y: e.center.y + e.radius * Math.sin(e.endAngle) },
              p3: e.center,
              textPoint: { x: e.center.x + rOut * Math.cos(midA), y: e.center.y + rOut * Math.sin(midA) },
              value: arcLen,
              style: {},
            };
            placeDim(dim);
            return;
          }
          const ang = Math.atan2(rawWorld.y - e.center.y, rawWorld.x - e.center.x);
          const edgePt = {
            x: e.center.x + e.radius * Math.cos(ang),
            y: e.center.y + e.radius * Math.sin(ang),
          };
          const oppPt = {
            x: e.center.x - e.radius * Math.cos(ang),
            y: e.center.y - e.radius * Math.sin(ang),
          };
          const isDia = activeTool === 'dim_diameter';
          const outDist = e.radius + 26 / doc.viewport.scale;
          const tp = {
            x: e.center.x + outDist * Math.cos(ang),
            y: e.center.y + outDist * Math.sin(ang),
          };
          const dim: DimensionEntity = {
            id: genEntityId('dim'),
            type: 'DIMENSION',
            kind: isDia ? 'diameter' : 'radius',
            layer: '0',
            color: doc.dimStyle.color,
            p1: isDia ? oppPt : e.center,
            p2: edgePt,
            textPoint: tp,
            value: isDia ? e.radius * 2 : e.radius,
            style: {},
          };
          placeDim(dim);
        }
        return;
      }

      if (activeTool === 'dim_ordinate') {
        if (draftPoints.length === 0) {
          setDraftPoints([pt]);
        } else {
          const p1 = draftPoints[0];
          const dx = Math.abs(pt.x - p1.x);
          const dy = Math.abs(pt.y - p1.y);
          const axis: 'x' | 'y' = dy >= dx ? 'x' : 'y';
          const val = axis === 'x' ? p1.x : p1.y;
          const dim: DimensionEntity = {
            id: genEntityId('dim'),
            type: 'DIMENSION',
            kind: 'ordinate',
            layer: '0',
            color: doc.dimStyle.color,
            p1,
            p2: pt,
            textPoint: pt,
            ordinateAxis: axis,
            value: val,
            style: {},
          };
          placeDim(dim);
          setDraftPoints([]);
        }
        return;
      }

      if (activeTool === 'dim_perpendicular') {
        if (draftPoints.length === 0) {
          setDraftPoints([pt]);
        } else {
          const targetPt = draftPoints[0];
          const tol = 18 / Math.max(1e-6, doc.viewport.scale);
          const res = findNearestLineAndPerpendicular(doc.entities, rawWorld, visibleLayers, tol);
          if (res) {
            const d = dist(targetPt, res.foot);
            const dim: DimensionEntity = {
              id: genEntityId('dim'),
              type: 'DIMENSION',
              kind: 'perpendicular',
              layer: '0',
              color: doc.dimStyle.color,
              p1: targetPt,
              p2: res.foot,
              textPoint: { x: (targetPt.x + res.foot.x) / 2, y: (targetPt.y + res.foot.y) / 2 },
              value: d,
              style: {},
            };
            placeDim(dim);
            setDraftPoints([]);
          }
        }
        return;
      }

      if (activeTool === 'dim_area' || activeTool === 'dim_perimeter') {
        // If no draft points yet and user clicks directly on a closed polyline or circle, measure immediately!
        if (draftPoints.length === 0) {
          const hit = hitTestTopEntity(rawWorld);
          if (hit && hit.entity.type === 'CIRCLE') {
            const c = hit.entity;
            const val = activeTool === 'dim_area' ? Math.PI * c.radius * c.radius : 2 * Math.PI * c.radius;
            const dim: DimensionEntity = {
              id: genEntityId('dim'),
              type: 'DIMENSION',
              kind: activeTool === 'dim_area' ? 'area' : 'perimeter',
              layer: '0',
              color: doc.dimStyle.color,
              p1: c.center,
              p2: { x: c.center.x + c.radius, y: c.center.y },
              textPoint: c.center,
              points: Array.from({ length: 32 }, (_, i) => {
                const a = (i * Math.PI * 2) / 32;
                return { x: c.center.x + c.radius * Math.cos(a), y: c.center.y + c.radius * Math.sin(a) };
              }),
              value: val,
              style: {},
            };
            placeDim(dim);
            return;
          }
          if (hit && hit.entity.type === 'LWPOLYLINE' && hit.entity.closed) {
            const poly = hit.entity;
            const segs = getPolylineSegments(poly);
            const perim = segs.reduce((s, x) => s + x.length, 0);
            const area = computePolygonArea(poly);
            const cx = poly.vertices.reduce((s, v) => s + v.x, 0) / poly.vertices.length;
            const cy = poly.vertices.reduce((s, v) => s + v.y, 0) / poly.vertices.length;
            const dim: DimensionEntity = {
              id: genEntityId('dim'),
              type: 'DIMENSION',
              kind: activeTool === 'dim_area' ? 'area' : 'perimeter',
              layer: '0',
              color: doc.dimStyle.color,
              p1: poly.vertices[0],
              p2: poly.vertices[1],
              textPoint: { x: cx, y: cy },
              points: poly.vertices.map((v) => ({ x: v.x, y: v.y })),
              value: activeTool === 'dim_area' ? area : perim,
              style: {},
            };
            placeDim(dim);
            return;
          }
        }
        setDraftPoints((prev) => [...prev, pt]);
        return;
      }

      if (activeTool === 'dim_chain') {
        setDraftPoints((prev) => [...prev, pt]);
        return;
      }

      if (activeTool === 'dim_polylineLength') {
        const hit = hitTestTopEntity(rawWorld);
        if (!hit) return;
        const meas = measureEntity(hit.entity, hit.segmentIndex);
        if (!meas) return;
        const pts =
          hit.entity.type === 'LWPOLYLINE'
            ? hit.entity.vertices.map((v) => ({ x: v.x, y: v.y }))
            : hit.entity.type === 'LINE'
              ? [hit.entity.start, hit.entity.end]
              : [rawWorld];
        const dim: DimensionEntity = {
          id: genEntityId('dim'),
          type: 'DIMENSION',
          kind: 'polylineLength',
          layer: '0',
          color: doc.dimStyle.color,
          p1: pts[0],
          p2: pts[pts.length - 1],
          textPoint: { x: rawWorld.x, y: rawWorld.y + 20 / doc.viewport.scale },
          points: pts,
          value: meas.primaryValue,
          style: {},
        };
        placeDim(dim);
      }
    },
    [
      doc.viewport,
      doc.entities,
      doc.dimStyle.color,
      draftPoints,
      visibleLayers,
      osnap,
      activeTool,
      selectedIds,
      offsetPendingEntityId,
      offsetDistInput,
      rotateAngleInput,
      continuousMeasure,
      lastDimAnchor,
      hitTestTopEntity,
      onSelectEntities,
      onCommitEntities,
    ]
  );

  // Mouse handlers
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const sc = getLocalScreen(e.clientX, e.clientY);
    if (e.button === 1 || activeTool === 'pan' || spaceDownRef.current) {
      panStateRef.current = {
        active: true,
        startScreen: sc,
        startVp: { ...doc.viewport },
        moved: false,
      };
      return;
    }

    if (e.button === 2) {
      // Right-click finishes multi-point tools or cancels
      if (draftPoints.length > 0) {
        finishMultiPointTool();
        setDraftPoints([]);
      }
      return;
    }

    if (e.button === 0 && activeTool === 'measureInstant') {
      panStateRef.current = {
        active: true,
        startScreen: sc,
        startVp: { ...doc.viewport },
        moved: false,
      };
      return;
    }

    if (e.button === 0 && activeTool === 'select') {
      const hit = hitTestTopEntity(screenToWorld(sc, doc.viewport));
      if (!hit) {
        boxDragRef.current = { active: true, startScreen: sc };
        return;
      }
    }

    if (e.button === 0) {
      handlePointerInteraction(sc, e.shiftKey);
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const sc = getLocalScreen(e.clientX, e.clientY);
    setCursorScreen(sc);
    const w = screenToWorld(sc, doc.viewport);
    setCursorWorld(w);
    onCursorMove(w);

    if (panStateRef.current?.active) {
      const dx = sc.x - panStateRef.current.startScreen.x;
      const dy = sc.y - panStateRef.current.startScreen.y;
      if (Math.hypot(dx, dy) > 4) {
        panStateRef.current.moved = true;
        onViewportChange({
          ...panStateRef.current.startVp,
          offsetX: panStateRef.current.startVp.offsetX + dx,
          offsetY: panStateRef.current.startVp.offsetY + dy,
        });
      }
      return;
    }

    if (boxDragRef.current?.active) {
      const s = boxDragRef.current.startScreen;
      if (Math.hypot(sc.x - s.x, sc.y - s.y) > 5) {
        setSelectionBox({
          start: s,
          end: sc,
          isCrossing: sc.x < s.x,
        });
      }
      return;
    }

    // Update hover & OSNAP
    const refPt = draftPoints.length > 0 ? draftPoints[draftPoints.length - 1] : null;
    const snapRes = findBestSnap(w, doc.entities, visibleLayers, doc.viewport.scale, osnap, refPt);
    setSnap(snapRes);

    const hit = hitTestTopEntity(w);
    setHoveredId(hit ? hit.entity.id : null);
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const sc = getLocalScreen(e.clientX, e.clientY);
    if (panStateRef.current?.active) {
      const wasTap = !panStateRef.current.moved;
      panStateRef.current = null;
      if (wasTap && activeTool === 'measureInstant') {
        handlePointerInteraction(sc, e.shiftKey);
      }
      return;
    }

    if (boxDragRef.current?.active) {
      const s = boxDragRef.current.startScreen;
      boxDragRef.current = null;
      if (Math.hypot(sc.x - s.x, sc.y - s.y) > 6) {
        const w1 = screenToWorld(s, doc.viewport);
        const w2 = screenToWorld(sc, doc.viewport);
        const box = {
          minX: Math.min(w1.x, w2.x),
          minY: Math.min(w1.y, w2.y),
          maxX: Math.max(w1.x, w2.x),
          maxY: Math.max(w1.y, w2.y),
        };
        const isCrossing = sc.x < s.x;
        const nextIds = new Set(e.shiftKey ? selectedIds : []);
        for (const ent of doc.entities) {
          if (!visibleLayers.has(ent.layer)) continue;
          const match = isCrossing ? isEntityCrossing(ent, box) : isEntityEnclosed(ent, box);
          if (match) nextIds.add(ent.id);
        }
        const firstEnt = nextIds.size === 1 ? doc.entities.find((x) => nextIds.has(x.id)) : null;
        onSelectEntities(nextIds, firstEnt ? measureEntity(firstEnt) : null);
      } else {
        handlePointerInteraction(sc, e.shiftKey);
      }
      setSelectionBox(null);
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const sc = getLocalScreen(e.clientX, e.clientY);
    const factor = e.deltaY < 0 ? 1.14 : 1 / 1.14;
    const newScale = Math.max(1e-5, Math.min(50000, doc.viewport.scale * factor));
    const worldBefore = screenToWorld(sc, doc.viewport);
    onViewportChange({
      scale: newScale,
      offsetX: sc.x - worldBefore.x * newScale,
      offsetY: sc.y + worldBefore.y * newScale,
    });
  };

  // Touchscreen single-finger pan/tap & 2-finger pinch zoom
  const handleTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length === 2) {
      const p1 = getLocalScreen(e.touches[0].clientX, e.touches[0].clientY);
      const p2 = getLocalScreen(e.touches[1].clientX, e.touches[1].clientY);
      pinchRef.current = {
        active: true,
        startDist: Math.max(1, dist(p1, p2)),
        startMid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
        startVp: { ...doc.viewport },
      };
      panStateRef.current = null;
    } else if (e.touches.length === 1) {
      const sc = getLocalScreen(e.touches[0].clientX, e.touches[0].clientY);
      panStateRef.current = {
        active: true,
        startScreen: sc,
        startVp: { ...doc.viewport },
        moved: false,
      };
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length === 2 && pinchRef.current?.active) {
      if (e.cancelable) e.preventDefault();
      const p1 = getLocalScreen(e.touches[0].clientX, e.touches[0].clientY);
      const p2 = getLocalScreen(e.touches[1].clientX, e.touches[1].clientY);
      const curDist = Math.max(1, dist(p1, p2));
      const curMid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      const ratio = curDist / pinchRef.current.startDist;
      const startVp = pinchRef.current.startVp;
      const newScale = Math.max(1e-5, Math.min(50000, startVp.scale * ratio));
      const worldMid = screenToWorld(pinchRef.current.startMid, startVp);
      onViewportChange({
        scale: newScale,
        offsetX: curMid.x - worldMid.x * newScale,
        offsetY: curMid.y + worldMid.y * newScale,
      });
    } else if (e.touches.length === 1 && panStateRef.current?.active) {
      const sc = getLocalScreen(e.touches[0].clientX, e.touches[0].clientY);
      const dx = sc.x - panStateRef.current.startScreen.x;
      const dy = sc.y - panStateRef.current.startScreen.y;
      if (Math.hypot(dx, dy) > 8) {
        panStateRef.current.moved = true;
        onViewportChange({
          ...panStateRef.current.startVp,
          offsetX: panStateRef.current.startVp.offsetX + dx,
          offsetY: panStateRef.current.startVp.offsetY + dy,
        });
      }
    }
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (pinchRef.current?.active && e.touches.length < 2) {
      pinchRef.current = null;
      return;
    }
    if (panStateRef.current?.active) {
      const wasTap = !panStateRef.current.moved;
      const tapPt = panStateRef.current.startScreen;
      panStateRef.current = null;
      if (wasTap && activeTool !== 'pan') {
        handlePointerInteraction(tapPt, false);
      }
    }
  };

  // Live Point-to-Point floating telemetry when drawing pointToPoint
  const liveP2P =
    activeTool === 'dim_pointToPoint' && draftPoints.length === 1 && (snap?.point || cursorWorld)
      ? (() => {
          const p1 = draftPoints[0];
          const p2 = snap?.point || cursorWorld!;
          return {
            d: dist(p1, p2),
            dx: Math.abs(p2.x - p1.x),
            dy: Math.abs(p2.y - p1.y),
            ang: angleDeg(p1, p2),
          };
        })()
      : null;

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full flex-1 min-w-0 min-h-0 overflow-hidden"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragOver(false);
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          onFileDrop(e.dataTransfer.files);
        }
      }}
    >
      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => {
          setCursorScreen(null);
          onCursorMove(null);
        }}
        onDoubleClick={finishMultiPointTool}
        onContextMenu={(e) => e.preventDefault()}
        onWheel={handleWheel}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        className={`block w-full h-full touch-none ${
          activeTool === 'pan' ? 'cursor-grab active:cursor-grabbing' : 'cursor-none'
        }`}
      />

      {/* Multi-point Finish pill for Polyline / Area / Perimeter / Chain */}
      {draftPoints.length >= 2 &&
        (activeTool === 'polyline' ||
          activeTool === 'dim_area' ||
          activeTool === 'dim_perimeter' ||
          activeTool === 'dim_chain') && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20">
            <button
              type="button"
              onClick={finishMultiPointTool}
              className="px-4 py-2.5 rounded-full bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold shadow-xl cursor-pointer"
            >
              Finish ({draftPoints.length} pts)
            </button>
          </div>
        )}

      {/* Line chain finish pill on touchscreens */}
      {activeTool === 'line' && draftPoints.length >= 1 && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20">
          <button
            type="button"
            onClick={() => setDraftPoints([])}
            className="px-4 py-2.5 rounded-full bg-slate-800 border border-sky-500/60 text-white text-xs font-semibold shadow-xl cursor-pointer"
          >
            Finish Line
          </button>
        </div>
      )}

      {/* Live Point-to-Point Readout HUD */}
      {liveP2P && (
        <div className="absolute bottom-3 left-3 right-3 sm:right-auto z-20 px-3 py-2 rounded-xl bg-[#111622]/95 border border-amber-500/40 shadow-xl text-xs font-mono-cad flex flex-wrap items-center justify-between sm:justify-start gap-x-4 gap-y-1">
          <div>
            <div className="text-[10px] text-slate-400">Dist</div>
            <div className="text-amber-300 font-semibold">
              {formatLength(liveP2P.d, doc.nativeUnit, doc.dimStyle)}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-slate-400">ΔX</div>
            <div className="text-slate-100">{formatLength(liveP2P.dx, doc.nativeUnit, doc.dimStyle)}</div>
          </div>
          <div>
            <div className="text-[10px] text-slate-400">ΔY</div>
            <div className="text-slate-100">{formatLength(liveP2P.dy, doc.nativeUnit, doc.dimStyle)}</div>
          </div>
          <div>
            <div className="text-[10px] text-slate-400">Angle</div>
            <div className="text-slate-100">{formatAngle(liveP2P.ang, doc.dimStyle.precision)}</div>
          </div>
        </div>
      )}

      {/* Drag & Drop File Overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-30 bg-sky-950/75 backdrop-blur-xs border-2 border-dashed border-sky-400 flex items-center justify-center pointer-events-none">
          <div className="text-center space-y-1">
            <div className="text-base font-semibold text-white">Drop DWG or DXF Drawing(s)</div>
            <div className="text-xs text-sky-200">Supports AutoCAD R13 – 2025 DWG & all ASCII DXF versions</div>
          </div>
        </div>
      )}
    </div>
  );
};
