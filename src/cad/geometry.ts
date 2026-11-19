import {
  ArcEntity,
  CadEntity,
  CircleEntity,
  DimensionEntity,
  EllipseEntity,
  EntityMeasurement,
  LineEntity,
  Point2D,
  PolylineEntity,
  PolylineSegmentInfo,
  SplineEntity,
} from './types';

export const EPS = 1e-9;

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface BulgeArc {
  center: Point2D;
  radius: number;
  startAngle: number;
  endAngle: number;
  ccw: boolean;
  arcLength: number;
  sweepAngle: number;
}

export function dist(a: Point2D, b: Point2D): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function midpoint(a: Point2D, b: Point2D): Point2D {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function angleRad(a: Point2D, b: Point2D): number {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

export function angleDeg(a: Point2D, b: Point2D): number {
  const deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

export function normalizeAngle(rad: number): number {
  const twoPi = Math.PI * 2;
  return ((rad % twoPi) + twoPi) % twoPi;
}

export function isAngleBetweenCCW(angle: number, start: number, end: number): boolean {
  const a = normalizeAngle(angle);
  const s = normalizeAngle(start);
  const e = normalizeAngle(end);
  if (Math.abs(s - e) < 1e-10) return true;
  if (s < e) {
    return a >= s - 1e-7 && a <= e + 1e-7;
  }
  return a >= s - 1e-7 || a <= e + 1e-7;
}

export function getArcSweepCCW(startAngle: number, endAngle: number): number {
  let sweep = normalizeAngle(endAngle) - normalizeAngle(startAngle);
  if (sweep <= 0) sweep += Math.PI * 2;
  return sweep;
}

export function getArcEndpoints(arc: Pick<ArcEntity, 'center' | 'radius' | 'startAngle' | 'endAngle'>): {
  start: Point2D;
  end: Point2D;
  mid: Point2D;
} {
  const start = {
    x: arc.center.x + arc.radius * Math.cos(arc.startAngle),
    y: arc.center.y + arc.radius * Math.sin(arc.startAngle),
  };
  const end = {
    x: arc.center.x + arc.radius * Math.cos(arc.endAngle),
    y: arc.center.y + arc.radius * Math.sin(arc.endAngle),
  };
  const sweep = getArcSweepCCW(arc.startAngle, arc.endAngle);
  const midAngle = arc.startAngle + sweep / 2;
  const mid = {
    x: arc.center.x + arc.radius * Math.cos(midAngle),
    y: arc.center.y + arc.radius * Math.sin(midAngle),
  };
  return { start, end, mid };
}

/**
 * Converts a polyline segment with bulge into exact circular arc geometry.
 * Bulge = tan(includedAngle / 4). Positive = CCW, Negative = CW.
 */
export function bulgeToArc(p1: Point2D, p2: Point2D, bulge: number): BulgeArc | null {
  if (Math.abs(bulge) < 1e-8) return null;
  const chord = dist(p1, p2);
  if (chord < EPS) return null;

  const theta = 4 * Math.atan(Math.abs(bulge));
  const halfTheta = theta / 2;
  const sinHalf = Math.sin(halfTheta);
  if (Math.abs(sinHalf) < EPS) return null;

  const radius = chord / (2 * sinHalf);
  const apothem = radius * Math.cos(halfTheta);
  const mx = (p1.x + p2.x) / 2;
  const my = (p1.y + p2.y) / 2;
  const dx = (p2.x - p1.x) / chord;
  const dy = (p2.y - p1.y) / chord;

  // Normal pointing left of p1->p2
  const nx = -dy;
  const ny = dx;

  // If bulge > 0 (CCW) and theta < pi, center is on left (+n); if theta > pi, center is on right (-n)
  const sign = bulge > 0 ? 1 : -1;
  const orient = theta <= Math.PI ? 1 : -1;
  const offset = sign * orient * apothem;

  const center = {
    x: mx + nx * offset,
    y: my + ny * offset,
  };

  const startAngle = Math.atan2(p1.y - center.y, p1.x - center.x);
  const endAngle = Math.atan2(p2.y - center.y, p2.x - center.x);

  return {
    center,
    radius,
    startAngle,
    endAngle,
    ccw: bulge > 0,
    arcLength: radius * theta,
    sweepAngle: theta,
  };
}

/**
 * Evaluates a B-Spline / NURBS curve into dense CAD world points.
 */
export function evaluateSplinePoints(
  degree: number,
  controlPoints: Point2D[],
  fitPoints: Point2D[],
  knots: number[],
  weights?: number[],
  closed = false,
  samplesPerSpan = 24
): Point2D[] {
  if (controlPoints.length < 2) {
    return fitPoints.length >= 2 ? fitPoints : controlPoints;
  }

  const pts = closed ? [...controlPoints, ...controlPoints.slice(0, degree)] : controlPoints;
  const n = pts.length - 1;
  const p = Math.max(1, Math.min(degree, n));

  // Build uniform clamped knot vector if missing or invalid
  let u = knots;
  const expectedLen = n + p + 2;
  if (!u || u.length !== expectedLen) {
    u = [];
    for (let i = 0; i < expectedLen; i++) {
      if (i <= p) u.push(0);
      else if (i >= expectedLen - p - 1) u.push(n - p + 1);
      else u.push(i - p);
    }
  }

  const tMin = u[p];
  const tMax = u[n + 1];
  if (Math.abs(tMax - tMin) < EPS) {
    return pts;
  }

  const totalSteps = Math.max(24, (pts.length - p) * samplesPerSpan);
  const result: Point2D[] = [];
  const hasWeights = weights && weights.length === controlPoints.length;

  for (let step = 0; step <= totalSteps; step++) {
    const t = step === totalSteps ? tMax - 1e-9 : tMin + ((tMax - tMin) * step) / totalSteps;
    // Find knot span
    let span = p;
    for (let k = p; k <= n; k++) {
      if (t >= u[k] && t <= u[k + 1]) {
        span = k;
        break;
      }
    }

    // De Boor in homogeneous coords if rational
    const d: { x: number; y: number; w: number }[] = [];
    for (let j = 0; j <= p; j++) {
      const idx = Math.min(pts.length - 1, Math.max(0, span - p + j));
      const w = hasWeights ? weights![idx % controlPoints.length] ?? 1 : 1;
      d.push({ x: pts[idx].x * w, y: pts[idx].y * w, w });
    }

    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = span - p + j;
        const denom = u[i + p + 1 - r] - u[i];
        const alpha = Math.abs(denom) < EPS ? 0 : (t - u[i]) / denom;
        d[j] = {
          x: (1 - alpha) * d[j - 1].x + alpha * d[j].x,
          y: (1 - alpha) * d[j - 1].y + alpha * d[j].y,
          w: (1 - alpha) * d[j - 1].w + alpha * d[j].w,
        };
      }
    }

    const wFinal = Math.abs(d[p].w) < EPS ? 1 : d[p].w;
    result.push({ x: d[p].x / wFinal, y: d[p].y / wFinal });
  }

  return result;
}

export function getEllipsePoints(ellipse: EllipseEntity, steps = 64): Point2D[] {
  const pts: Point2D[] = [];
  const majorLen = Math.hypot(ellipse.majorAxis.x, ellipse.majorAxis.y);
  const minorLen = majorLen * ellipse.axisRatio;
  const rot = Math.atan2(ellipse.majorAxis.y, ellipse.majorAxis.x);
  const cosR = Math.cos(rot);
  const sinR = Math.sin(rot);

  let end = ellipse.endAngle;
  if (end <= ellipse.startAngle) end += Math.PI * 2;
  const span = end - ellipse.startAngle;

  for (let i = 0; i <= steps; i++) {
    const t = ellipse.startAngle + (span * i) / steps;
    const lx = majorLen * Math.cos(t);
    const ly = minorLen * Math.sin(t);
    pts.push({
      x: ellipse.center.x + lx * cosR - ly * sinR,
      y: ellipse.center.y + lx * sinR + ly * cosR,
    });
  }
  return pts;
}

export function samplePolylinePoints(poly: PolylineEntity, arcSteps = 20): Point2D[] {
  const verts = poly.vertices;
  if (verts.length === 0) return [];
  if (verts.length === 1) return [{ x: verts[0].x, y: verts[0].y }];

  const out: Point2D[] = [{ x: verts[0].x, y: verts[0].y }];
  const count = poly.closed ? verts.length : verts.length - 1;

  for (let i = 0; i < count; i++) {
    const p1 = verts[i];
    const p2 = verts[(i + 1) % verts.length];
    const bulge = p1.bulge || 0;
    const arc = bulgeToArc(p1, p2, bulge);
    if (arc) {
      const dir = arc.ccw ? 1 : -1;
      for (let s = 1; s <= arcSteps; s++) {
        const a = arc.startAngle + dir * (arc.sweepAngle * s) / arcSteps;
        out.push({
          x: arc.center.x + arc.radius * Math.cos(a),
          y: arc.center.y + arc.radius * Math.sin(a),
        });
      }
    } else {
      out.push({ x: p2.x, y: p2.y });
    }
  }
  return out;
}

export function getPolylineSegments(poly: PolylineEntity): PolylineSegmentInfo[] {
  const verts = poly.vertices;
  if (verts.length < 2) return [];
  const count = poly.closed ? verts.length : verts.length - 1;
  const segs: PolylineSegmentInfo[] = [];

  for (let i = 0; i < count; i++) {
    const p1 = verts[i];
    const p2 = verts[(i + 1) % verts.length];
    const bulge = p1.bulge || 0;
    const arc = bulgeToArc(p1, p2, bulge);
    if (arc) {
      segs.push({
        index: i,
        start: { x: p1.x, y: p1.y },
        end: { x: p2.x, y: p2.y },
        length: arc.arcLength,
        dx: Math.abs(p2.x - p1.x),
        dy: Math.abs(p2.y - p1.y),
        angleDeg: angleDeg(p1, p2),
        isArc: true,
        radius: arc.radius,
      });
    } else {
      segs.push({
        index: i,
        start: { x: p1.x, y: p1.y },
        end: { x: p2.x, y: p2.y },
        length: dist(p1, p2),
        dx: Math.abs(p2.x - p1.x),
        dy: Math.abs(p2.y - p1.y),
        angleDeg: angleDeg(p1, p2),
        isArc: false,
      });
    }
  }
  return segs;
}

export function computePolygonArea(poly: PolylineEntity): number {
  const verts = poly.vertices;
  if (verts.length < 3) return 0;
  let shoelace = 0;
  let circularCorrection = 0;
  const n = verts.length;

  for (let i = 0; i < n; i++) {
    const p1 = verts[i];
    const p2 = verts[(i + 1) % n];
    shoelace += p1.x * p2.y - p2.x * p1.y;
    const bulge = p1.bulge || 0;
    const arc = bulgeToArc(p1, p2, bulge);
    if (arc) {
      // Circular segment area: 0.5 * r^2 * (theta - sin(theta))
      const segArea = 0.5 * arc.radius * arc.radius * (arc.sweepAngle - Math.sin(arc.sweepAngle));
      circularCorrection += bulge > 0 ? segArea : -segArea;
    }
  }

  return Math.abs(shoelace * 0.5 + circularCorrection);
}

export function computePointsPolygonArea(pts: Point2D[]): number {
  if (pts.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

export function computePolylineLength(pts: Point2D[], closed = false): number {
  if (pts.length < 2) return 0;
  let sum = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    sum += dist(pts[i], pts[i + 1]);
  }
  if (closed && pts.length > 2) {
    sum += dist(pts[pts.length - 1], pts[0]);
  }
  return sum;
}

export function getEntityBounds(entity: CadEntity): BBox | null {
  switch (entity.type) {
    case 'LINE':
      return {
        minX: Math.min(entity.start.x, entity.end.x),
        minY: Math.min(entity.start.y, entity.end.y),
        maxX: Math.max(entity.start.x, entity.end.x),
        maxY: Math.max(entity.start.y, entity.end.y),
      };
    case 'LWPOLYLINE': {
      const pts = samplePolylinePoints(entity, 12);
      if (pts.length === 0) return null;
      return pointsToBBox(pts);
    }
    case 'CIRCLE':
      return {
        minX: entity.center.x - entity.radius,
        minY: entity.center.y - entity.radius,
        maxX: entity.center.x + entity.radius,
        maxY: entity.center.y + entity.radius,
      };
    case 'ARC': {
      const pts: Point2D[] = [];
      const sweep = getArcSweepCCW(entity.startAngle, entity.endAngle);
      const steps = 24;
      for (let i = 0; i <= steps; i++) {
        const a = entity.startAngle + (sweep * i) / steps;
        pts.push({
          x: entity.center.x + entity.radius * Math.cos(a),
          y: entity.center.y + entity.radius * Math.sin(a),
        });
      }
      return pointsToBBox(pts);
    }
    case 'ELLIPSE':
      return pointsToBBox(getEllipsePoints(entity, 36));
    case 'SPLINE':
      return entity.sampledPoints.length ? pointsToBBox(entity.sampledPoints) : null;
    case 'TEXT': {
      const approxW = Math.max(entity.height, entity.text.length * entity.height * 0.6);
      return {
        minX: entity.position.x,
        minY: entity.position.y,
        maxX: entity.position.x + approxW,
        maxY: entity.position.y + entity.height,
      };
    }
    case 'POINT':
      return {
        minX: entity.position.x,
        minY: entity.position.y,
        maxX: entity.position.x,
        maxY: entity.position.y,
      };
    case 'DIMENSION': {
      const pts = [entity.p1, entity.p2, entity.textPoint];
      if (entity.p3) pts.push(entity.p3);
      if (entity.points) pts.push(...entity.points);
      return pointsToBBox(pts);
    }
  }
}

export function pointsToBBox(pts: Point2D[]): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function getDocumentBounds(entities: CadEntity[], visibleLayers?: Set<string>): BBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let found = false;

  for (const e of entities) {
    if (visibleLayers && !visibleLayers.has(e.layer)) continue;
    const b = getEntityBounds(e);
    if (!b || !Number.isFinite(b.minX)) continue;
    found = true;
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
  }

  return found ? { minX, minY, maxX, maxY } : null;
}

export function projectPointToSegment(p: Point2D, a: Point2D, b: Point2D): { point: Point2D; t: number; dist: number } {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 < EPS) {
    return { point: { ...a }, t: 0, dist: dist(p, a) };
  }
  let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  const proj = { x: a.x + t * vx, y: a.y + t * vy };
  return { point: proj, t, dist: dist(p, proj) };
}

