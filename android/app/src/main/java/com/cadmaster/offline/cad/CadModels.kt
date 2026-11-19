package com.cadmaster.offline.cad

import kotlin.math.PI

enum class CadUnit(val code: String, val label: String) {
    MM("mm", "Millimeters"),
    CM("cm", "Centimeters"),
    M("m", "Meters"),
    IN("in", "Inches"),
    FT("ft", "Feet"),
    UNDEFINED("units", "Drawing Units")
}

enum class UnitFormat(val label: String) {
    DECIMAL("Decimal"),
    ARCHITECTURAL("Architectural"),
    ENGINEERING("Engineering"),
    FRACTIONAL("Fractional")
}

enum class OsnapType(val label: String, val shortCode: String) {
    ENDPOINT("Endpoint", "END"),
    MIDPOINT("Midpoint", "MID"),
    CENTER("Center", "CEN"),
    INTERSECTION("Intersection", "INT"),
    NEAREST("Nearest", "NEA"),
    PERPENDICULAR("Perpendicular", "PER"),
    TANGENT("Tangent", "TAN"),
    QUADRANT("Quadrant", "QUA")
}

data class OsnapSettings(
    val enabled: Boolean = true,
    val snapRadiusPx: Float = 44f,
    val modes: Set<OsnapType> = setOf(
        OsnapType.ENDPOINT,
        OsnapType.MIDPOINT,
        OsnapType.CENTER,
        OsnapType.INTERSECTION,
        OsnapType.QUADRANT,
        OsnapType.PERPENDICULAR,
        OsnapType.TANGENT,
        OsnapType.NEAREST
    )
)

data class Point2D(val x: Double, val y: Double)

data class BoundingBox(
    val minX: Double,
    val minY: Double,
    val maxX: Double,
    val maxY: Double
) {
    val width: Double get() = maxX - minX
    val height: Double get() = maxY - minY
    val center: Point2D get() = Point2D((minX + maxX) * 0.5, (minY + maxY) * 0.5)

    fun overlaps(other: BoundingBox): Boolean {
        return maxX >= other.minX && minX <= other.maxX && maxY >= other.minY && minY <= other.maxY
    }
}

data class SnapResult(
    val point: Point2D,
    val type: OsnapType,
    val entityId: String,
    val screenDistancePx: Double
)

data class CadLayer(
    val name: String,
    val colorIndex: Int = 7,
    val visible: Boolean = true,
    val locked: Boolean = false
)

enum class DimensionKind(val label: String, val shortLabel: String, val hint: String) {
    POINT_TO_POINT("Point-to-Point", "Pt-Pt", "Tap 2 points for distance"),
    HORIZONTAL("Horizontal (ΔX)", "Horiz", "Tap 2 points for X distance"),
    VERTICAL("Vertical (ΔY)", "Vert", "Tap 2 points for Y distance"),
    ALIGNED("Aligned Distance", "Aligned", "Tap 2 points along span"),
    ANGULAR("Angle (3 Points)", "Angle", "Tap vertex, ray 1, then ray 2"),
    RADIUS("Radius", "Radius", "Tap any circle or arc"),
    DIAMETER("Diameter", "Diameter", "Tap any circle or arc"),
    ARC_LENGTH("Arc Length", "Arc Len", "Tap any arc"),
    AREA("Area Check", "Area", "Tap closed shape or trace corners"),
    PERIMETER("Perimeter Check", "Perim", "Tap closed shape or trace corners"),
    POLYLINE_LENGTH("Polyline Total", "Poly Len", "Tap any polyline for total length"),
    LINEAR("Linear Dimension", "Linear", "Tap 2 points"),
    ORDINATE("Ordinate", "Ordinate", "Tap point for X/Y coordinate")
}

enum class ToolId(val label: String) {
    SELECT("Select"),
    PAN("Pan"),
    MEASURE("Line Length"),
    DIMENSION("Measure")
}

data class DimensionStyleConfig(
    val textHeightPx: Float = 13f,
    val arrowSizePx: Float = 10f,
    val precision: Int = 2,
    val unitFormat: UnitFormat = UnitFormat.DECIMAL,
    val colorHex: Long = 0xFF38BDF8,
    val measurementScale: Double = 1.0,
    val textAboveLine: Boolean = true,
    val displayUnit: CadUnit? = null
)

