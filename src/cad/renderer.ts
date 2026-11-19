import { resolveEntityDisplayColor } from './aciColors';
import {
  bulgeToArc,
  dist,
  getArcEndpoints,
  getArcSweepCCW,
  getEllipsePoints,
  getEntityBounds,
  isBoxIntersecting,
} from './geometry';
import { OSNAP_LABELS } from './osnap';
import {
  CadDocument,
  CadEntity,
  CanvasBgTheme,
  DimensionEntity,
  DimensionStyleConfig,
  Point2D,
  SnapResult,
  ViewportState,
} from './types';
import { formatAngle, formatArea, formatLength } from './units';

export interface RenderTransientState {
  cursorScreen: Point2D | null;
  cursorWorld: Point2D | null;
  snap: SnapResult | null;
  selectedIds: Set<string>;
  hoveredId: string | null;
  activePolylineSegment?: { entityId: string; segmentIndex: number } | null;
  selectionBox?: { start: Point2D; end: Point2D; isCrossing: boolean } | null;
  draftPoints: Point2D[];
  draftKind:
    | 'none'
    | 'line'
    | 'polyline'
    | 'circle'
    | 'rectangle'
    | 'arc'
    | 'measure_p2p'
    | 'dim_linear'
    | 'dim_aligned'
    | 'dim_horizontal'
    | 'dim_vertical'
    | 'dim_angular'
    | 'dim_area'
    | 'dim_perimeter'
    | 'dim_chain'
    | 'move_copy'
    | 'rotate'
    | 'mirror';
  previewFoot?: Point2D | null;
  showGrid: boolean;
  bgTheme: CanvasBgTheme;
  showCrosshair: boolean;
}

export function worldToScreen(pt: Point2D, vp: ViewportState): Point2D {
  return {
    x: pt.x * vp.scale + vp.offsetX,
    y: -pt.y * vp.scale + vp.offsetY,
  };
}

export function screenToWorld(pt: Point2D, vp: ViewportState): Point2D {
  return {
    x: (pt.x - vp.offsetX) / vp.scale,
    y: -(pt.y - vp.offsetY) / vp.scale,
  };
}

export function getBgColors(theme: CanvasBgTheme) {
  switch (theme) {
    case 'white':
      return {
        bg: '#FFFFFF',
        minorGrid: 'rgba(15, 23, 42, 0.055)',
        majorGrid: 'rgba(15, 23, 42, 0.13)',
        axisText: '#64748B',
        crosshair: 'rgba(15, 23, 42, 0.45)',
        dimBg: 'rgba(255, 255, 255, 0.92)',
      };
    case 'darkblue':
      return {
        bg: '#0A192F',
        minorGrid: 'rgba(148, 163, 184, 0.08)',
        majorGrid: 'rgba(56, 189, 248, 0.16)',
        axisText: '#94A3B8',
        crosshair: 'rgba(226, 232, 240, 0.48)',
        dimBg: 'rgba(10, 25, 47, 0.92)',
      };
    case 'black':
    default:
      return {
        bg: '#090B0F',
        minorGrid: 'rgba(255, 255, 255, 0.045)',
        majorGrid: 'rgba(255, 255, 255, 0.11)',
        axisText: '#64748B',
        crosshair: 'rgba(226, 232, 240, 0.48)',
        dimBg: 'rgba(9, 11, 15, 0.92)',
      };
  }
}

export function renderCadCanvas(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  doc: CadDocument,
  state: RenderTransientState
) {
  const palette = getBgColors(state.bgTheme);
  const vp = doc.viewport;

  // Background fill
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, width, height);

  // World viewport bounds for culling & adaptive grid
  const topLeft = screenToWorld({ x: 0, y: 0 }, vp);
  const botRight = screenToWorld({ x: width, y: height }, vp);
  const viewBox = {
    minX: Math.min(topLeft.x, botRight.x),
    minY: Math.min(topLeft.y, botRight.y),
    maxX: Math.max(topLeft.x, botRight.x),
    maxY: Math.max(topLeft.y, botRight.y),
  };

  if (state.showGrid) {
    drawAdaptiveGrid(ctx, width, height, vp, viewBox, palette);
  }

  drawOriginAxes(ctx, vp);

  const visibleLayers = new Set(
    Object.values(doc.layers)
      .filter((l) => l.visible)
      .map((l) => l.name)
  );

  // Render non-dimension entities first, then dimensions on top
  const dims: DimensionEntity[] = [];

  for (const entity of doc.entities) {
    if (!visibleLayers.has(entity.layer)) continue;
    const b = getEntityBounds(entity);
    if (b && !isBoxIntersecting(b, viewBox)) continue;

    if (entity.type === 'DIMENSION') {
      dims.push(entity);
      continue;
    }

    const isSelected = state.selectedIds.has(entity.id);
    const isHovered = state.hoveredId === entity.id;
    const layerColor = doc.layers[entity.layer]?.color;
    const strokeColor = resolveEntityDisplayColor(entity.color, layerColor, state.bgTheme);

    drawGeometricEntity(
      ctx,
      entity,
      vp,
      strokeColor,
      isSelected,
      isHovered,
      state.activePolylineSegment?.entityId === entity.id ? state.activePolylineSegment.segmentIndex : undefined
    );
  }

  for (const d of dims) {
    const isSelected = state.selectedIds.has(d.id);
    const isHovered = state.hoveredId === d.id;
    drawDimensionEntity(ctx, d, doc, vp, palette.dimBg, state.bgTheme, isSelected, isHovered);
  }

  // Transient interactive tool previews
  drawTransientPreview(ctx, doc, vp, state, palette.dimBg);

  // Selection box (Window = Blue solid, Crossing = Green dashed)
  if (state.selectionBox) {
    const { start, end, isCrossing } = state.selectionBox;
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const w = Math.abs(end.x - start.x);
    const h = Math.abs(end.y - start.y);
    ctx.save();
    ctx.fillStyle = isCrossing ? 'rgba(34, 197, 94, 0.12)' : 'rgba(56, 189, 248, 0.14)';
    ctx.strokeStyle = isCrossing ? '#22C55E' : '#38BDF8';
    ctx.lineWidth = 1.25;
    if (isCrossing) ctx.setLineDash([5, 4]);
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  // OSNAP indicator
  if (state.snap) {
    drawSnapIndicator(ctx, state.snap, vp);
  }

  // Full-viewport CAD Crosshair + Pickbox
  if (state.showCrosshair && state.cursorScreen) {
    drawCrosshair(ctx, state.cursorScreen, width, height, palette.crosshair);
  }
}

function drawAdaptiveGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  vp: ViewportState,
  viewBox: { minX: number; minY: number; maxX: number; maxY: number },
  palette: ReturnType<typeof getBgColors>
) {
  const targetPx = 42;
  const rawStep = targetPx / Math.max(1e-9, vp.scale);
  const pow10 = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / pow10;
  let minorStep = pow10;
  if (norm >= 5) minorStep = 5 * pow10;
  else if (norm >= 2) minorStep = 2 * pow10;

  const majorStep = minorStep * 5;

  const startX = Math.floor(viewBox.minX / minorStep) * minorStep;
  const endX = Math.ceil(viewBox.maxX / minorStep) * minorStep;
  const startY = Math.floor(viewBox.minY / minorStep) * minorStep;
  const endY = Math.ceil(viewBox.maxY / minorStep) * minorStep;

  // Guard excessive grid line loops
  const maxLines = 220;
  if ((endX - startX) / minorStep > maxLines || (endY - startY) / minorStep > maxLines) return;

  ctx.save();
  ctx.lineWidth = 1;

  // Minor lines
  ctx.strokeStyle = palette.minorGrid;
  ctx.beginPath();
  for (let x = startX; x <= endX + minorStep * 0.01; x += minorStep) {
    const sx = Math.round(x * vp.scale + vp.offsetX) + 0.5;
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, height);
  }
  for (let y = startY; y <= endY + minorStep * 0.01; y += minorStep) {
    const sy = Math.round(-y * vp.scale + vp.offsetY) + 0.5;
    ctx.moveTo(0, sy);
    ctx.lineTo(width, sy);
  }
  ctx.stroke();

  // Major lines
  const majStartX = Math.floor(viewBox.minX / majorStep) * majorStep;
  const majStartY = Math.floor(viewBox.minY / majorStep) * majorStep;
  ctx.strokeStyle = palette.majorGrid;
  ctx.beginPath();
  for (let x = majStartX; x <= endX + majorStep * 0.01; x += majorStep) {
    const sx = Math.round(x * vp.scale + vp.offsetX) + 0.5;
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, height);
  }
  for (let y = majStartY; y <= endY + majorStep * 0.01; y += majorStep) {
    const sy = Math.round(-y * vp.scale + vp.offsetY) + 0.5;
    ctx.moveTo(0, sy);
    ctx.lineTo(width, sy);
  }
  ctx.stroke();
  ctx.restore();
}

function drawOriginAxes(ctx: CanvasRenderingContext2D, vp: ViewportState) {
  const o = worldToScreen({ x: 0, y: 0 }, vp);
  ctx.save();
  ctx.lineWidth = 1.5;

  // X Axis (Red)
  ctx.strokeStyle = 'rgba(239, 68, 68, 0.72)';
  ctx.beginPath();
  ctx.moveTo(o.x, o.y);
  ctx.lineTo(o.x + 36, o.y);
  ctx.stroke();

  // Y Axis (Green)
  ctx.strokeStyle = 'rgba(34, 197, 94, 0.72)';
  ctx.beginPath();
  ctx.moveTo(o.x, o.y);
  ctx.lineTo(o.x, o.y - 36);
  ctx.stroke();

  // Origin square
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.75)';
  ctx.strokeRect(o.x - 3.5, o.y - 3.5, 7, 7);
  ctx.restore();
}