export function projectPointToInfiniteLine(p: Point2D, a: Point2D, b: Point2D): { point: Point2D; t: number; dist: number } {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 < EPS) {
    return { point: { ...a }, t: 0, dist: dist(p, a) };
  }
  const t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
  const proj = { x: a.x + t * vx, y: a.y + t * vy };
  return { point: proj, t, dist: dist(p, proj) };
}

export function hitTestEntity(
  entity: CadEntity,
  pt: Point2D,
  tolerance: number
): { hit: boolean; dist: number; segmentIndex?: number } {
  // Quick AABB rejection
  const box = getEntityBounds(entity);
  if (box) {
    if (
      pt.x < box.minX - tolerance ||
      pt.x > box.maxX + tolerance ||
      pt.y < box.minY - tolerance ||
      pt.y > box.maxY + tolerance
    ) {
      return { hit: false, dist: Infinity };
    }
  }

  switch (entity.type) {
    case 'LINE': {
      const res = projectPointToSegment(pt, entity.start, entity.end);
      return { hit: res.dist <= tolerance, dist: res.dist };
    }
    case 'LWPOLYLINE': {
      const verts = entity.vertices;
      if (verts.length < 2) return { hit: false, dist: Infinity };
      const count = entity.closed ? verts.length : verts.length - 1;
      let bestDist = Infinity;
      let bestSeg = -1;

      for (let i = 0; i < count; i++) {
        const p1 = verts[i];
        const p2 = verts[(i + 1) % verts.length];
        const bulge = p1.bulge || 0;
        const arc = bulgeToArc(p1, p2, bulge);
        let d = Infinity;
        if (arc) {
          const rDist = Math.abs(dist(pt, arc.center) - arc.radius);
          const ang = Math.atan2(pt.y - arc.center.y, pt.x - arc.center.x);
          const inArc = arc.ccw
            ? isAngleBetweenCCW(ang, arc.startAngle, arc.endAngle)
            : isAngleBetweenCCW(ang, arc.endAngle, arc.startAngle);
          if (inArc) {
            d = rDist;
          } else {
            d = Math.min(dist(pt, p1), dist(pt, p2));
          }
        } else {
          d = projectPointToSegment(pt, p1, p2).dist;
        }
        if (d < bestDist) {
          bestDist = d;
          bestSeg = i;
        }
      }
      return { hit: bestDist <= tolerance, dist: bestDist, segmentIndex: bestSeg };
    }
    case 'CIRCLE': {
      const d = Math.abs(dist(pt, entity.center) - entity.radius);
      return { hit: d <= tolerance, dist: d };
    }
    case 'ARC': {
      const radialDist = Math.abs(dist(pt, entity.center) - entity.radius);
      const a = Math.atan2(pt.y - entity.center.y, pt.x - entity.center.x);
      if (isAngleBetweenCCW(a, entity.startAngle, entity.endAngle)) {
        return { hit: radialDist <= tolerance, dist: radialDist };
      }
      const eps = getArcEndpoints(entity);
      const endDist = Math.min(dist(pt, eps.start), dist(pt, eps.end));
      return { hit: endDist <= tolerance, dist: endDist };
    }
    case 'ELLIPSE': {
      const pts = getEllipsePoints(entity, 48);
      return hitTestPolylinePoints(pts, pt, tolerance, false);
    }
    case 'SPLINE': {
      return hitTestPolylinePoints(entity.sampledPoints, pt, tolerance, entity.closed);
    }
    case 'TEXT': {
      if (!box) return { hit: false, dist: Infinity };
      const inside =
        pt.x >= box.minX - tolerance &&
        pt.x <= box.maxX + tolerance &&
        pt.y >= box.minY - tolerance &&
        pt.y <= box.maxY + tolerance;
      return { hit: inside, dist: inside ? tolerance * 0.5 : Infinity };
    }
    case 'POINT': {
      const d = dist(pt, entity.position);
      return { hit: d <= tolerance * 1.4, dist: d };
    }
    case 'DIMENSION': {
      const d1 = dist(pt, entity.textPoint);
      const d2 = projectPointToSegment(pt, entity.p1, entity.p2).dist;
      const d3 = projectPointToSegment(pt, entity.p1, entity.textPoint).dist;
      const d4 = projectPointToSegment(pt, entity.p2, entity.textPoint).dist;
      const minD = Math.min(d1, d2, d3, d4);
      return { hit: minD <= tolerance * 1.5, dist: minD };
    }
  }
}