data class PolyVertex(
    val x: Double,
    val y: Double,
    val bulge: Double = 0.0
)

sealed class CadEntity {
    abstract val id: String
    abstract val layer: String
    abstract val colorIndex: Int
    abstract val trueColor: Long?

    data class Line(
        override val id: String,
        override val layer: String,
        override val colorIndex: Int = 256,
        override val trueColor: Long? = null,
        val start: Point2D,
        val end: Point2D
    ) : CadEntity()

    data class LwPolyline(
        override val id: String,
        override val layer: String,
        override val colorIndex: Int = 256,
        override val trueColor: Long? = null,
        val vertices: List<PolyVertex>,
        val closed: Boolean = false
    ) : CadEntity()

    data class Circle(
        override val id: String,
        override val layer: String,
        override val colorIndex: Int = 256,
        override val trueColor: Long? = null,
        val center: Point2D,
        val radius: Double
    ) : CadEntity()

    data class Arc(
        override val id: String,
        override val layer: String,
        override val colorIndex: Int = 256,
        override val trueColor: Long? = null,
        val center: Point2D,
        val radius: Double,
        val startAngleDeg: Double,
        val endAngleDeg: Double
    ) : CadEntity()

    data class Ellipse(
        override val id: String,
        override val layer: String,
        override val colorIndex: Int = 256,
        override val trueColor: Long? = null,
        val center: Point2D,
        val majorAxisEnd: Point2D,
        val ratio: Double,
        val startParam: Double = 0.0,
        val endParam: Double = 2.0 * PI
    ) : CadEntity()

    data class Spline(
        override val id: String,
        override val layer: String,
        override val colorIndex: Int = 256,
        override val trueColor: Long? = null,
        val degree: Int = 3,
        val controlPoints: List<Point2D>,
        val knots: List<Double> = emptyList(),
        val fitPoints: List<Point2D> = emptyList(),
        val closed: Boolean = false
    ) : CadEntity()

    data class Text(
        override val id: String,
        override val layer: String,
        override val colorIndex: Int = 256,
        override val trueColor: Long? = null,
        val position: Point2D,
        val content: String,
        val height: Double = 2.5,
        val rotationDeg: Double = 0.0
    ) : CadEntity()

    data class Point(
        override val id: String,
        override val layer: String,
        override val colorIndex: Int = 256,
        override val trueColor: Long? = null,
        val position: Point2D
    ) : CadEntity()

    data class Dimension(
        override val id: String,
        override val layer: String = "0",
        override val colorIndex: Int = 4,
        override val trueColor: Long? = null,
        val kind: DimensionKind,
        val points: List<Point2D>,
        val defPoint: Point2D? = null,
        val radius: Double? = null,
        val startAngleDeg: Double? = null,
        val endAngleDeg: Double? = null,
        val measuredValue: Double,
        val textOverride: String? = null,
        val customColor: Long? = null
    ) : CadEntity()
}

data class PolylineSegmentInfo(
    val index: Int,
    val start: Point2D,
    val end: Point2D,
    val length: Double,
    val angleDeg: Double,
    val dx: Double,
    val dy: Double,
    val isArc: Boolean = false
)

data class EntityMeasurement(
    val entityId: String,
    val entityType: String,
    val layer: String,
    val primaryLabel: String,
    val primaryValue: Double,
    val isArea: Boolean = false,
    val start: Point2D? = null,
    val end: Point2D? = null,
    val center: Point2D? = null,
    val angleDeg: Double? = null,
    val dx: Double? = null,
    val dy: Double? = null,
    val radius: Double? = null,
    val diameter: Double? = null,
    val circumferenceOrArea: Double? = null,
    val segments: List<PolylineSegmentInfo> = emptyList(),
    val selectedSegmentIndex: Int? = null
)

data class ViewportState(
    val offsetX: Double = 0.0,
    val offsetY: Double = 0.0,
    val scale: Double = 1.0
)

data class CadDocument(
    val name: String,
    val format: String,
    val versionCode: String,
    val versionLabel: String,
    val detectedUnit: CadUnit,
    val unit: CadUnit,
    val layers: List<CadLayer>,
    val entities: List<CadEntity>,
    val sourceUri: String? = null
)
