import {
  bulgeToArc,
  dist,
  getArcEndpoints,
  getEntityBounds,
  intersectEntities,
  isAngleBetweenCCW,
  isBoxIntersecting,
  midpoint,
  projectPointToInfiniteLine,
  projectPointToSegment,
  tangentPointsToCircle,
} from './geometry';
import { CadEntity, OsnapSettings, OsnapType, Point2D, SnapResult } from './types';

const SNAP_PRIORITY: Record<OsnapType, number> = {
  endpoint: 1,
  intersection: 2,
  center: 3,
  midpoint: 4,
  quadrant: 5,
  perpendicular: 6,
  tangent: 7,
  node: 8,
  nearest: 9,
};

export const OSNAP_LABELS: Record<OsnapType, string> = {
  endpoint: 'Endpoint',
  midpoint: 'Midpoint',
  center: 'Center',
  intersection: 'Intersection',
  nearest: 'Nearest',
  perpendicular: 'Perpendicular',
  tangent: 'Tangent',
  quadrant: 'Quadrant',
  node: 'Node',
};

export function findBestSnap(
  cursorWorld: Point2D,
  entities: CadEntity[],
  visibleLayers: Set<string>,
  scale: number,
  settings: OsnapSettings,
  referencePoint?: Point2D | null,
  snapRadiusPx = 14
): SnapResult | null {
  if (!settings.enabled) return null;

  const tolWorld = snapRadiusPx / Math.max(1e-6, scale);
  const searchBox = {
    minX: cursorWorld.x - tolWorld * 1.5,
    minY: cursorWorld.y - tolWorld * 1.5,
    maxX: cursorWorld.x + tolWorld * 1.5,
    maxY: cursorWorld.y + tolWorld * 1.5,
  };

  const candidates: SnapResult[] = [];
  const nearbyEntities: CadEntity[] = [];

  const pushCandidate = (point: Point2D, type: OsnapType, entityId?: string) => {
    const dScreen = dist(cursorWorld, point) * scale;
    if (dScreen <= snapRadiusPx) {
      candidates.push({ point, type, entityId, screenDist: dScreen });
    }
  };

  for (const e of entities) {
    if (!visibleLayers.has(e.layer)) continue;
    if (e.type === 'DIMENSION') continue; // avoid snapping onto dim annotation chrome
    const b = getEntityBounds(e);
    if (!b || !isBoxIntersecting(b, searchBox)) continue;
    nearbyEntities.push(e);

    switch (e.type) {
      case 'LINE': {
        if (settings.endpoint) {
          pushCandidate(e.start, 'endpoint', e.id);
          pushCandidate(e.end, 'endpoint', e.id);
        }
        if (settings.midpoint) {
          pushCandidate(midpoint(e.start, e.end), 'midpoint', e.id);
        }
        if (settings.perpendicular && referencePoint) {
          const perp = projectPointToInfiniteLine(referencePoint, e.start, e.end);
          if (perp.t >= -0.05 && perp.t <= 1.05) {
            pushCandidate(perp.point, 'perpendicular', e.id);
          }
        }
        if (settings.nearest) {
          const near = projectPointToSegment(cursorWorld, e.start, e.end);
          pushCandidate(near.point, 'nearest', e.id);
        }
        break;
      }

      case 'LWPOLYLINE': {
        const verts = e.vertices;
        const count = e.closed ? verts.length : verts.length - 1;
        for (let i = 0; i < verts.length; i++) {
          if (settings.endpoint || settings.node) {
            pushCandidate({ x: verts[i].x, y: verts[i].y }, settings.endpoint ? 'endpoint' : 'node', e.id);
          }
        }
        for (let i = 0; i < count; i++) {
          const p1 = verts[i];
          const p2 = verts[(i + 1) % verts.length];
          const arc = p1.bulge ? bulgeToArc(p1, p2, p1.bulge) : null;
          if (arc) {
            if (settings.center) pushCandidate(arc.center, 'center', e.id);
            if (settings.midpoint) {
              const dir = arc.ccw ? 1 : -1;
              const midA = arc.startAngle + dir * (arc.sweepAngle / 2);
              pushCandidate(
                {
                  x: arc.center.x + arc.radius * Math.cos(midA),
                  y: arc.center.y + arc.radius * Math.sin(midA),
                },
                'midpoint',
                e.id
              );
            }
          } else {
            if (settings.midpoint) {
              pushCandidate(midpoint(p1, p2), 'midpoint', e.id);
            }
            if (settings.perpendicular && referencePoint) {
              const perp = projectPointToInfiniteLine(referencePoint, p1, p2);
              if (perp.t >= 0 && perp.t <= 1) {
                pushCandidate(perp.point, 'perpendicular', e.id);
              }
            }
            if (settings.nearest) {
              const near = projectPointToSegment(cursorWorld, p1, p2);
              pushCandidate(near.point, 'nearest', e.id);
            }
          }
        }
        break;
      }

      case 'CIRCLE': {
        if (settings.center) {
          pushCandidate(e.center, 'center', e.id);
        }
        if (settings.quadrant) {
          pushCandidate({ x: e.center.x + e.radius, y: e.center.y }, 'quadrant', e.id);
          pushCandidate({ x: e.center.x - e.radius, y: e.center.y }, 'quadrant', e.id);
          pushCandidate({ x: e.center.x, y: e.center.y + e.radius }, 'quadrant', e.id);
          pushCandidate({ x: e.center.x, y: e.center.y - e.radius }, 'quadrant', e.id);
        }
        if (settings.tangent && referencePoint) {
          const tans = tangentPointsToCircle(referencePoint, e.center, e.radius);
          tans.forEach((t) => pushCandidate(t, 'tangent', e.id));
        }
        if (settings.perpendicular && referencePoint) {
          const ang = Math.atan2(referencePoint.y - e.center.y, referencePoint.x - e.center.x);
          pushCandidate(
            { x: e.center.x + e.radius * Math.cos(ang), y: e.center.y + e.radius * Math.sin(ang) },
            'perpendicular',
            e.id
          );
          pushCandidate(
            { x: e.center.x - e.radius * Math.cos(ang), y: e.center.y - e.radius * Math.sin(ang) },
            'perpendicular',
            e.id
          );
        }
        if (settings.nearest) {
          const ang = Math.atan2(cursorWorld.y - e.center.y, cursorWorld.x - e.center.x);
          pushCandidate(
            { x: e.center.x + e.radius * Math.cos(ang), y: e.center.y + e.radius * Math.sin(ang) },
            'nearest',
            e.id
          );
        }
        break;
      }

      case 'ARC': {
        const eps = getArcEndpoints(e);
        if (settings.endpoint) {
          pushCandidate(eps.start, 'endpoint', e.id);
          pushCandidate(eps.end, 'endpoint', e.id);
        }
        if (settings.midpoint) {
          pushCandidate(eps.mid, 'midpoint', e.id);
        }
        if (settings.center) {
          pushCandidate(e.center, 'center', e.id);
        }
        if (settings.quadrant) {
          const quadAngles = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
          for (const qa of quadAngles) {
            if (isAngleBetweenCCW(qa, e.startAngle, e.endAngle)) {
              pushCandidate(
                { x: e.center.x + e.radius * Math.cos(qa), y: e.center.y + e.radius * Math.sin(qa) },
                'quadrant',
                e.id
              );
            }
          }
        }
        if (settings.tangent && referencePoint) {
          const tans = tangentPointsToCircle(referencePoint, e.center, e.radius);
          for (const t of tans) {
            const ang = Math.atan2(t.y - e.center.y, t.x - e.center.x);
            if (isAngleBetweenCCW(ang, e.startAngle, e.endAngle)) {
              pushCandidate(t, 'tangent', e.id);
            }
          }
        }
        if (settings.nearest) {
          const ang = Math.atan2(cursorWorld.y - e.center.y, cursorWorld.x - e.center.x);
          if (isAngleBetweenCCW(ang, e.startAngle, e.endAngle)) {
            pushCandidate(
              { x: e.center.x + e.radius * Math.cos(ang), y: e.center.y + e.radius * Math.sin(ang) },
              'nearest',
              e.id
            );
          }
        }
        break;
      }

      case 'ELLIPSE': {
        if (settings.center) {
          pushCandidate(e.center, 'center', e.id);
        }
        break;
      }

      case 'SPLINE': {
        const pts = e.sampledPoints;
        if (pts.length >= 2) {
          if (settings.endpoint) {
            pushCandidate(pts[0], 'endpoint', e.id);
            pushCandidate(pts[pts.length - 1], 'endpoint', e.id);
          }
          if (settings.midpoint) {
            pushCandidate(pts[Math.floor(pts.length / 2)], 'midpoint', e.id);
          }
          if (settings.node) {
            e.fitPoints.forEach((fp) => pushCandidate(fp, 'node', e.id));
          }
          if (settings.nearest) {
            for (let i = 0; i < pts.length - 1; i++) {
              const near = projectPointToSegment(cursorWorld, pts[i], pts[i + 1]);
              pushCandidate(near.point, 'nearest', e.id);
            }
          }
        }
        break;
      }

      case 'POINT':
      case 'TEXT': {
        if (settings.node) {
          pushCandidate(e.position, 'node', e.id);
        }
        break;
      }
    }
  }

  // Pairwise geometric intersections among nearby entities
  if (settings.intersection && nearbyEntities.length > 1) {
    const cap = Math.min(nearbyEntities.length, 40);
    for (let i = 0; i < cap; i++) {
      for (let j = i + 1; j < cap; j++) {
        const hits = intersectEntities(nearbyEntities[i], nearbyEntities[j]);
        for (const h of hits) {
          pushCandidate(h, 'intersection', nearbyEntities[i].id);
        }
      }
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    // Prefer high-priority geometric snap within aperture over 'nearest'
    const pa = SNAP_PRIORITY[a.type];
    const pb = SNAP_PRIORITY[b.type];
    if (a.type === 'nearest' && b.type !== 'nearest') return 1;
    if (b.type === 'nearest' && a.type !== 'nearest') return -1;
    if (Math.abs(a.screenDist - b.screenDist) < 4) {
      return pa - pb;
    }
    return a.screenDist - b.screenDist;
  });

  return candidates[0];
}