function hitTestPolylinePoints(
  pts: Point2D[],
  pt: Point2D,
  tolerance: number,
  closed: boolean
): { hit: boolean; dist: number } {
  if (pts.length < 2) return { hit: false, dist: Infinity };
  let best = Infinity;
  const count = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < count; i++) {
    const d = projectPointToSegment(pt, pts[i], pts[(i + 1) % pts.length]).dist;
    if (d < best) best = d;
  }
  return { hit: best <= tolerance, dist: best };
}

export function isBoxIntersecting(a: BBox, b: BBox): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function isEntityEnclosed(entity: CadEntity, selBox: BBox): boolean {
  const b = getEntityBounds(entity);
  if (!b) return false;
  return b.minX >= selBox.minX && b.maxX <= selBox.maxX && b.minY >= selBox.minY && b.maxY <= selBox.maxY;
}

export function isEntityCrossing(entity: CadEntity, selBox: BBox): boolean {
  const b = getEntityBounds(entity);
  if (!b || !isBoxIntersecting(b, selBox)) return false;
  if (isEntityEnclosed(entity, selBox)) return true;

  // Accurate segment vs rectangle check for lines/polylines
  const corners = [
    { x: selBox.minX, y: selBox.minY },
    { x: selBox.maxX, y: selBox.minY },
    { x: selBox.maxX, y: selBox.maxY },
    { x: selBox.minX, y: selBox.maxY },
  ];
  const rectEdges: [Point2D, Point2D][] = [
    [corners[0], corners[1]],
    [corners[1], corners[2]],
    [corners[2], corners[3]],
    [corners[3], corners[0]],
  ];
  const pointInBox = (p: Point2D) =>
    p.x >= selBox.minX && p.x <= selBox.maxX && p.y >= selBox.minY && p.y <= selBox.maxY;

  if (entity.type === 'LINE') {
    if (pointInBox(entity.start) || pointInBox(entity.end)) return true;
    return rectEdges.some(([ea, eb]) => intersectSegments(entity.start, entity.end, ea, eb) !== null);
  }
  if (entity.type === 'LWPOLYLINE') {
    const pts = samplePolylinePoints(entity, 10);
    for (const p of pts) if (pointInBox(p)) return true;
    const count = entity.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < count; i++) {
      const a = pts[i];
      const bPt = pts[(i + 1) % pts.length];
      if (rectEdges.some(([ea, eb]) => intersectSegments(a, bPt, ea, eb) !== null)) return true;
    }
    return false;
  }
  if (entity.type === 'CIRCLE' || entity.type === 'ARC') {
    // Check closest point on selBox to circle center
    const cx = Math.max(selBox.minX, Math.min(entity.center.x, selBox.maxX));
    const cy = Math.max(selBox.minY, Math.min(entity.center.y, selBox.maxY));
    const dCenter = dist({ x: cx, y: cy }, entity.center);
    // If center is inside and all corners are inside circle, circle doesn't cross edge
    const maxCornerDist = Math.max(...corners.map((c) => dist(c, entity.center)));
    return dCenter <= entity.radius && maxCornerDist >= entity.radius;
  }
  return true;
}

