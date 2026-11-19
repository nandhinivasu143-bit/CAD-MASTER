package com.cadmaster.offline.cad

import kotlin.math.cos
import kotlin.math.sin

object CadOsnap {

    fun findBestSnap(
        worldCursor: Point2D,
        entities: List<CadEntity>,
        visibleLayers: Set<String>,
        settings: OsnapSettings,
        viewportScale: Double,
        referencePoint: Point2D? = null
    ): SnapResult? {
        if (!settings.enabled || settings.modes.isEmpty() || viewportScale <= 0.0) return null
        // Scale-adaptive snap radius in CAD world units
        val worldRadius = settings.snapRadiusPx / viewportScale
        val queryBox = BoundingBox(
            worldCursor.x - worldRadius,
            worldCursor.y - worldRadius,
            worldCursor.x + worldRadius,
            worldCursor.y + worldRadius
        )

        val nearby = ArrayList<CadEntity>()
        for (entity in entities) {
            if (entity.layer !in visibleLayers) continue
            val b = CadGeometry.getEntityBounds(entity)
            val exp = BoundingBox(b.minX - worldRadius, b.minY - worldRadius, b.maxX + worldRadius, b.maxY + worldRadius)
            if (exp.overlaps(queryBox)) nearby.add(entity)
        }

        val candidates = ArrayList<SnapResult>()

        fun consider(pt: Point2D, type: OsnapType, entityId: String) {
            if (type !in settings.modes) return
            val screenDist = CadGeometry.dist(worldCursor, pt) * viewportScale
            if (screenDist <= settings.snapRadiusPx) {
                candidates.add(SnapResult(pt, type, entityId, screenDist))
            }
        }

        for (e in nearby) {
            when (e) {
                is CadEntity.Line -> {
                    consider(e.start, OsnapType.ENDPOINT, e.id)
                    consider(e.end, OsnapType.ENDPOINT, e.id)
                    consider(Point2D((e.start.x + e.end.x) * 0.5, (e.start.y + e.end.y) * 0.5), OsnapType.MIDPOINT, e.id)
                    val (nearPt, _) = CadGeometry.projectPointToSegment(worldCursor, e.start, e.end)
                    consider(nearPt, OsnapType.NEAREST, e.id)
                    if (referencePoint != null) {
                        val perp = CadGeometry.projectPointToInfiniteLine(referencePoint, e.start, e.end)
                        if (perp != null) consider(perp, OsnapType.PERPENDICULAR, e.id)
                    }
                }
                is CadEntity.LwPolyline -> {
                    val v = e.vertices
                    for (i in v.indices) {
                        val p1 = Point2D(v[i].x, v[i].y)
                        consider(p1, OsnapType.ENDPOINT, e.id)
                        if (i + 1 < v.size || e.closed) {
                            val next = v[(i + 1) % v.size]
                            val p2 = Point2D(next.x, next.y)
                            consider(Point2D((p1.x + p2.x) * 0.5, (p1.y + p2.y) * 0.5), OsnapType.MIDPOINT, e.id)
                            val (nearPt, _) = CadGeometry.projectPointToSegment(worldCursor, p1, p2)
                            consider(nearPt, OsnapType.NEAREST, e.id)
                            if (referencePoint != null) {
                                val perp = CadGeometry.projectPointToInfiniteLine(referencePoint, p1, p2)
                                if (perp != null) consider(perp, OsnapType.PERPENDICULAR, e.id)
                            }
                        }
                    }
                }
                is CadEntity.Circle -> {
                    consider(e.center, OsnapType.CENTER, e.id)
                    consider(Point2D(e.center.x + e.radius, e.center.y), OsnapType.QUADRANT, e.id)
                    consider(Point2D(e.center.x - e.radius, e.center.y), OsnapType.QUADRANT, e.id)
                    consider(Point2D(e.center.x, e.center.y + e.radius), OsnapType.QUADRANT, e.id)
                    consider(Point2D(e.center.x, e.center.y - e.radius), OsnapType.QUADRANT, e.id)
                    val ang = kotlin.math.atan2(worldCursor.y - e.center.y, worldCursor.x - e.center.x)
                    consider(
                        Point2D(e.center.x + e.radius * cos(ang), e.center.y + e.radius * sin(ang)),
                        OsnapType.NEAREST,
                        e.id
                    )
                    if (referencePoint != null) {
                        CadGeometry.tangentPointsToCircle(referencePoint, e.center, e.radius).forEach {
                            consider(it, OsnapType.TANGENT, e.id)
                        }
                    }
                }
                is CadEntity.Arc -> {
                    consider(e.center, OsnapType.CENTER, e.id)
                    val sRad = Math.toRadians(e.startAngleDeg)
                    val eRad = Math.toRadians(e.endAngleDeg)
                    consider(
                        Point2D(e.center.x + e.radius * cos(sRad), e.center.y + e.radius * sin(sRad)),
                        OsnapType.ENDPOINT,
                        e.id
                    )
                    consider(
                        Point2D(e.center.x + e.radius * cos(eRad), e.center.y + e.radius * sin(eRad)),
                        OsnapType.ENDPOINT,
                        e.id
                    )
                    val midDeg = e.startAngleDeg + CadGeometry.arcSweepDeg(e.startAngleDeg, e.endAngleDeg) * 0.5
                    val mRad = Math.toRadians(midDeg)
                    consider(
                        Point2D(e.center.x + e.radius * cos(mRad), e.center.y + e.radius * sin(mRad)),
                        OsnapType.MIDPOINT,
                        e.id
                    )
                    for (qDeg in listOf(0.0, 90.0, 180.0, 270.0)) {
                        if (CadGeometry.isAngleOnArc(qDeg, e.startAngleDeg, e.endAngleDeg)) {
                            val qr = Math.toRadians(qDeg)
                            consider(Point2D(e.center.x + e.radius * cos(qr), e.center.y + e.radius * sin(qr)), OsnapType.QUADRANT, e.id)
                        }
                    }
                    if (referencePoint != null) {
                        CadGeometry.tangentPointsToCircle(referencePoint, e.center, e.radius).forEach { tPt ->
                            val tDeg = CadGeometry.normalizeAngleDeg(Math.toDegrees(kotlin.math.atan2(tPt.y - e.center.y, tPt.x - e.center.x)))
                            if (CadGeometry.isAngleOnArc(tDeg, e.startAngleDeg, e.endAngleDeg)) {
                                consider(tPt, OsnapType.TANGENT, e.id)
                            }
                        }
                    }
                }
                is CadEntity.Point -> consider(e.position, OsnapType.ENDPOINT, e.id)
                is CadEntity.Ellipse -> consider(e.center, OsnapType.CENTER, e.id)
                is CadEntity.Spline -> {
                    val pts = CadGeometry.evaluateSplinePoints(e, 8)
                    pts.firstOrNull()?.let { consider(it, OsnapType.ENDPOINT, e.id) }
                    pts.lastOrNull()?.let { consider(it, OsnapType.ENDPOINT, e.id) }
                }
                else -> {}
            }
        }

        // Pairwise INTERSECTION snaps for nearby entities
        if (OsnapType.INTERSECTION in settings.modes && nearby.size in 2..80) {
            for (i in 0 until nearby.size - 1) {
                for (j in i + 1 until nearby.size) {
                    val ints = findEntityIntersections(nearby[i], nearby[j])
                    for (pt in ints) {
                        consider(pt, OsnapType.INTERSECTION, nearby[i].id)
                    }
                }
            }
        }

        if (candidates.isEmpty()) return null
        val priority = mapOf(
            OsnapType.ENDPOINT to 1,
            OsnapType.INTERSECTION to 2,
            OsnapType.CENTER to 3,
            OsnapType.MIDPOINT to 4,
            OsnapType.QUADRANT to 5,
            OsnapType.PERPENDICULAR to 6,
            OsnapType.TANGENT to 7,
            OsnapType.NEAREST to 8
        )
        return candidates.minWithOrNull(
            compareBy<SnapResult> { priority[it.type] ?: 99 }.thenBy { it.screenDistancePx }
        )
    }