function drawGeometricEntity(
  ctx: CanvasRenderingContext2D,
  entity: CadEntity,
  vp: ViewportState,
  strokeColor: string,
  isSelected: boolean,
  isHovered: boolean,
  activeSegIdx?: number
) {
  ctx.save();
  const baseColor = isSelected ? '#38BDF8' : strokeColor;
  ctx.strokeStyle = baseColor;
  ctx.fillStyle = baseColor;
  ctx.lineWidth = isSelected ? 2.4 : isHovered ? 2.0 : 1.35;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (isSelected) {
    ctx.shadowColor = 'rgba(56, 189, 248, 0.55)';
    ctx.shadowBlur = 6;
  }

  switch (entity.type) {
    case 'LINE': {
      const a = worldToScreen(entity.start, vp);
      const b = worldToScreen(entity.end, vp);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      if (isSelected) {
        drawGrips(ctx, [a, b, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }]);
      }
      break;
    }

    case 'LWPOLYLINE': {
      const verts = entity.vertices;
      if (verts.length < 2) break;
      const count = entity.closed ? verts.length : verts.length - 1;
      ctx.beginPath();
      const first = worldToScreen(verts[0], vp);
      ctx.moveTo(first.x, first.y);

      for (let i = 0; i < count; i++) {
        const p1 = verts[i];
        const p2 = verts[(i + 1) % verts.length];
        const bulge = p1.bulge || 0;
        const arc = bulgeToArc(p1, p2, bulge);
        if (arc) {
          const sc = worldToScreen(arc.center, vp);
          const rPx = arc.radius * vp.scale;
          // Screen Y is inverted, so CAD CCW -> Canvas anticlockwise = true!
          ctx.arc(sc.x, sc.y, rPx, -arc.startAngle, -arc.endAngle, arc.ccw);
        } else {
          const s2 = worldToScreen(p2, vp);
          ctx.lineTo(s2.x, s2.y);
        }
      }
      ctx.stroke();

      // Highlight individual clicked polyline segment in crisp amber!
      if (isSelected && activeSegIdx !== undefined && activeSegIdx >= 0 && activeSegIdx < count) {
        const p1 = verts[activeSegIdx];
        const p2 = verts[(activeSegIdx + 1) % verts.length];
        ctx.save();
        ctx.strokeStyle = '#F59E0B';
        ctx.lineWidth = 3.6;
        ctx.shadowColor = 'rgba(245, 158, 11, 0.65)';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        const arc = p1.bulge ? bulgeToArc(p1, p2, p1.bulge) : null;
        if (arc) {
          const sc = worldToScreen(arc.center, vp);
          ctx.arc(sc.x, sc.y, arc.radius * vp.scale, -arc.startAngle, -arc.endAngle, arc.ccw);
        } else {
          const s1 = worldToScreen(p1, vp);
          const s2 = worldToScreen(p2, vp);
          ctx.moveTo(s1.x, s1.y);
          ctx.lineTo(s2.x, s2.y);
        }
        ctx.stroke();
        ctx.restore();
      }

      if (isSelected) {
        drawGrips(
          ctx,
          verts.map((v) => worldToScreen(v, vp))
        );
      }
      break;
    }

    case 'CIRCLE': {
      const sc = worldToScreen(entity.center, vp);
      const rPx = entity.radius * vp.scale;
      ctx.beginPath();
      ctx.arc(sc.x, sc.y, rPx, 0, Math.PI * 2);
      ctx.stroke();
      if (isSelected) {
        drawGrips(ctx, [
          sc,
          { x: sc.x + rPx, y: sc.y },
          { x: sc.x - rPx, y: sc.y },
          { x: sc.x, y: sc.y - rPx },
          { x: sc.x, y: sc.y + rPx },
        ]);
      }
      break;
    }

    case 'ARC': {
      const sc = worldToScreen(entity.center, vp);
      const rPx = entity.radius * vp.scale;
      ctx.beginPath();
      // CAD CCW from startAngle to endAngle -> Canvas Y inverted => anticlockwise = true
      ctx.arc(sc.x, sc.y, rPx, -entity.startAngle, -entity.endAngle, true);
      ctx.stroke();
      if (isSelected) {
        const eps = getArcEndpoints(entity);
        drawGrips(ctx, [sc, worldToScreen(eps.start, vp), worldToScreen(eps.end, vp), worldToScreen(eps.mid, vp)]);
      }
      break;
    }

    case 'ELLIPSE': {
      const pts = getEllipsePoints(entity, 56);
      if (pts.length < 2) break;
      ctx.beginPath();
      const s0 = worldToScreen(pts[0], vp);
      ctx.moveTo(s0.x, s0.y);
      for (let i = 1; i < pts.length; i++) {
        const si = worldToScreen(pts[i], vp);
        ctx.lineTo(si.x, si.y);
      }
      ctx.stroke();
      if (isSelected) {
        drawGrips(ctx, [worldToScreen(entity.center, vp)]);
      }
      break;
    }

    case 'SPLINE': {
      const pts = entity.sampledPoints;
      if (pts.length < 2) break;
      ctx.beginPath();
      const s0 = worldToScreen(pts[0], vp);
      ctx.moveTo(s0.x, s0.y);
      for (let i = 1; i < pts.length; i++) {
        const si = worldToScreen(pts[i], vp);
        ctx.lineTo(si.x, si.y);
      }
      if (entity.closed) ctx.closePath();
      ctx.stroke();
      if (isSelected) {
        drawGrips(
          ctx,
          entity.controlPoints.map((p) => worldToScreen(p, vp))
        );
      }
      break;
    }

    case 'TEXT': {
      const sp = worldToScreen(entity.position, vp);
      const pxH = entity.height * vp.scale;
      if (pxH < 3) break; // Too tiny to read when zoomed way out
      ctx.save();
      ctx.translate(sp.x, sp.y);
      ctx.rotate(-entity.rotation);
      ctx.font = `500 ${Math.min(180, Math.max(8, pxH))}px "Plus Jakarta Sans", sans-serif`;
      ctx.fillStyle = baseColor;
      ctx.textBaseline = 'bottom';
      ctx.fillText(entity.text, 0, 0);
      ctx.restore();
      break;
    }

    case 'POINT': {
      const sp = worldToScreen(entity.position, vp);
      ctx.beginPath();
      ctx.moveTo(sp.x - 4, sp.y);
      ctx.lineTo(sp.x + 4, sp.y);
      ctx.moveTo(sp.x, sp.y - 4);
      ctx.lineTo(sp.x, sp.y + 4);
      ctx.stroke();
      break;
    }
  }

  ctx.restore();
}

