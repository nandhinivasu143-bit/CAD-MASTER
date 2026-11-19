package com.cadmaster.offline.cad

import kotlin.math.*

data class ArcFromBulge(
    val center: Point2D,
    val radius: Double,
    val startAngleRad: Double,
    val endAngleRad: Double,
    val ccw: Boolean,
    val length: Double
)

data class HitTestResult(
    val entity: CadEntity,
    val distanceWorld: Double,
    val closestPoint: Point2D,
    val segmentIndex: Int? = null
)

object CadGeometry {
    private const val EPS = 1e-9

    fun dist(a: Point2D, b: Point2D): Double = hypot(b.x - a.x, b.y - a.y)

    fun angleRad(a: Point2D, b: Point2D): Double = atan2(b.y - a.y, b.x - a.x)

    fun angleDeg(a: Point2D, b: Point2D): Double {
        var deg = Math.toDegrees(angleRad(a, b))
        if (deg < 0) deg += 360.0
        return deg
    }

    fun normalizeAngleDeg(deg: Double): Double {
        var r = deg % 360.0
        if (r < 0) r += 360.0
        return r
    }

    fun arcSweepDeg(startDeg: Double, endDeg: Double): Double {
        var sweep = normalizeAngleDeg(endDeg) - normalizeAngleDeg(startDeg)
        if (sweep <= 0.0) sweep += 360.0
        return sweep
    }

    fun bulgeToArc(p1: Point2D, p2: Point2D, bulge: Double): ArcFromBulge? {
        if (abs(bulge) < 1e-7) return null
        val chord = dist(p1, p2)
        if (chord < EPS) return null
        val theta = 4.0 * atan(abs(bulge))
        val radius = chord / (2.0 * sin(theta * 0.5))
        val mid = Point2D((p1.x + p2.x) * 0.5, (p1.y + p2.y) * 0.5)
        val ux = (p2.x - p1.x) / chord
        val uy = (p2.y - p1.y) / chord
        val nx = -uy
        val ny = ux
        val distToCenter = radius * cos(theta * 0.5)
        val sign = if (bulge > 0) 1.0 else -1.0
        // If |bulge| > 1, arc > 180 deg, center flips side
        val sideFlip = if (abs(bulge) > 1.0) -1.0 else 1.0
        val cx = mid.x + sign * sideFlip * nx * distToCenter
        val cy = mid.y + sign * sideFlip * ny * distToCenter
        val center = Point2D(cx, cy)
        val startA = atan2(p1.y - cy, p1.x - cx)
        val endA = atan2(p2.y - cy, p2.x - cx)
        return ArcFromBulge(
            center = center,
            radius = radius,
            startAngleRad = startA,
            endAngleRad = endA,
            ccw = bulge > 0,
            length = radius * theta
        )
    }