    private fun toSegments(e: CadEntity): List<Pair<Point2D, Point2D>> = when (e) {
        is CadEntity.Line -> listOf(e.start to e.end)
        is CadEntity.LwPolyline -> {
            val v = e.vertices
            if (v.size < 2) emptyList() else {
                val count = if (e.closed) v.size else v.size - 1
                (0 until count).map { idx ->
                    Point2D(v[idx].x, v[idx].y) to Point2D(v[(idx + 1) % v.size].x, v[(idx + 1) % v.size].y)
                }
            }
        }
        else -> emptyList()
    }

    private fun findEntityIntersections(a: CadEntity, b: CadEntity): List<Point2D> {
        val segsA = toSegments(a)
        val segsB = toSegments(b)
        if (segsA.isNotEmpty() && segsB.isNotEmpty()) {
            val out = mutableListOf<Point2D>()
            for ((a1, a2) in segsA) {
                for ((b1, b2) in segsB) {
                    CadGeometry.intersectLineSegment(a1, a2, b1, b2)?.let { out.add(it) }
                }
            }
            return out
        }
        if (segsA.isNotEmpty() && b is CadEntity.Circle) {
            return segsA.flatMap { (p1, p2) -> CadGeometry.intersectSegmentCircle(p1, p2, b.center, b.radius) }
        }
        if (segsB.isNotEmpty() && a is CadEntity.Circle) {
            return segsB.flatMap { (p1, p2) -> CadGeometry.intersectSegmentCircle(p1, p2, a.center, a.radius) }
        }
        if (a is CadEntity.Circle && b is CadEntity.Circle) {
            return CadGeometry.intersectCircles(a.center, a.radius, b.center, b.radius)
        }
        return emptyList()
    }
}