function drawGrips(ctx: CanvasRenderingContext2D, points: Point2D[]) {
  ctx.save();
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#0EA5E9';
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 1;
  for (const p of points) {
    ctx.fillRect(p.x - 3.5, p.y - 3.5, 7, 7);
    ctx.strokeRect(p.x - 3.5, p.y - 3.5, 7, 7);
  }
  ctx.restore();
}

function resolveDimStyle(doc: CadDocument, override: Partial<DimensionStyleConfig>): DimensionStyleConfig {
  return { ...doc.dimStyle, ...override };
}

function drawArrowhead(ctx: CanvasRenderingContext2D, tip: Point2D, angleRadScreen: number, sizePx: number, color: string) {
  ctx.save();
  ctx.translate(tip.x, tip.y);
  ctx.rotate(angleRadScreen);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(sizePx, -sizePx * 0.32);
  ctx.lineTo(sizePx, sizePx * 0.32);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawDimLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  pos: Point2D,
  angleRadScreen: number,
  fontSizePx: number,
  color: string,
  bgColor: string,
  textPosition: 'above' | 'centered' | 'outside'
) {
  ctx.save();
  ctx.translate(pos.x, pos.y);
  // Keep text readable (never upside down)
  let rot = angleRadScreen;
  if (rot > Math.PI / 2) rot -= Math.PI;
  if (rot < -Math.PI / 2) rot += Math.PI;
  ctx.rotate(rot);

  ctx.font = `600 ${fontSizePx}px "JetBrains Mono", monospace`;
  const metrics = ctx.measureText(text);
  const padX = 5;
  const padY = 3;
  const boxW = metrics.width + padX * 2;
  const boxH = fontSizePx + padY * 2;
  const yOffset = textPosition === 'above' ? -boxH * 0.65 : textPosition === 'outside' ? -boxH * 1.15 : 0;

  ctx.fillStyle = bgColor;
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.85;
  ctx.beginPath();
  ctx.roundRect(-boxW / 2, yOffset - boxH / 2, boxW, boxH, 3);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, yOffset + 0.5);
  ctx.restore();
}