// ==========================================
// EXACT GEOMETRIC INTERSECTIONS
// ==========================================

export function intersectSegments(a1: Point2D, a2: Point2D, b1: Point2D, b2: Point2D): Point2D | null {
  const denom = (a1.x - a2.x) * (b1.y - b2.y) - (a1.y - a2.y) * (b1.x - b2.x);
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((a1.x - b1.x) * (b1.y - b2.y) - (a1.y - b1.y) * (b1.x - b2.x)) / denom;
  const u = -((a1.x - a2.x) * (a1.y - b1.y) - (a1.y - a2.y) * (a1.x - b1.x)) / denom;
  if (t >= -1e-7 && t <= 1 + 1e-7 && u >= -1e-7 && u <= 1 + 1e-7) {
    return {
      x: a1.x + t * (a2.x - a1.x),
      y: a1.y + t * (a2.y - a1.y),
    };
  }
  return null;
}

export function intersectInfiniteLines(a1: Point2D, a2: Point2D, b1: Point2D, b2: Point2D): Point2D | null {
  const denom = (a1.x - a2.x) * (b1.y - b2.y) - (a1.y - a2.y) * (b1.x - b2.x);
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((a1.x - b1.x) * (b1.y - b2.y) - (a1.y - b1.y) * (b1.x - b2.x)) / denom;
  return {
    x: a1.x + t * (a2.x - a1.x),
    y: a1.y + t * (a2.y - a1.y),
  };
}

