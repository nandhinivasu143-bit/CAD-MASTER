import {
  dist,
  getArcEndpoints,
  getEntityLinearSegments,
  intersectEntities,
  intersectInfiniteLines,
  intersectLineCircle,
  isAngleBetweenCCW,
  mirrorPoint,
  normalizeAngle,
  projectPointToSegment,
  rotatePoint,
  transformEntity,
} from './geometry';
import { CadEntity, LineEntity, Point2D } from './types';

let idCounter = 1000;
export function genEntityId(prefix = 'ent'): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

export function moveEntities(entities: CadEntity[], ids: Set<string>, dx: number, dy: number): CadEntity[] {
  return entities.map((e) =>
    ids.has(e.id) ? transformEntity(e, (p) => ({ x: p.x + dx, y: p.y + dy })) : e
  );
}

export function copyEntities(entities: CadEntity[], ids: Set<string>, dx: number, dy: number): CadEntity[] {
  const copies: CadEntity[] = [];
  for (const e of entities) {
    if (ids.has(e.id)) {
      const cloned = transformEntity(e, (p) => ({ x: p.x + dx, y: p.y + dy }));
      copies.push({ ...cloned, id: genEntityId('copy') });
    }
  }
  return [...entities, ...copies];
}

export function rotateEntities(
  entities: CadEntity[],
  ids: Set<string>,
  center: Point2D,
  angleRadians: number
): CadEntity[] {
  return entities.map((e) =>
    ids.has(e.id)
      ? transformEntity(e, (p) => rotatePoint(p, center, angleRadians), { rotDelta: angleRadians })
      : e
  );
}

export function mirrorEntities(
  entities: CadEntity[],
  ids: Set<string>,
  axisA: Point2D,
  axisB: Point2D,
  keepOriginal = true
): CadEntity[] {
  const mirrored: CadEntity[] = [];
  for (const e of entities) {
    if (ids.has(e.id)) {
      const m = transformEntity(e, (p) => mirrorPoint(p, axisA, axisB));
      // Mirror arc angles if needed
      if (m.type === 'ARC') {
        const eps = getArcEndpoints(e as any);
        const ms = mirrorPoint(eps.start, axisA, axisB);
        const me = mirrorPoint(eps.end, axisA, axisB);
        const a1 = Math.atan2(ms.y - m.center.y, ms.x - m.center.x);
        const a2 = Math.atan2(me.y - m.center.y, me.x - m.center.x);
        // Orientation reverses under mirror
        m.startAngle = a2;
        m.endAngle = a1;
      }
      mirrored.push(keepOriginal ? { ...m, id: genEntityId('mir') } : m);
    }
  }
  if (keepOriginal) {
    return [...entities, ...mirrored];
  }
  const map = new Map(mirrored.map((m) => [m.id, m]));
  return entities.map((e) => map.get(e.id) || e);
}

export function offsetEntity(entity: CadEntity, sidePt: Point2D, distance: number): CadEntity | null {
  if (distance <= 0) return null;
  if (entity.type === 'LINE') {
    const dx = entity.end.x - entity.start.x;
    const dy = entity.end.y - entity.start.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return null;
    const nx = -dy / len;
    const ny = dx / len;
    const sideDot = (sidePt.x - entity.start.x) * nx + (sidePt.y - entity.start.y) * ny;
    const sign = sideDot >= 0 ? 1 : -1;
    return {
      ...entity,
      id: genEntityId('off'),
      start: { x: entity.start.x + nx * distance * sign, y: entity.start.y + ny * distance * sign },
      end: { x: entity.end.x + nx * distance * sign, y: entity.end.y + ny * distance * sign },
    };
  }
  if (entity.type === 'CIRCLE') {
    const d = dist(sidePt, entity.center);
    const newR = d >= entity.radius ? entity.radius + distance : Math.max(1e-4, entity.radius - distance);
    return { ...entity, id: genEntityId('off'), radius: newR };
  }
  if (entity.type === 'ARC') {
    const d = dist(sidePt, entity.center);
    const newR = d >= entity.radius ? entity.radius + distance : Math.max(1e-4, entity.radius - distance);
    return { ...entity, id: genEntityId('off'), radius: newR };
  }
  if (entity.type === 'LWPOLYLINE' && entity.vertices.length >= 2) {
    // Parallel offset of polygon/polyline edges
    const verts = entity.vertices;
    const count = entity.closed ? verts.length : verts.length - 1;
    // Determine side based on nearest segment normal
    let bestSegIdx = 0;
    let bestD = Infinity;
    for (let i = 0; i < count; i++) {
      const p1 = verts[i];
      const p2 = verts[(i + 1) % verts.length];
      const proj = projectPointToSegment(sidePt, p1, p2);
      if (proj.dist < bestD) {
        bestD = proj.dist;
        bestSegIdx = i;
      }
    }
    const sa = verts[bestSegIdx];
    const sb = verts[(bestSegIdx + 1) % verts.length];
    const sLen = Math.hypot(sb.x - sa.x, sb.y - sa.y) || 1;
    const snx = -(sb.y - sa.y) / sLen;
    const sny = (sb.x - sa.x) / sLen;
    const sign = (sidePt.x - sa.x) * snx + (sidePt.y - sa.y) * sny >= 0 ? 1 : -1;

    const offsetSegs: [Point2D, Point2D][] = [];
    for (let i = 0; i < count; i++) {
      const p1 = verts[i];
      const p2 = verts[(i + 1) % verts.length];
      const len = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
      const nx = (-(p2.y - p1.y) / len) * sign * distance;
      const ny = ((p2.x - p1.x) / len) * sign * distance;
      offsetSegs.push([
        { x: p1.x + nx, y: p1.y + ny },
        { x: p2.x + nx, y: p2.y + ny },
      ]);
    }

    const newVerts: { x: number; y: number }[] = [];
    if (entity.closed) {
      for (let i = 0; i < offsetSegs.length; i++) {
        const prev = offsetSegs[(i - 1 + offsetSegs.length) % offsetSegs.length];
        const curr = offsetSegs[i];
        const inter = intersectInfiniteLines(prev[0], prev[1], curr[0], curr[1]);
        newVerts.push(inter || curr[0]);
      }
    } else {
      newVerts.push(offsetSegs[0][0]);
      for (let i = 1; i < offsetSegs.length; i++) {
        const inter = intersectInfiniteLines(
          offsetSegs[i - 1][0],
          offsetSegs[i - 1][1],
          offsetSegs[i][0],
          offsetSegs[i][1]
        );
        newVerts.push(inter || offsetSegs[i][0]);
      }
      newVerts.push(offsetSegs[offsetSegs.length - 1][1]);
    }

    return {
      ...entity,
      id: genEntityId('off'),
      vertices: newVerts.map((v) => ({ x: v.x, y: v.y, bulge: 0 })),
    };
  }
  return null;
}