function drawDimensionEntity(
  ctx: CanvasRenderingContext2D,
  dim: DimensionEntity,
  doc: CadDocument,
  vp: ViewportState,
  dimBg: string,
  bgTheme: CanvasBgTheme,
  isSelected: boolean,
  isHovered: boolean
) {
  const style = resolveDimStyle(doc, dim.style);
  let color = isSelected ? '#F59E0B' : dim.color && dim.color !== 'BYLAYER' ? dim.color : style.color || '#38BDF8';
  if (bgTheme === 'white' && color.toUpperCase() === '#38BDF8') color = '#0284C7';
  if (bgTheme === 'white' && color.toUpperCase() === '#FFFFFF') color = '#0F172A';

  const fontSizePx = style.textSize > 0 ? Math.max(12, Math.min(40, style.textSize * vp.scale)) : 13;
  const arrowPx = style.arrowSize > 0 ? Math.max(7, Math.min(24, style.arrowSize * vp.scale)) : 10;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = isSelected ? 2 : isHovered ? 1.7 : 1.2;

  const s1 = worldToScreen(dim.p1, vp);
  const s2 = worldToScreen(dim.p2, vp);
  const st = worldToScreen(dim.textPoint, vp);

  const label =
    dim.textOverride ||
    (dim.kind === 'area'
      ? `Area: ${formatArea(dim.value, doc.nativeUnit, style)}`
      : dim.kind === 'angular'
        ? formatAngle(dim.value, style.precision)
        : dim.kind === 'radius'
          ? `R ${formatLength(dim.value, doc.nativeUnit, style)}`
          : dim.kind === 'diameter'
            ? `Ø ${formatLength(dim.value, doc.nativeUnit, style)}`
            : dim.kind === 'arcLength'
              ? `⌒ ${formatLength(dim.value, doc.nativeUnit, style)}`
              : dim.kind === 'ordinate'
                ? `${dim.ordinateAxis === 'y' ? 'Y' : 'X'} = ${formatLength(dim.value, doc.nativeUnit, style)}`
                : dim.kind === 'perpendicular'
                  ? `⊥ ${formatLength(dim.value, doc.nativeUnit, style)}`
                  : dim.kind === 'perimeter'
                    ? `Perim: ${formatLength(dim.value, doc.nativeUnit, style)}`
                    : dim.kind === 'polylineLength'
                      ? `Total L: ${formatLength(dim.value, doc.nativeUnit, style)}`
                      : formatLength(dim.value, doc.nativeUnit, style));

  if (dim.kind === 'area' || dim.kind === 'perimeter') {
    const pts = (dim.points || [dim.p1, dim.p2]).map((p) => worldToScreen(p, vp));
    if (pts.length >= 2) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      if (dim.kind === 'area') {
        ctx.closePath();
        ctx.fillStyle = isSelected ? 'rgba(245, 158, 11, 0.22)' : 'rgba(56, 189, 248, 0.14)';
        ctx.fill();
      }
      ctx.setLineDash([5, 3]);
      ctx.stroke();
      ctx.restore();
    }
    drawDimLabel(ctx, label, st, 0, fontSizePx, color, dimBg, 'centered');
    ctx.restore();
    return;
  }

  if (dim.kind === 'chain' && dim.points && dim.points.length >= 2) {
    const pts = dim.points.map((p) => worldToScreen(p, vp));
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    let running = 0;
    for (let i = 0; i < dim.points.length - 1; i++) {
      const segLen = dist(dim.points[i], dim.points[i + 1]);
      running += segLen;
      const mid = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 };
      const ang = Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x);
      drawArrowhead(ctx, pts[i], ang, arrowPx * 0.85, color);
      drawArrowhead(ctx, pts[i + 1], ang + Math.PI, arrowPx * 0.85, color);
      const segText = `${formatLength(segLen, doc.nativeUnit, style, false)} (Σ ${formatLength(running, doc.nativeUnit, style)})`;
      drawDimLabel(ctx, segText, mid, ang, Math.max(10, fontSizePx - 1), color, dimBg, 'above');
    }
    ctx.restore();
    return;
  }

  if (dim.kind === 'polylineLength') {
    const pts = (dim.points || [dim.p1, dim.p2]).map((p) => worldToScreen(p, vp));
    if (pts.length >= 2) {
      const mid = pts[Math.floor(pts.length / 2)];
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(mid.x, mid.y);
      ctx.lineTo(st.x, st.y);
      ctx.stroke();
      ctx.restore();
    }
    drawDimLabel(ctx, label, st, 0, fontSizePx, color, dimBg, 'centered');
    ctx.restore();
    return;
  }

  if (dim.kind === 'radius' || dim.kind === 'diameter') {
    ctx.beginPath();
    ctx.moveTo(s1.x, s1.y);
    ctx.lineTo(s2.x, s2.y);
    if (dist(s2, st) > 4) {
      ctx.lineTo(st.x, st.y);
    }
    ctx.stroke();
    const ang = Math.atan2(s1.y - s2.y, s1.x - s2.x);
    drawArrowhead(ctx, s2, ang, arrowPx, color);
    if (dim.kind === 'diameter') {
      drawArrowhead(ctx, s1, ang + Math.PI, arrowPx, color);
    } else {
      // Small center cross
      ctx.beginPath();
      ctx.moveTo(s1.x - 4, s1.y);
      ctx.lineTo(s1.x + 4, s1.y);
      ctx.moveTo(s1.x, s1.y - 4);
      ctx.lineTo(s1.x, s1.y + 4);
      ctx.stroke();
    }
    drawDimLabel(ctx, label, st, 0, fontSizePx, color, dimBg, 'centered');
    ctx.restore();
    return;
  }

  if (dim.kind === 'ordinate') {
    const elbow = dim.ordinateAxis === 'y' ? { x: st.x, y: s1.y } : { x: s1.x, y: st.y };
    ctx.beginPath();
    ctx.moveTo(s1.x, s1.y);
    ctx.lineTo(elbow.x, elbow.y);
    ctx.lineTo(st.x, st.y);
    ctx.stroke();
    drawDimLabel(ctx, label, st, 0, fontSizePx, color, dimBg, 'centered');
    ctx.restore();
    return;
  }

  if (dim.kind === 'angular' && dim.p3) {
    // p1 = vertex, p2 = ray1 pt, p3 = ray2 pt, textPoint = arc radius / text location
    const sv = s1;
    const sr1 = s2;
    const sr2 = worldToScreen(dim.p3, vp);
    const rPx = Math.max(24, dist(sv, st));
    const a1 = Math.atan2(sr1.y - sv.y, sr1.x - sv.x);
    const a2 = Math.atan2(sr2.y - sv.y, sr2.x - sv.x);

    // Extension rays
    ctx.save();
    ctx.globalAlpha = 0.65;
    ctx.beginPath();
    ctx.moveTo(sv.x, sv.y);
    ctx.lineTo(sv.x + Math.cos(a1) * (rPx + 8), sv.y + Math.sin(a1) * (rPx + 8));
    ctx.moveTo(sv.x, sv.y);
    ctx.lineTo(sv.x + Math.cos(a2) * (rPx + 8), sv.y + Math.sin(a2) * (rPx + 8));
    ctx.stroke();
    ctx.restore();

    // Shortest sweep in screen coords
    let diff = a2 - a1;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const ccw = diff < 0;
    ctx.beginPath();
    ctx.arc(sv.x, sv.y, rPx, a1, a2, ccw);
    ctx.stroke();

    const dirSign = ccw ? -1 : 1;
    const pArc1 = { x: sv.x + rPx * Math.cos(a1), y: sv.y + rPx * Math.sin(a1) };
    const pArc2 = { x: sv.x + rPx * Math.cos(a2), y: sv.y + rPx * Math.sin(a2) };
    drawArrowhead(ctx, pArc1, a1 + dirSign * (Math.PI / 2), arrowPx, color);
    drawArrowhead(ctx, pArc2, a2 - dirSign * (Math.PI / 2), arrowPx, color);

    const midA = a1 + diff / 2;
    const labelPos = { x: sv.x + rPx * Math.cos(midA), y: sv.y + rPx * Math.sin(midA) };
    drawDimLabel(ctx, label, labelPos, 0, fontSizePx, color, dimBg, 'centered');
    ctx.restore();
    return;
  }

  if (dim.kind === 'arcLength' && dim.p3) {
    // p3 = arc center, p1 = start, p2 = end
    const sc = worldToScreen(dim.p3, vp);
    const dimR = Math.max(20, dist(sc, st));
    const a1 = Math.atan2(s1.y - sc.y, s1.x - sc.x);
    const a2 = Math.atan2(s2.y - sc.y, s2.x - sc.x);

    ctx.save();
    ctx.globalAlpha = 0.65;
    ctx.beginPath();
    ctx.moveTo(s1.x, s1.y);
    ctx.lineTo(sc.x + (dimR + 6) * Math.cos(a1), sc.y + (dimR + 6) * Math.sin(a1));
    ctx.moveTo(s2.x, s2.y);
    ctx.lineTo(sc.x + (dimR + 6) * Math.cos(a2), sc.y + (dimR + 6) * Math.sin(a2));
    ctx.stroke();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(sc.x, sc.y, dimR, a1, a2, true);
    ctx.stroke();
    drawDimLabel(ctx, label, st, 0, fontSizePx, color, dimBg, 'centered');
    ctx.restore();
    return;
  }

  if (dim.kind === 'perpendicular') {
    ctx.beginPath();
    ctx.moveTo(s1.x, s1.y);
    ctx.lineTo(s2.x, s2.y);
    ctx.stroke();
    const ang = Math.atan2(s2.y - s1.y, s2.x - s1.x);
    drawArrowhead(ctx, s1, ang, arrowPx, color);
    drawArrowhead(ctx, s2, ang + Math.PI, arrowPx, color);
    // Right-angle square marker at s2 (foot on reference line)
    const sq = 8;
    const ux = Math.cos(ang);
    const uy = Math.sin(ang);
    const px = -uy;
    const py = ux;
    ctx.beginPath();
    ctx.moveTo(s2.x - ux * sq, s2.y - uy * sq);
    ctx.lineTo(s2.x - ux * sq + px * sq, s2.y - uy * sq + py * sq);
    ctx.lineTo(s2.x + px * sq, s2.y + py * sq);
    ctx.stroke();

    const mid = { x: (s1.x + s2.x) / 2, y: (s1.y + s2.y) / 2 };
    drawDimLabel(ctx, label, mid, ang, fontSizePx, color, dimBg, 'above');
    ctx.restore();
    return;
  }

  // Standard Linear / Aligned / Horizontal / Vertical / Baseline / Continue / PointToPoint
  let dimA: Point2D;
  let dimB: Point2D;
  let extA = s1;
  let extB = s2;

  if (dim.kind === 'horizontal') {
    dimA = { x: s1.x, y: st.y };
    dimB = { x: s2.x, y: st.y };
  } else if (dim.kind === 'vertical') {
    dimA = { x: st.x, y: s1.y };
    dimB = { x: st.x, y: s2.y };
  } else if (dim.kind === 'pointToPoint') {
    dimA = s1;
    dimB = s2;
    // Also draw subtle dashed ΔX / ΔY legs
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.moveTo(s1.x, s1.y);
    ctx.lineTo(s2.x, s1.y);
    ctx.lineTo(s2.x, s2.y);
    ctx.stroke();
    ctx.restore();
  } else {
    // Aligned or rotated linear projected onto line parallel to s1->s2 passing through st
    const dx = s2.x - s1.x;
    const dy = s2.y - s1.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const offset = (st.x - s1.x) * nx + (st.y - s1.y) * ny;
    dimA = { x: s1.x + nx * offset, y: s1.y + ny * offset };
    dimB = { x: s2.x + nx * offset, y: s2.y + ny * offset };
  }

  // Extension lines with small gap from object & slight overshoot beyond dimension line
  const drawExt = (from: Point2D, to: Point2D) => {
    const d = dist(from, to);
    if (d < 3) return;
    const ux = (to.x - from.x) / d;
    const uy = (to.y - from.y) / d;
    const gap = Math.min(4, d * 0.2);
    const over = 5;
    ctx.save();
    ctx.globalAlpha = 0.72;
    ctx.beginPath();
    ctx.moveTo(from.x + ux * gap, from.y + uy * gap);
    ctx.lineTo(to.x + ux * over, to.y + uy * over);
    ctx.stroke();
    ctx.restore();
  };

  if (dim.kind !== 'pointToPoint') {
    drawExt(extA, dimA);
    drawExt(extB, dimB);
  }

  // Dimension line
  ctx.beginPath();
  ctx.moveTo(dimA.x, dimA.y);
  ctx.lineTo(dimB.x, dimB.y);
  ctx.stroke();

  const lineAng = Math.atan2(dimB.y - dimA.y, dimB.x - dimA.x);
  if (dist(dimA, dimB) > arrowPx * 1.5) {
    drawArrowhead(ctx, dimA, lineAng, arrowPx, color);
    drawArrowhead(ctx, dimB, lineAng + Math.PI, arrowPx, color);
  }

  const labelAnchor =
    dim.kind === 'pointToPoint'
      ? { x: (dimA.x + dimB.x) / 2, y: (dimA.y + dimB.y) / 2 }
      : { x: (dimA.x + dimB.x) / 2, y: (dimA.y + dimB.y) / 2 };

  drawDimLabel(ctx, label, labelAnchor, lineAng, fontSizePx, color, dimBg, style.textPosition);
  ctx.restore();
}