export function intersectLineCircle(
  a: Point2D,
  b: Point2D,
  center: Point2D,
  radius: number,
  segmentOnly = true
): Point2D[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const fx = a.x - center.x;
  const fy = a.y - center.y;
  const A = dx * dx + dy * dy;
  if (A < EPS) return [];
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - radius * radius;
  const disc = B * B - 4 * A * C;
  if (disc < -1e-9) return [];
  const sqrtD = Math.sqrt(Math.max(0, disc));
  const ts = [(-B - sqrtD) / (2 * A), (-B + sqrtD) / (2 * A)];
  const out: Point2D[] = [];
  for (const t of ts) {
    if (!segmentOnly || (t >= -1e-7 && t <= 1 + 1e-7)) {
      out.push({ x: a.x + t * dx, y: a.y + t * dy });
    }
  }
  return out;
}

export function intersectCircles(c1: Point2D, r1: number, c2: Point2D, r2: number): Point2D[] {
  const d = dist(c1, c2);
  if (d < EPS || d > r1 + r2 + 1e-7 || d < Math.abs(r1 - r2) - 1e-7) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const px = c1.x + (a * (c2.x - c1.x)) / d;
  const py = c1.y + (a * (c2.y - c1.y)) / d;
  if (h < 1e-7) return [{ x: px, y: py }];
  const rx = -(c2.y - c1.y) * (h / d);
  const ry = (c2.x - c1.x) * (h / d);
  return [
    { x: px + rx, y: py + ry },
    { x: px - rx, y: py - ry },
  ];
}