    fun projectPointToSegment(p: Point2D, a: Point2D, b: Point2D): Pair<Point2D, Double> {
        val dx = b.x - a.x
        val dy = b.y - a.y
        val lenSq = dx * dx + dy * dy
        if (lenSq < EPS) return a to dist(p, a)
        val t = (((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq).coerceIn(0.0, 1.0)
        val proj = Point2D(a.x + t * dx, a.y + t * dy)
        return proj to dist(p, proj)
    }

    fun projectPointToInfiniteLine(p: Point2D, a: Point2D, b: Point2D): Point2D? {
        val dx = b.x - a.x
        val dy = b.y - a.y
        val lenSq = dx * dx + dy * dy
        if (lenSq < EPS) return null
        val t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq
        return Point2D(a.x + t * dx, a.y + t * dy)
    }

    fun isAngleOnArc(angleDeg: Double, startDeg: Double, endDeg: Double): Boolean {
        val a = normalizeAngleDeg(angleDeg)
        val s = normalizeAngleDeg(startDeg)
        val e = normalizeAngleDeg(endDeg)
        return if (s <= e) {
            a >= s - 1e-4 && a <= e + 1e-4
        } else {
            a >= s - 1e-4 || a <= e + 1e-4
        }
    }

    fun evaluateSplinePoints(spline: CadEntity.Spline, segmentsPerSpan: Int = 16): List<Point2D> {
        val pts = spline.controlPoints
        if (pts.size < 2) return if (spline.fitPoints.size >= 2) spline.fitPoints else pts
        val p = spline.degree.coerceIn(1, (pts.size - 1).coerceAtLeast(1))
        val n = pts.size - 1
        val knots = if (spline.knots.size == n + p + 2) {
            spline.knots
        } else {
            // Open uniform clamped knot vector
            val m = n + p + 1
            List(m + 1) { idx ->
                when {
                    idx <= p -> 0.0
                    idx >= m - p -> (n - p + 1).toDouble()
                    else -> (idx - p).toDouble()
                }
            }
        }
        val uMin = knots[p]
        val uMax = knots[n + 1]
        if (uMax - uMin < EPS) return pts
        val steps = (pts.size * segmentsPerSpan).coerceIn(24, 240)
        val result = ArrayList<Point2D>(steps + 1)
        for (i in 0..steps) {
            val u = if (i == steps) uMax - 1e-9 else uMin + (uMax - uMin) * (i.toDouble() / steps)
            result.add(deBoor(p, knots, pts, u))
        }
        result[result.lastIndex] = pts.last()
        return result
    }

    private fun deBoor(degree: Int, knots: List<Double>, ctrl: List<Point2D>, u: Double): Point2D {
        val n = ctrl.size - 1
        var span = degree
        for (i in degree..n) {
            if (u >= knots[i] && u < knots[i + 1]) {
                span = i
                break
            }
        }
        val d = Array(degree + 1) { j ->
            val idx = (span - degree + j).coerceIn(0, n)
            ctrl[idx]
        }
        for (r in 1..degree) {
            for (j in degree downTo r) {
                val leftIdx = span - degree + j
                val rightIdx = leftIdx + degree + 1 - r
                val denom = knots[rightIdx] - knots[leftIdx]
                val alpha = if (abs(denom) < 1e-12) 0.0 else (u - knots[leftIdx]) / denom
                d[j] = Point2D(
                    (1.0 - alpha) * d[j - 1].x + alpha * d[j].x,
                    (1.0 - alpha) * d[j - 1].y + alpha * d[j].y
                )
            }
        }
        return d[degree]
    }

    fun evaluateEllipsePoints(e: CadEntity.Ellipse, steps: Int = 64): List<Point2D> {
        val a = hypot(e.majorAxisEnd.x, e.majorAxisEnd.y)
        val b = a * e.ratio
        val rot = atan2(e.majorAxisEnd.y, e.majorAxisEnd.x)
        val cosR = cos(rot)
        val sinR = sin(rot)
        val start = e.startParam
        val end = if (e.endParam <= e.startParam) e.endParam + 2.0 * PI else e.endParam
        return List(steps + 1) { i ->
            val t = start + (end - start) * (i.toDouble() / steps)
            val lx = a * cos(t)
            val ly = b * sin(t)
            Point2D(
                e.center.x + lx * cosR - ly * sinR,
                e.center.y + lx * sinR + ly * cosR
            )
        }
    }

    fun computePolygonArea(points: List<Point2D>): Double {
        if (points.size < 3) return 0.0
        var sum = 0.0
        for (i in points.indices) {
            val a = points[i]
            val b = points[(i + 1) % points.size]
            sum += a.x * b.y - b.x * a.y
        }
        return abs(sum) * 0.5
    }

    fun polylineSegments(poly: CadEntity.LwPolyline): List<PolylineSegmentInfo> {
        val v = poly.vertices
        if (v.size < 2) return emptyList()
        val count = if (poly.closed) v.size else v.size - 1
        val out = ArrayList<PolylineSegmentInfo>(count)
        for (i in 0 until count) {
            val a = v[i]
            val b = v[(i + 1) % v.size]
            val p1 = Point2D(a.x, a.y)
            val p2 = Point2D(b.x, b.y)
            val arc = bulgeToArc(p1, p2, a.bulge)
            val segLen = arc?.length ?: dist(p1, p2)
            out.add(
                PolylineSegmentInfo(
                    index = i,
                    start = p1,
                    end = p2,
                    length = segLen,
                    angleDeg = angleDeg(p1, p2),
                    dx = abs(p2.x - p1.x),
                    dy = abs(p2.y - p1.y),
                    isArc = arc != null
                )
            )
        }
        return out
    }

    fun measureEntity(entity: CadEntity, segmentIndex: Int? = null): EntityMeasurement {
        return when (entity) {
            is CadEntity.Line -> {
                val len = dist(entity.start, entity.end)
                EntityMeasurement(
                    entityId = entity.id,
                    entityType = "LINE",
                    layer = entity.layer,
                    primaryLabel = "Length",
                    primaryValue = len,
                    start = entity.start,
                    end = entity.end,
                    angleDeg = angleDeg(entity.start, entity.end),
                    dx = abs(entity.end.x - entity.start.x),
                    dy = abs(entity.end.y - entity.start.y)
                )
            }
            is CadEntity.LwPolyline -> {
                val segs = polylineSegments(entity)
                val total = segs.sumOf { it.length }
                val activeSeg = segmentIndex?.let { idx -> segs.getOrNull(idx) }
                val pts = entity.vertices.map { Point2D(it.x, it.y) }
                val area = if (entity.closed) computePolygonArea(pts) else null
                EntityMeasurement(
                    entityId = entity.id,
                    entityType = if (entity.closed) "CLOSED POLYLINE" else "POLYLINE",
                    layer = entity.layer,
                    primaryLabel = if (activeSeg != null) "Segment #${activeSeg.index + 1}" else "Total Length",
                    primaryValue = activeSeg?.length ?: total,
                    start = activeSeg?.start ?: pts.firstOrNull(),
                    end = activeSeg?.end ?: pts.lastOrNull(),
                    angleDeg = activeSeg?.angleDeg,
                    dx = activeSeg?.dx,
                    dy = activeSeg?.dy,
                    circumferenceOrArea = area,
                    segments = segs,
                    selectedSegmentIndex = segmentIndex
                )
            }
            is CadEntity.Circle -> {
                val circ = 2.0 * PI * entity.radius
                EntityMeasurement(
                    entityId = entity.id,
                    entityType = "CIRCLE",
                    layer = entity.layer,
                    primaryLabel = "Circumference",
                    primaryValue = circ,
                    center = entity.center,
                    radius = entity.radius,
                    diameter = entity.radius * 2.0,
                    circumferenceOrArea = PI * entity.radius * entity.radius
                )
            }
            is CadEntity.Arc -> {
                val sweep = arcSweepDeg(entity.startAngleDeg, entity.endAngleDeg)
                val arcLen = entity.radius * Math.toRadians(sweep)
                val sPt = Point2D(
                    entity.center.x + entity.radius * cos(Math.toRadians(entity.startAngleDeg)),
                    entity.center.y + entity.radius * sin(Math.toRadians(entity.startAngleDeg))
                )
                val ePt = Point2D(
                    entity.center.x + entity.radius * cos(Math.toRadians(entity.endAngleDeg)),
                    entity.center.y + entity.radius * sin(Math.toRadians(entity.endAngleDeg))
                )
                EntityMeasurement(
                    entityId = entity.id,
                    entityType = "ARC",
                    layer = entity.layer,
                    primaryLabel = "Arc Length",
                    primaryValue = arcLen,
                    start = sPt,
                    end = ePt,
                    center = entity.center,
                    angleDeg = sweep,
                    radius = entity.radius,
                    diameter = entity.radius * 2.0
                )
            }
            is CadEntity.Ellipse -> {
                val pts = evaluateEllipsePoints(entity)
                var len = 0.0
                for (i in 0 until pts.size - 1) len += dist(pts[i], pts[i + 1])
                EntityMeasurement(
                    entityId = entity.id,
                    entityType = "ELLIPSE",
                    layer = entity.layer,
                    primaryLabel = "Perimeter",
                    primaryValue = len,
                    center = entity.center,
                    radius = hypot(entity.majorAxisEnd.x, entity.majorAxisEnd.y)
                )
            }
            is CadEntity.Spline -> {
                val pts = evaluateSplinePoints(entity)
                var len = 0.0
                for (i in 0 until pts.size - 1) len += dist(pts[i], pts[i + 1])
                EntityMeasurement(
                    entityId = entity.id,
                    entityType = "SPLINE",
                    layer = entity.layer,
                    primaryLabel = "Spline Length",
                    primaryValue = len,
                    start = pts.firstOrNull(),
                    end = pts.lastOrNull()
                )
            }
            is CadEntity.Text -> EntityMeasurement(
                entityId = entity.id,
                entityType = "TEXT",
                layer = entity.layer,
                primaryLabel = "Height",
                primaryValue = entity.height,
                start = entity.position,
                angleDeg = entity.rotationDeg
            )
            is CadEntity.Point -> EntityMeasurement(
                entityId = entity.id,
                entityType = "POINT",
                layer = entity.layer,
                primaryLabel = "X Coord",
                primaryValue = entity.position.x,
                start = entity.position
            )
            is CadEntity.Dimension -> EntityMeasurement(
                entityId = entity.id,
                entityType = entity.kind.label.uppercase(),
                layer = entity.layer,
                primaryLabel = entity.kind.shortLabel,
                primaryValue = entity.measuredValue,
                isArea = entity.kind == DimensionKind.AREA,
                start = entity.points.firstOrNull(),
                end = entity.points.getOrNull(1)
            )
        }
    }

    fun getEntityBounds(entity: CadEntity): BoundingBox {
        return when (entity) {
            is CadEntity.Line -> BoundingBox(
                min(entity.start.x, entity.end.x),
                min(entity.start.y, entity.end.y),
                max(entity.start.x, entity.end.x),
                max(entity.start.y, entity.end.y)
            )
            is CadEntity.LwPolyline -> {
                if (entity.vertices.isEmpty()) return BoundingBox(0.0, 0.0, 0.0, 0.0)
                var minX = Double.POSITIVE_INFINITY
                var minY = Double.POSITIVE_INFINITY
                var maxX = Double.NEGATIVE_INFINITY
                var maxY = Double.NEGATIVE_INFINITY
                for (v in entity.vertices) {
                    minX = min(minX, v.x); minY = min(minY, v.y)
                    maxX = max(maxX, v.x); maxY = max(maxY, v.y)
                }
                BoundingBox(minX, minY, maxX, maxY)
            }
            is CadEntity.Circle -> BoundingBox(
                entity.center.x - entity.radius,
                entity.center.y - entity.radius,
                entity.center.x + entity.radius,
                entity.center.y + entity.radius
            )
            is CadEntity.Arc -> BoundingBox(
                entity.center.x - entity.radius,
                entity.center.y - entity.radius,
                entity.center.x + entity.radius,
                entity.center.y + entity.radius
            )
            is CadEntity.Ellipse -> {
                val r = hypot(entity.majorAxisEnd.x, entity.majorAxisEnd.y)
                BoundingBox(entity.center.x - r, entity.center.y - r, entity.center.x + r, entity.center.y + r)
            }
            is CadEntity.Spline -> {
                val pts = evaluateSplinePoints(entity)
                if (pts.isEmpty()) return BoundingBox(0.0, 0.0, 0.0, 0.0)
                BoundingBox(
                    pts.minOf { it.x }, pts.minOf { it.y },
                    pts.maxOf { it.x }, pts.maxOf { it.y }
                )
            }
            is CadEntity.Text -> BoundingBox(
                entity.position.x,
                entity.position.y,
                entity.position.x + entity.content.length * entity.height * 0.6,
                entity.position.y + entity.height
            )
            is CadEntity.Point -> BoundingBox(entity.position.x, entity.position.y, entity.position.x, entity.position.y)
            is CadEntity.Dimension -> {
                val all = entity.points + listOfNotNull(entity.defPoint)
                if (all.isEmpty()) return BoundingBox(0.0, 0.0, 0.0, 0.0)
                BoundingBox(all.minOf { it.x }, all.minOf { it.y }, all.maxOf { it.x }, all.maxOf { it.y })
            }
        }
    }

    fun getDocumentBounds(entities: List<CadEntity>): BoundingBox {
        if (entities.isEmpty()) return BoundingBox(0.0, 0.0, 100.0, 100.0)
        var minX = Double.POSITIVE_INFINITY
        var minY = Double.POSITIVE_INFINITY
        var maxX = Double.NEGATIVE_INFINITY
        var maxY = Double.NEGATIVE_INFINITY
        for (e in entities) {
            val b = getEntityBounds(e)
            minX = min(minX, b.minX)
            minY = min(minY, b.minY)
            maxX = max(maxX, b.maxX)
            maxY = max(maxY, b.maxY)
        }
        if (!minX.isFinite()) return BoundingBox(0.0, 0.0, 100.0, 100.0)
        return BoundingBox(minX, minY, maxX, maxY)
    }

    fun hitTest(
        worldPt: Point2D,
        entities: List<CadEntity>,
        visibleLayers: Set<String>,
        toleranceWorld: Double
    ): HitTestResult? {
        var best: HitTestResult? = null
        val queryBox = BoundingBox(
            worldPt.x - toleranceWorld,
            worldPt.y - toleranceWorld,
            worldPt.x + toleranceWorld,
            worldPt.y + toleranceWorld
        )

        for (entity in entities) {
            if (entity.layer !in visibleLayers) continue
            // Fast AABB cull before narrow-phase math
            val b = getEntityBounds(entity)
            val expanded = BoundingBox(b.minX - toleranceWorld, b.minY - toleranceWorld, b.maxX + toleranceWorld, b.maxY + toleranceWorld)
            if (!expanded.overlaps(queryBox)) continue

            val candidate = hitTestSingle(worldPt, entity) ?: continue
            if (candidate.distanceWorld <= toleranceWorld) {
                if (best == null || candidate.distanceWorld < best.distanceWorld) {
                    best = candidate
                }
            }
        }
        return best
    }

    private fun hitTestSingle(p: Point2D, entity: CadEntity): HitTestResult? {
        return when (entity) {
            is CadEntity.Line -> {
                val (proj, d) = projectPointToSegment(p, entity.start, entity.end)
                HitTestResult(entity, d, proj)
            }
            is CadEntity.LwPolyline -> {
                val v = entity.vertices
                if (v.size < 2) return null
                val count = if (entity.closed) v.size else v.size - 1
                var bestD = Double.POSITIVE_INFINITY
                var bestPt = Point2D(v[0].x, v[0].y)
                var bestSeg = 0
                for (i in 0 until count) {
                    val a = Point2D(v[i].x, v[i].y)
                    val b = Point2D(v[(i + 1) % v.size].x, v[(i + 1) % v.size].y)
                    val (proj, d) = projectPointToSegment(p, a, b)
                    if (d < bestD) {
                        bestD = d
                        bestPt = proj
                        bestSeg = i
                    }
                }
                HitTestResult(entity, bestD, bestPt, bestSeg)
            }
            is CadEntity.Circle -> {
                val dCenter = dist(p, entity.center)
                val d = abs(dCenter - entity.radius)
                val ang = atan2(p.y - entity.center.y, p.x - entity.center.x)
                val closest = Point2D(entity.center.x + entity.radius * cos(ang), entity.center.y + entity.radius * sin(ang))
                HitTestResult(entity, d, closest)
            }
            is CadEntity.Arc -> {
                val angRad = atan2(p.y - entity.center.y, p.x - entity.center.x)
                val angDeg = normalizeAngleDeg(Math.toDegrees(angRad))
                if (isAngleOnArc(angDeg, entity.startAngleDeg, entity.endAngleDeg)) {
                    val d = abs(dist(p, entity.center) - entity.radius)
                    val closest = Point2D(entity.center.x + entity.radius * cos(angRad), entity.center.y + entity.radius * sin(angRad))
                    HitTestResult(entity, d, closest)
                } else {
                    val sPt = Point2D(
                        entity.center.x + entity.radius * cos(Math.toRadians(entity.startAngleDeg)),
                        entity.center.y + entity.radius * sin(Math.toRadians(entity.startAngleDeg))
                    )
                    val ePt = Point2D(
                        entity.center.x + entity.radius * cos(Math.toRadians(entity.endAngleDeg)),
                        entity.center.y + entity.radius * sin(Math.toRadians(entity.endAngleDeg))
                    )
                    val ds = dist(p, sPt)
                    val de = dist(p, ePt)
                    if (ds <= de) HitTestResult(entity, ds, sPt) else HitTestResult(entity, de, ePt)
                }
            }
            is CadEntity.Ellipse -> {
                val pts = evaluateEllipsePoints(entity, 48)
                hitTestPolylinePoints(p, entity, pts)
            }
            is CadEntity.Spline -> {
                val pts = evaluateSplinePoints(entity, 12)
                hitTestPolylinePoints(p, entity, pts)
            }
            is CadEntity.Text -> {
                val d = dist(p, entity.position)
                HitTestResult(entity, d, entity.position)
            }
            is CadEntity.Point -> {
                HitTestResult(entity, dist(p, entity.position), entity.position)
            }
            is CadEntity.Dimension -> {
                val pts = entity.points + listOfNotNull(entity.defPoint)
                if (pts.isEmpty()) return null
                var minD = Double.POSITIVE_INFINITY
                var bestPt = pts[0]
                for (pt in pts) {
                    val d = dist(p, pt)
                    if (d < minD) { minD = d; bestPt = pt }
                }
                if (pts.size >= 2) {
                    val (proj, sd) = projectPointToSegment(p, pts[0], pts[1])
                    if (sd < minD) { minD = sd; bestPt = proj }
                }
                HitTestResult(entity, minD, bestPt)
            }
        }
    }

    private fun hitTestPolylinePoints(p: Point2D, entity: CadEntity, pts: List<Point2D>): HitTestResult? {
        if (pts.size < 2) return null
        var bestD = Double.POSITIVE_INFINITY
        var bestPt = pts[0]
        for (i in 0 until pts.size - 1) {
            val (proj, d) = projectPointToSegment(p, pts[i], pts[i + 1])
            if (d < bestD) { bestD = d; bestPt = proj }
        }
        return HitTestResult(entity, bestD, bestPt)
    }

    fun intersectLineSegment(a1: Point2D, a2: Point2D, b1: Point2D, b2: Point2D): Point2D? {
        val dax = a2.x - a1.x
        val day = a2.y - a1.y
        val dbx = b2.x - b1.x
        val dby = b2.y - b1.y
        val denom = dax * dby - day * dbx
        if (abs(denom) < EPS) return null
        val dx = b1.x - a1.x
        val dy = b1.y - a1.y
        val t = (dx * dby - dy * dbx) / denom
        val u = (dx * day - dy * dax) / denom
        if (t in -1e-6..1.0 + 1e-6 && u in -1e-6..1.0 + 1e-6) {
            return Point2D(a1.x + t * dax, a1.y + t * day)
        }
        return null
    }

    fun intersectSegmentCircle(a: Point2D, b: Point2D, center: Point2D, radius: Double): List<Point2D> {
        val dx = b.x - a.x
        val dy = b.y - a.y
        val fx = a.x - center.x
        val fy = a.y - center.y
        val aa = dx * dx + dy * dy
        if (aa < EPS) return emptyList()
        val bb = 2.0 * (fx * dx + fy * dy)
        val cc = fx * fx + fy * fy - radius * radius
        val disc = bb * bb - 4.0 * aa * cc
        if (disc < 0.0) return emptyList()
        val sqrtD = sqrt(disc)
        val out = mutableListOf<Point2D>()
        val t1 = (-bb - sqrtD) / (2.0 * aa)
        val t2 = (-bb + sqrtD) / (2.0 * aa)
        if (t1 in -1e-6..1.0 + 1e-6) out.add(Point2D(a.x + t1 * dx, a.y + t1 * dy))
        if (abs(t2 - t1) > 1e-6 && t2 in -1e-6..1.0 + 1e-6) out.add(Point2D(a.x + t2 * dx, a.y + t2 * dy))
        return out
    }

    fun intersectCircles(c1: Point2D, r1: Double, c2: Point2D, r2: Double): List<Point2D> {
        val d = dist(c1, c2)
        if (d < EPS || d > r1 + r2 + 1e-6 || d < abs(r1 - r2) - 1e-6) return emptyList()
        val a = (r1 * r1 - r2 * r2 + d * d) / (2.0 * d)
        val hSq = (r1 * r1 - a * a).coerceAtLeast(0.0)
        val h = sqrt(hSq)
        val xm = c1.x + a * (c2.x - c1.x) / d
        val ym = c1.y + a * (c2.y - c1.y) / d
        val rx = -(c2.y - c1.y) * (h / d)
        val ry = (c2.x - c1.x) * (h / d)
        val p1 = Point2D(xm + rx, ym + ry)
        val p2 = Point2D(xm - rx, ym - ry)
        return if (dist(p1, p2) < 1e-6) listOf(p1) else listOf(p1, p2)
    }

    fun tangentPointsToCircle(externalPt: Point2D, center: Point2D, radius: Double): List<Point2D> {
        val d = dist(externalPt, center)
        if (d <= radius + 1e-6) return emptyList()
        val baseAngle = atan2(externalPt.y - center.y, externalPt.x - center.x)
        val alpha = acos((radius / d).coerceIn(-1.0, 1.0))
        return listOf(
            Point2D(center.x + radius * cos(baseAngle + alpha), center.y + radius * sin(baseAngle + alpha)),
            Point2D(center.x + radius * cos(baseAngle - alpha), center.y + radius * sin(baseAngle - alpha))
        )
    }
}