function drawTransientPreview(
  ctx: CanvasRenderingContext2D,
  doc: CadDocument,
  vp: ViewportState,
  state: RenderTransientState,
  dimBg: string
) {
  const pts = state.draftPoints;
  const cursor = state.snap?.point || state.cursorWorld;
  if (pts.length === 0 || !cursor) return;

  ctx.save();
  ctx.strokeStyle = '#38BDF8';
  ctx.lineWidth = 1.6;
  ctx.setLineDash([6, 4]);

  const sPts = pts.map((p) => worldToScreen(p, vp));
  const sCur = worldToScreen(cursor, vp);

  if (state.draftKind === 'line' || state.draftKind === 'move_copy' || state.draftKind === 'mirror' || state.draftKind === 'rotate') {
    ctx.beginPath();
    ctx.moveTo(sPts[0].x, sPts[0].y);
    ctx.lineTo(sCur.x, sCur.y);
    ctx.stroke();
    const d = dist(pts[0], cursor);
    drawDimLabel(
      ctx,
      formatLength(d, doc.nativeUnit, doc.dimStyle),
      { x: (sPts[0].x + sCur.x) / 2, y: (sPts[0].y + sCur.y) / 2 },
      0,
      11,
      '#38BDF8',
      dimBg,
      'above'
    );
  } else if (state.draftKind === 'polyline' || state.draftKind === 'dim_area' || state.draftKind === 'dim_perimeter' || state.draftKind === 'dim_chain') {
    ctx.beginPath();
    ctx.moveTo(sPts[0].x, sPts[0].y);
    for (let i = 1; i < sPts.length; i++) ctx.lineTo(sPts[i].x, sPts[i].y);
    ctx.lineTo(sCur.x, sCur.y);
    if (state.draftKind === 'dim_area' && sPts.length >= 2) {
      ctx.closePath();
      ctx.fillStyle = 'rgba(56, 189, 248, 0.12)';
      ctx.fill();
    }
    ctx.stroke();
  } else if (state.draftKind === 'circle') {
    const r = dist(pts[0], cursor);
    const rPx = r * vp.scale;
    ctx.beginPath();
    ctx.arc(sPts[0].x, sPts[0].y, rPx, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(sPts[0].x, sPts[0].y);
    ctx.lineTo(sCur.x, sCur.y);
    ctx.stroke();
    drawDimLabel(
      ctx,
      `R ${formatLength(r, doc.nativeUnit, doc.dimStyle)}`,
      { x: (sPts[0].x + sCur.x) / 2, y: (sPts[0].y + sCur.y) / 2 },
      0,
      11,
      '#38BDF8',
      dimBg,
      'above'
    );
  } else if (state.draftKind === 'rectangle') {
    const x = Math.min(sPts[0].x, sCur.x);
    const y = Math.min(sPts[0].y, sCur.y);
    const w = Math.abs(sCur.x - sPts[0].x);
    const h = Math.abs(sCur.y - sPts[0].y);
    ctx.strokeRect(x, y, w, h);
    const dw = Math.abs(cursor.x - pts[0].x);
    const dh = Math.abs(cursor.y - pts[0].y);
    drawDimLabel(
      ctx,
      `${formatLength(dw, doc.nativeUnit, doc.dimStyle, false)} × ${formatLength(dh, doc.nativeUnit, doc.dimStyle)}`,
      { x: x + w / 2, y: y - 10 },
      0,
      11,
      '#38BDF8',
      dimBg,
      'centered'
    );
  } else if (state.draftKind === 'measure_p2p') {
    const p1 = pts[0];
    const p2 = cursor;
    const d = dist(p1, p2);
    const dx = Math.abs(p2.x - p1.x);
    const dy = Math.abs(p2.y - p1.y);
    const ang = ((Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180) / Math.PI + 360) % 360;

    // Dashed X/Y orthogonal guides
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.7)';
    ctx.beginPath();
    ctx.moveTo(sPts[0].x, sPts[0].y);
    ctx.lineTo(sCur.x, sPts[0].y);
    ctx.lineTo(sCur.x, sCur.y);
    ctx.stroke();

    // Main diagonal line
    ctx.setLineDash([]);
    ctx.strokeStyle = '#F59E0B';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sPts[0].x, sPts[0].y);
    ctx.lineTo(sCur.x, sCur.y);
    ctx.stroke();

    const mid = { x: (sPts[0].x + sCur.x) / 2, y: (sPts[0].y + sCur.y) / 2 };
    const text = `L: ${formatLength(d, doc.nativeUnit, doc.dimStyle)} · ΔX: ${formatLength(dx, doc.nativeUnit, doc.dimStyle, false)} · ΔY: ${formatLength(dy, doc.nativeUnit, doc.dimStyle, false)} · ${formatAngle(ang, 1)}`;
    drawDimLabel(ctx, text, mid, 0, 11, '#FBBF24', dimBg, 'above');
  } else if (
    (state.draftKind === 'dim_linear' ||
      state.draftKind === 'dim_aligned' ||
      state.draftKind === 'dim_horizontal' ||
      state.draftKind === 'dim_vertical') &&
    pts.length >= 1
  ) {
    const p1 = pts[0];
    const p2 = pts[1] || cursor;
    const tp = pts[1] ? cursor : { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    let val = dist(p1, p2);
    let kind: DimensionEntity['kind'] = 'aligned';
    if (state.draftKind === 'dim_horizontal') {
      val = Math.abs(p2.x - p1.x);
      kind = 'horizontal';
    } else if (state.draftKind === 'dim_vertical') {
      val = Math.abs(p2.y - p1.y);
      kind = 'vertical';
    } else if (state.draftKind === 'dim_linear') {
      const dx = Math.abs(p2.x - p1.x);
      const dy = Math.abs(p2.y - p1.y);
      const offX = Math.abs(tp.x - (p1.x + p2.x) / 2);
      const offY = Math.abs(tp.y - (p1.y + p2.y) / 2);
      if (offX > offY) {
        kind = 'vertical';
        val = dy;
      } else {
        kind = 'horizontal';
        val = dx;
      }
    }
    const previewDim: DimensionEntity = {
      id: 'preview',
      type: 'DIMENSION',
      kind,
      layer: '0',
      color: '#38BDF8',
      p1,
      p2,
      textPoint: tp,
      value: val,
      style: {},
    };
    ctx.setLineDash([]);
    drawDimensionEntity(ctx, previewDim, doc, vp, dimBg, state.bgTheme, false, false);
  }

  ctx.restore();
}