export function getEntityLinearSegments(entity: CadEntity): [Point2D, Point2D][] {
  if (entity.type === 'LINE') {
    return [[entity.start, entity.end]];
  }
  if (entity.type === 'LWPOLYLINE') {
    const out: [Point2D, Point2D][] = [];
    const verts = entity.vertices;
    const count = entity.closed ? verts.length : verts.length - 1;
    for (let i = 0; i < count; i++) {
      const p1 = verts[i];
      const p2 = verts[(i + 1) % verts.length];
      if (!p1.bulge || Math.abs(p1.bulge) < 1e-8) {
        out.push([p1, p2]);
      } else {
        const sampled = samplePolylinePoints({ ...entity, vertices: [p1, p2], closed: false }, 12);
        for (let k = 0; k < sampled.length - 1; k++) {
          out.push([sampled[k], sampled[k + 1]]);
        }
      }
    }
    return out;
  }
  if (entity.type === 'SPLINE' && entity.sampledPoints.length > 1) {
    const out: [Point2D, Point2D][] = [];
    for (let i = 0; i < entity.sampledPoints.length - 1; i++) {
      out.push([entity.sampledPoints[i], entity.sampledPoints[i + 1]]);
    }
    return out;
  }
  return [];
}

export function intersectEntities(e1: CadEntity, e2: CadEntity): Point2D[] {
  const pts: Point2D[] = [];
  const segs1 = getEntityLinearSegments(e1);
  const segs2 = getEntityLinearSegments(e2);

  if (segs1.length && segs2.length) {
    for (const [a1, a2] of segs1) {
      for (const [b1, b2] of segs2) {
        const hit = intersectSegments(a1, a2, b1, b2);
        if (hit) pts.push(hit);
      }
    }
  }

  const checkSegVsArc = (segs: [Point2D, Point2D][], arcOrCircle: CircleEntity | ArcEntity) => {
    for (const [a, b] of segs) {
      const hits = intersectLineCircle(a, b, arcOrCircle.center, arcOrCircle.radius, true);
      for (const h of hits) {
        if (arcOrCircle.type === 'CIRCLE') {
          pts.push(h);
        } else {
          const ang = Math.atan2(h.y - arcOrCircle.center.y, h.x - arcOrCircle.center.x);
          if (isAngleBetweenCCW(ang, arcOrCircle.startAngle, arcOrCircle.endAngle)) {
            pts.push(h);
          }
        }
      }
    }
  };

  if (segs1.length && (e2.type === 'CIRCLE' || e2.type === 'ARC')) {
    checkSegVsArc(segs1, e2);
  }
  if (segs2.length && (e1.type === 'CIRCLE' || e1.type === 'ARC')) {
    checkSegVsArc(segs2, e1);
  }
  if ((e1.type === 'CIRCLE' || e1.type === 'ARC') && (e2.type === 'CIRCLE' || e2.type === 'ARC')) {
    const hits = intersectCircles(e1.center, e1.radius, e2.center, e2.radius);
    for (const h of hits) {
      const ok1 =
        e1.type === 'CIRCLE' ||
        isAngleBetweenCCW(Math.atan2(h.y - e1.center.y, h.x - e1.center.x), e1.startAngle, e1.endAngle);
      const ok2 =
        e2.type === 'CIRCLE' ||
        isAngleBetweenCCW(Math.atan2(h.y - e2.center.y, h.x - e2.center.x), e2.startAngle, e2.endAngle);
      if (ok1 && ok2) pts.push(h);
    }
  }

  return pts;
}