/**
 * Trims the clicked entity between its two nearest intersections with other visible entities.
 */
export function trimEntityAtPoint(
  entities: CadEntity[],
  targetId: string,
  clickPt: Point2D,
  visibleLayers: Set<string>
): CadEntity[] | null {
  const target = entities.find((e) => e.id === targetId);
  if (!target) return null;

  const others = entities.filter(
    (e) => e.id !== targetId && e.type !== 'DIMENSION' && visibleLayers.has(e.layer)
  );
  const hits: Point2D[] = [];
  for (const other of others) {
    hits.push(...intersectEntities(target, other));
  }

  if (target.type === 'LINE') {
    if (hits.length === 0) return null;
    const dx = target.end.x - target.start.x;
    const dy = target.end.y - target.start.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) return null;

    const projT = (p: Point2D) => ((p.x - target.start.x) * dx + (p.y - target.start.y) * dy) / len2;
    const clickT = Math.max(0, Math.min(1, projT(clickPt)));

    const tList = Array.from(
      new Set([0, 1, ...hits.map(projT).filter((t) => t > 1e-5 && t < 1 - 1e-5)])
    ).sort((a, b) => a - b);

    if (tList.length <= 2) return null; // No interior intersection

    // Find bracket [tLeft, tRight] containing clickT
    let tLeft = 0;
    let tRight = 1;
    for (let i = 0; i < tList.length - 1; i++) {
      if (clickT >= tList[i] - 1e-6 && clickT <= tList[i + 1] + 1e-6) {
        tLeft = tList[i];
        tRight = tList[i + 1];
        break;
      }
    }

    const ptAt = (t: number): Point2D => ({
      x: target.start.x + t * dx,
      y: target.start.y + t * dy,
    });

    const replacements: LineEntity[] = [];
    if (tLeft > 1e-5) {
      replacements.push({
        ...target,
        id: tRight < 1 - 1e-5 ? genEntityId('trim') : target.id,
        start: target.start,
        end: ptAt(tLeft),
      });
    }
    if (tRight < 1 - 1e-5) {
      replacements.push({
        ...target,
        id: target.id,
        start: ptAt(tRight),
        end: target.end,
      });
    }

    return entities.flatMap((e) => (e.id === targetId ? replacements : [e]));
  }

  if (target.type === 'ARC' && hits.length > 0) {
    const angAt = (p: Point2D) => normalizeAngle(Math.atan2(p.y - target.center.y, p.x - target.center.x));
    const sA = normalizeAngle(target.startAngle);
    const relAng = (a: number) => normalizeAngle(a - sA);
    const sweep = relAng(normalizeAngle(target.endAngle)) || Math.PI * 2;
    const clickRel = relAng(angAt(clickPt));

    const hitRels = hits
      .map((h) => relAng(angAt(h)))
      .filter((r) => r > 1e-4 && r < sweep - 1e-4)
      .sort((a, b) => a - b);
    if (hitRels.length === 0) return null;

    const bounds = [0, ...hitRels, sweep];
    let left = 0;
    let right = sweep;
    for (let i = 0; i < bounds.length - 1; i++) {
      if (clickRel >= bounds[i] - 1e-5 && clickRel <= bounds[i + 1] + 1e-5) {
        left = bounds[i];
        right = bounds[i + 1];
        break;
      }
    }

    const replacements: CadEntity[] = [];
    if (left > 1e-4) {
      replacements.push({
        ...target,
        id: right < sweep - 1e-4 ? genEntityId('trim') : target.id,
        startAngle: sA,
        endAngle: sA + left,
      });
    }
    if (right < sweep - 1e-4) {
      replacements.push({
        ...target,
        id: target.id,
        startAngle: sA + right,
        endAngle: sA + sweep,
      });
    }
    return entities.flatMap((e) => (e.id === targetId ? replacements : [e]));
  }

  if (target.type === 'CIRCLE' && hits.length >= 2) {
    const angAt = (p: Point2D) => normalizeAngle(Math.atan2(p.y - target.center.y, p.x - target.center.x));
    const hitAngles = hits.map(angAt).sort((a, b) => a - b);
    const clickA = angAt(clickPt);
    let idx = hitAngles.findIndex((a) => a > clickA);
    if (idx === -1) idx = 0;
    const endCut = hitAngles[idx];
    const startCut = hitAngles[(idx - 1 + hitAngles.length) % hitAngles.length];
    if (Math.abs(endCut - startCut) < 1e-4) return null;
    // Replace circle with remaining arc from endCut CCW to startCut
    const replacement: CadEntity = {
      id: target.id,
      type: 'ARC',
      layer: target.layer,
      color: target.color,
      aci: target.aci,
      center: target.center,
      radius: target.radius,
      startAngle: endCut,
      endAngle: startCut,
    };
    return entities.map((e) => (e.id === targetId ? replacement : e));
  }

  return null;
}