function drawSnapIndicator(ctx: CanvasRenderingContext2D, snap: SnapResult, vp: ViewportState) {
  const s = worldToScreen(snap.point, vp);
  const r = 6;
  ctx.save();
  ctx.strokeStyle = '#22C55E';
  ctx.fillStyle = 'rgba(34, 197, 94, 0.2)';
  ctx.lineWidth = 2;

  switch (snap.type) {
    case 'endpoint':
      ctx.strokeRect(s.x - r, s.y - r, r * 2, r * 2);
      break;
    case 'midpoint':
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - r - 1);
      ctx.lineTo(s.x + r + 1, s.y + r);
      ctx.lineTo(s.x - r - 1, s.y + r);
      ctx.closePath();
      ctx.stroke();
      break;
    case 'center':
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case 'intersection':
      ctx.beginPath();
      ctx.moveTo(s.x - r, s.y - r);
      ctx.lineTo(s.x + r, s.y + r);
      ctx.moveTo(s.x + r, s.y - r);
      ctx.lineTo(s.x - r, s.y + r);
      ctx.stroke();
      break;
    case 'quadrant':
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - r - 1);
      ctx.lineTo(s.x + r + 1, s.y);
      ctx.lineTo(s.x, s.y + r + 1);
      ctx.lineTo(s.x - r - 1, s.y);
      ctx.closePath();
      ctx.stroke();
      break;
    case 'perpendicular':
      ctx.beginPath();
      ctx.moveTo(s.x - r, s.y + r);
      ctx.lineTo(s.x + r, s.y + r);
      ctx.moveTo(s.x, s.y + r);
      ctx.lineTo(s.x, s.y - r);
      ctx.strokeRect(s.x, s.y + 1, r - 1, r - 1);
      ctx.stroke();
      break;
    case 'tangent':
      ctx.beginPath();
      ctx.arc(s.x, s.y, r - 1, 0, Math.PI * 2);
      ctx.moveTo(s.x - r - 1, s.y - r);
      ctx.lineTo(s.x + r + 1, s.y - r);
      ctx.stroke();
      break;
    case 'node':
      ctx.beginPath();
      ctx.arc(s.x, s.y, r - 1, 0, Math.PI * 2);
      ctx.moveTo(s.x - r, s.y - r);
      ctx.lineTo(s.x + r, s.y + r);
      ctx.moveTo(s.x + r, s.y - r);
      ctx.lineTo(s.x - r, s.y + r);
      ctx.stroke();
      break;
    case 'nearest':
    default:
      ctx.beginPath();
      ctx.moveTo(s.x - r, s.y - r);
      ctx.lineTo(s.x + r, s.y - r);
      ctx.lineTo(s.x - r, s.y + r);
      ctx.lineTo(s.x + r, s.y + r);
      ctx.closePath();
      ctx.stroke();
      break;
  }

  // Crisp snap label next to marker
  const label = OSNAP_LABELS[snap.type];
  ctx.font = '600 10px "Plus Jakarta Sans", sans-serif';
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
  ctx.fillRect(s.x + 10, s.y - 18, tw + 10, 16);
  ctx.strokeStyle = '#22C55E';
  ctx.lineWidth = 1;
  ctx.strokeRect(s.x + 10, s.y - 18, tw + 10, 16);
  ctx.fillStyle = '#86EFAC';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, s.x + 15, s.y - 10);
  ctx.restore();
}

function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  cursor: Point2D,
  width: number,
  height: number,
  color: string
) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  const pickHalf = 5;

  // Pickbox aperture
  ctx.strokeRect(cursor.x - pickHalf, cursor.y - pickHalf, pickHalf * 2, pickHalf * 2);

  // Full-canvas crosshair lines
  ctx.beginPath();
  ctx.moveTo(0, cursor.y);
  ctx.lineTo(cursor.x - pickHalf, cursor.y);
  ctx.moveTo(cursor.x + pickHalf, cursor.y);
  ctx.lineTo(width, cursor.y);

  ctx.moveTo(cursor.x, 0);
  ctx.lineTo(cursor.x, cursor.y - pickHalf);
  ctx.moveTo(cursor.x, cursor.y + pickHalf);
  ctx.lineTo(cursor.x, height);
  ctx.stroke();
  ctx.restore();
}