export function tangentPointsToCircle(extPt: Point2D, center: Point2D, radius: number): Point2D[] {
  const d = dist(extPt, center);
  if (d <= radius + 1e-7) return [];
  const baseAngle = Math.atan2(extPt.y - center.y, extPt.x - center.x);
  const alpha = Math.acos(radius / d);
  return [
    {
      x: center.x + radius * Math.cos(baseAngle + alpha),
      y: center.y + radius * Math.sin(baseAngle + alpha),
    },
    {
      x: center.x + radius * Math.cos(baseAngle - alpha),
      y: center.y + radius * Math.sin(baseAngle - alpha),
    },
  ];
}

// ==========================================
// ACCURATE CAD ENTITY MEASUREMENT
// ==========================================

export function measureEntity(entity: CadEntity, activeSegmentIndex?: number): EntityMeasurement | null {
  switch (entity.type) {
    case 'LINE': {
      const len = dist(entity.start, entity.end);
      const dx = Math.abs(entity.end.x - entity.start.x);
      const dy = Math.abs(entity.end.y - entity.start.y);
      const ang = angleDeg(entity.start, entity.end);
      return {
        entityId: entity.id,
        entityType: 'LINE',
        layer: entity.layer,
        primaryLabel: 'Length',
        primaryValue: len,
        start: entity.start,
        end: entity.end,
        dx,
        dy,
        angleDeg: ang,
      };
    }
    case 'LWPOLYLINE': {
      const segments = getPolylineSegments(entity);
      const totalLength = segments.reduce((acc, s) => acc + s.length, 0);
      const area = entity.closed ? computePolygonArea(entity) : undefined;
      const seg =
        activeSegmentIndex !== undefined && activeSegmentIndex >= 0 && activeSegmentIndex < segments.length
          ? segments[activeSegmentIndex]
          : segments[0];
      return {
        entityId: entity.id,
        entityType: 'LWPOLYLINE',
        layer: entity.layer,
        primaryLabel: 'Total Length',
        primaryValue: totalLength,
        start: seg?.start,
        end: seg?.end,
        dx: seg?.dx,
        dy: seg?.dy,
        angleDeg: seg?.angleDeg,
        area,
        segments,
        activeSegmentIndex: seg ? seg.index : undefined,
        closed: entity.closed,
        vertexCount: entity.vertices.length,
      };
    }
    case 'CIRCLE': {
      const circumference = 2 * Math.PI * entity.radius;
      const area = Math.PI * entity.radius * entity.radius;
      return {
        entityId: entity.id,
        entityType: 'CIRCLE',
        layer: entity.layer,
        primaryLabel: 'Circumference',
        primaryValue: circumference,
        center: entity.center,
        radius: entity.radius,
        diameter: entity.radius * 2,
        circumference,
        area,
      };
    }
    case 'ARC': {
      const sweep = getArcSweepCCW(entity.startAngle, entity.endAngle);
      const arcLength = entity.radius * sweep;
      const eps = getArcEndpoints(entity);
      const chordLength = dist(eps.start, eps.end);
      return {
        entityId: entity.id,
        entityType: 'ARC',
        layer: entity.layer,
        primaryLabel: 'Arc Length',
        primaryValue: arcLength,
        start: eps.start,
        end: eps.end,
        center: entity.center,
        radius: entity.radius,
        diameter: entity.radius * 2,
        arcLength,
        chordLength,
        startAngleDeg: ((entity.startAngle * 180) / Math.PI + 360) % 360,
        endAngleDeg: ((entity.endAngle * 180) / Math.PI + 360) % 360,
        sweepAngleDeg: (sweep * 180) / Math.PI,
      };
    }
    case 'ELLIPSE': {
      const pts = getEllipsePoints(entity, 96);
      const len = computePolylineLength(pts, false);
      const majorR = Math.hypot(entity.majorAxis.x, entity.majorAxis.y);
      const minorR = majorR * entity.axisRatio;
      const fullEllipse = Math.abs(entity.endAngle - entity.startAngle) >= Math.PI * 2 - 1e-4;
      return {
        entityId: entity.id,
        entityType: 'ELLIPSE',
        layer: entity.layer,
        primaryLabel: fullEllipse ? 'Perimeter' : 'Arc Length',
        primaryValue: len,
        center: entity.center,
        radius: majorR,
        area: fullEllipse ? Math.PI * majorR * minorR : undefined,
      };
    }
    case 'SPLINE': {
      const len = computePolylineLength(entity.sampledPoints, entity.closed);
      return {
        entityId: entity.id,
        entityType: 'SPLINE',
        layer: entity.layer,
        primaryLabel: 'Curve Length',
        primaryValue: len,
        start: entity.sampledPoints[0],
        end: entity.sampledPoints[entity.sampledPoints.length - 1],
        closed: entity.closed,
        vertexCount: entity.controlPoints.length,
      };
    }
    case 'DIMENSION': {
      return {
        entityId: entity.id,
        entityType: 'DIMENSION',
        layer: entity.layer,
        primaryLabel: entity.kind === 'area' ? 'Area' : entity.kind === 'angular' ? 'Angle' : 'Dimension',
        primaryValue: entity.value,
        isArea: entity.kind === 'area',
        isAngle: entity.kind === 'angular',
        start: entity.p1,
        end: entity.p2,
        dx: Math.abs(entity.p2.x - entity.p1.x),
        dy: Math.abs(entity.p2.y - entity.p1.y),
        angleDeg: angleDeg(entity.p1, entity.p2),
      };
    }
    default:
      return null;
  }
}