/**
 * Extends the clicked end of a LINE to the nearest visible boundary entity along its ray.
 */
export function extendLineAtPoint(
  entities: CadEntity[],
  targetId: string,
  clickPt: Point2D,
  visibleLayers: Set<string>
): CadEntity[] | null {
  const target = entities.find((e) => e.id === targetId);
  if (!target || target.type !== 'LINE') return null;

  const dStart = dist(clickPt, target.start);
  const dEnd = dist(clickPt, target.end);
  const extendEnd = dEnd <= dStart;

  const origin = extendEnd ? target.start : target.end;
  const tip = extendEnd ? target.end : target.start;
  const vx = tip.x - origin.x;
  const vy = tip.y - origin.y;
  const len = Math.hypot(vx, vy);
  if (len < 1e-9) return null;
  const ux = vx / len;
  const uy = vy / len;

  // Ray far point along extension direction
  const farPt = { x: tip.x + ux * 1e7, y: tip.y + uy * 1e7 };

  let bestT = Infinity;
  let bestHit: Point2D | null = null;

  for (const other of entities) {
    if (other.id === targetId || other.type === 'DIMENSION' || !visibleLayers.has(other.layer)) continue;

    const segs = getEntityLinearSegments(other);
    for (const [b1, b2] of segs) {
      const hit = intersectInfiniteLines(tip, farPt, b1, b2);
      if (!hit) continue;
      // Verify hit lies on segment b1..b2
      const bx = b2.x - b1.x;
      const by = b2.y - b1.y;
      const bLen2 = bx * bx + by * by;
      if (bLen2 < 1e-12) continue;
      const u = ((hit.x - b1.x) * bx + (hit.y - b1.y) * by) / bLen2;
      if (u < -1e-6 || u > 1 + 1e-6) continue;
      const tRay = (hit.x - tip.x) * ux + (hit.y - tip.y) * uy;
      if (tRay > 1e-5 && tRay < bestT) {
        bestT = tRay;
        bestHit = hit;
      }
    }

    if (other.type === 'CIRCLE' || other.type === 'ARC') {
      const hits = intersectLineCircle(tip, farPt, other.center, other.radius, true);
      for (const h of hits) {
        if (other.type === 'ARC') {
          const ang = Math.atan2(h.y - other.center.y, h.x - other.center.x);
          if (!isAngleBetweenCCW(ang, other.startAngle, other.endAngle)) continue;
        }
        const tRay = (h.x - tip.x) * ux + (h.y - tip.y) * uy;
        if (tRay > 1e-5 && tRay < bestT) {
          bestT = tRay;
          bestHit = h;
        }
      }
    }
  }

  if (!bestHit) return null;

  const updated: LineEntity = extendEnd
    ? { ...target, end: bestHit }
    : { ...target, start: bestHit };

  return entities.map((e) => (e.id === targetId ? updated : e));
}