/**
 * Computes exact perpendicular foot from `pt` to the nearest line/segment among entities.
 */
export function findNearestLineAndPerpendicular(
  entities: CadEntity[],
  pt: Point2D,
  visibleLayers: Set<string>,
  tolerance: number
): { entity: CadEntity; foot: Point2D; dist: number; segA: Point2D; segB: Point2D } | null {
  let best: { entity: CadEntity; foot: Point2D; dist: number; segA: Point2D; segB: Point2D } | null = null;
  for (const e of entities) {
    if (!visibleLayers.has(e.layer)) continue;
    const segs = getEntityLinearSegments(e);
    for (const [a, b] of segs) {
      const segHit = projectPointToSegment(pt, a, b);
      if (segHit.dist <= tolerance && (!best || segHit.dist < best.dist)) {
        const inf = projectPointToInfiniteLine(pt, a, b);
        best = { entity: e, foot: inf.point, dist: segHit.dist, segA: a, segB: b };
      }
    }
  }
  return best;
}

/**
 * Translate, rotate, mirror, or offset entities accurately in CAD coordinates.
 */
export function transformEntity(entity: CadEntity, fn: (p: Point2D) => Point2D, extra?: { scale?: number; rotDelta?: number }): CadEntity {
  switch (entity.type) {
    case 'LINE':
      return { ...entity, start: fn(entity.start), end: fn(entity.end) };
    case 'LWPOLYLINE':
      return {
        ...entity,
        vertices: entity.vertices.map((v) => {
          const np = fn(v);
          return { ...v, x: np.x, y: np.y };
        }),
      };
    case 'CIRCLE':
      return { ...entity, center: fn(entity.center) };
    case 'ARC': {
      const dRot = extra?.rotDelta ?? 0;
      return {
        ...entity,
        center: fn(entity.center),
        startAngle: entity.startAngle + dRot,
        endAngle: entity.endAngle + dRot,
      };
    }
    case 'ELLIPSE':
      return { ...entity, center: fn(entity.center) };
    case 'SPLINE': {
      const cp = entity.controlPoints.map(fn);
      const fp = entity.fitPoints.map(fn);
      const sp = entity.sampledPoints.map(fn);
      return { ...entity, controlPoints: cp, fitPoints: fp, sampledPoints: sp };
    }
    case 'TEXT':
      return { ...entity, position: fn(entity.position), rotation: entity.rotation + (extra?.rotDelta ?? 0) };
    case 'POINT':
      return { ...entity, position: fn(entity.position) };
    case 'DIMENSION':
      return {
        ...entity,
        p1: fn(entity.p1),
        p2: fn(entity.p2),
        p3: entity.p3 ? fn(entity.p3) : undefined,
        textPoint: fn(entity.textPoint),
        points: entity.points ? entity.points.map(fn) : undefined,
      };
  }
}

export function mirrorPoint(p: Point2D, a: Point2D, b: Point2D): Point2D {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < EPS) return { ...p };
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return { x: 2 * projX - p.x, y: 2 * projY - p.y };
}

export function rotatePoint(p: Point2D, center: Point2D, rad: number): Point2D {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  return {
    x: center.x + dx * c - dy * s,
    y: center.y + dx * s + dy * c,
  };
}
