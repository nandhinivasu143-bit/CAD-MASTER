package com.cadmaster.offline.cad

import java.io.BufferedReader
import java.io.InputStream
import java.io.InputStreamReader
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

private data class RawBlock(
    val name: String,
    val baseX: Double,
    val baseY: Double,
    val entities: List<CadEntity>
)

private data class InsertRef(
    val blockName: String,
    val layer: String,
    val colorIndex: Int,
    val x: Double,
    val y: Double,
    val scaleX: Double,
    val scaleY: Double,
    val rotationDeg: Double
)

object DxfParser {
    private val ACAD_VERSIONS = mapOf(
        "AC1006" to "R10",
        "AC1009" to "R11/R12",
        "AC1012" to "R13",
        "AC1014" to "R14",
        "AC1015" to "AutoCAD 2000–2002",
        "AC1018" to "AutoCAD 2004–2006",
        "AC1021" to "AutoCAD 2007–2009",
        "AC1024" to "AutoCAD 2010–2012",
        "AC1027" to "AutoCAD 2013–2017",
        "AC1032" to "AutoCAD 2018–2025"
    )

    fun parseString(name: String, dxfText: String, sourceUri: String? = null): CadDocument {
        return parseStream(name, dxfText.byteInputStream(), sourceUri)
    }

    fun parseStream(
        name: String,
        inputStream: InputStream,
        sourceUri: String? = null,
        onProgress: ((Int) -> Unit)? = null
    ): CadDocument {
        val reader = BufferedReader(InputStreamReader(inputStream, Charsets.UTF_8), 65536)
        var versionCode = "UNKNOWN"
        var insUnits: Int? = null
        val layers = LinkedHashMap<String, CadLayer>()
        layers["0"] = CadLayer("0", 7, true, false)

        val blocks = LinkedHashMap<String, RawBlock>()
        val modelEntities = ArrayList<CadEntity>(512)
        val inserts = ArrayList<InsertRef>()

        var currentSection = ""
        var headerVar = ""
        var entityCount = 0

        // Current entity accumulators
        var inTableLayer = false
        var layerName = "0"
        var layerColor = 7
        var layerFlags = 0

        var inBlocks = false
        var currentBlockName = ""
        var currentBlockBaseX = 0.0
        var currentBlockBaseY = 0.0
        var currentBlockEntities = ArrayList<CadEntity>()

        var entityType = ""
        var entLayer = "0"
        var entColor = 256
        var entTrueColor: Long? = null
        var x1 = 0.0; var y1 = 0.0
        var x2 = 0.0; var y2 = 0.0
        var x3 = 0.0; var y3 = 0.0
        var x4 = 0.0; var y4 = 0.0
        var radius = 0.0
        var startAng = 0.0
        var endAng = 360.0
        var ratio = 1.0
        var startParam = 0.0
        var endParam = 2.0 * PI
        var textContent = ""
        var textHeight = 2.5
        var rotationDeg = 0.0
        var flags70 = 0
        var polyVertices = ArrayList<PolyVertex>()
        var currentVx = 0.0; var currentVy = 0.0; var currentBulge = 0.0
        var hasVertexStarted = false
        var inLegacyPolyline = false
        var legacyPolyLayer = "0"
        var legacyPolyColor = 256
        var legacyPolyClosed = false
        var legacyPolyVertices = ArrayList<PolyVertex>()

        // Spline accumulators
        var splineDegree = 3
        val splineKnots = ArrayList<Double>()
        val splineCtrlPts = ArrayList<Point2D>()
        val splineFitPts = ArrayList<Point2D>()
        var splineTempX: Double? = null
        var fitTempX: Double? = null

        // Insert accumulators
        var insertBlock = ""
        var insertSx = 1.0; var insertSy = 1.0; var insertRot = 0.0

        // Dimension text accumulators
        var dimType = 0
        var dimMeasurement: Double? = null

        var idSeq = 1

        fun nextId(prefix: String): String = "${prefix}_${idSeq++}"

        fun ensureLayer(lName: String, color: Int = 7) {
            if (lName.isNotBlank() && !layers.containsKey(lName)) {
                layers[lName] = CadLayer(lName, color, visible = true, locked = false)
            }
        }

        fun flushLegacyPolyline() {
            if (legacyPolyVertices.size >= 2) {
                val e = CadEntity.LwPolyline(
                    id = nextId("pl"),
                    layer = legacyPolyLayer,
                    colorIndex = legacyPolyColor,
                    vertices = legacyPolyVertices.toList(),
                    closed = legacyPolyClosed
                )
                ensureLayer(legacyPolyLayer)
                if (inBlocks && currentBlockName.isNotEmpty()) {
                    currentBlockEntities.add(e)
                } else {
                    modelEntities.add(e)
                }
            }
            inLegacyPolyline = false
            legacyPolyVertices.clear()
        }

        fun flushEntity() {
            if (entityType.isEmpty()) return
            if (hasVertexStarted) {
                polyVertices.add(PolyVertex(currentVx, currentVy, currentBulge))
                hasVertexStarted = false
            }

            if (entityType == "POLYLINE") {
                inLegacyPolyline = true
                legacyPolyLayer = entLayer
                legacyPolyColor = entColor
                legacyPolyClosed = (flags70 and 1) != 0
                legacyPolyVertices.clear()
            } else if (entityType == "VERTEX" && inLegacyPolyline) {
                legacyPolyVertices.add(PolyVertex(x1, y1, currentBulge))
            } else if (entityType == "SEQEND" && inLegacyPolyline) {
                flushLegacyPolyline()
            } else if (entityType == "INSERT") {
                if (insertBlock.isNotBlank()) {
                    ensureLayer(entLayer)
                    inserts.add(
                        InsertRef(
                            blockName = insertBlock,
                            layer = entLayer,
                            colorIndex = if (entColor == 256) 7 else entColor,
                            x = x1,
                            y = y1,
                            scaleX = if (insertSx == 0.0) 1.0 else insertSx,
                            scaleY = if (insertSy == 0.0) 1.0 else insertSy,
                            rotationDeg = insertRot
                        )
                    )
                }
            } else {
                val built: CadEntity? = when (entityType) {
                    "LINE" -> CadEntity.Line(
                        id = nextId("ln"),
                        layer = entLayer,
                        colorIndex = entColor,
                        trueColor = entTrueColor,
                        start = Point2D(x1, y1),
                        end = Point2D(x2, y2)
                    )
                    "LWPOLYLINE" -> if (polyVertices.size >= 2) {
                        CadEntity.LwPolyline(
                            id = nextId("lw"),
                            layer = entLayer,
                            colorIndex = entColor,
                            trueColor = entTrueColor,
                            vertices = polyVertices.toList(),
                            closed = (flags70 and 1) != 0
                        )
                    } else null
                    "CIRCLE" -> if (radius > 0.0) {
                        CadEntity.Circle(
                            id = nextId("cr"),
                            layer = entLayer,
                            colorIndex = entColor,
                            trueColor = entTrueColor,
                            center = Point2D(x1, y1),
                            radius = radius
                        )
                    } else null
                    "ARC" -> if (radius > 0.0) {
                        CadEntity.Arc(
                            id = nextId("ar"),
                            layer = entLayer,
                            colorIndex = entColor,
                            trueColor = entTrueColor,
                            center = Point2D(x1, y1),
                            radius = radius,
                            startAngleDeg = startAng,
                            endAngleDeg = endAng
                        )
                    } else null
                    "ELLIPSE" -> {
                        val majorLen = kotlin.math.hypot(x2, y2)
                        if (majorLen > 0.0) {
                            CadEntity.Ellipse(
                                id = nextId("el"),
                                layer = entLayer,
                                colorIndex = entColor,
                                trueColor = entTrueColor,
                                center = Point2D(x1, y1),
                                majorAxisEnd = Point2D(x2, y2),
                                ratio = ratio.coerceAtLeast(0.01),
                                startParam = startParam,
                                endParam = endParam
                            )
                        } else null
                    }
                    "SPLINE" -> if (splineCtrlPts.size >= 2 || splineFitPts.size >= 2) {
                        CadEntity.Spline(
                            id = nextId("sp"),
                            layer = entLayer,
                            colorIndex = entColor,
                            trueColor = entTrueColor,
                            degree = splineDegree,
                            controlPoints = splineCtrlPts.toList(),
                            knots = splineKnots.toList(),
                            fitPoints = splineFitPts.toList(),
                            closed = (flags70 and 1) != 0
                        )
                    } else null
                    "TEXT", "MTEXT" -> {
                        val cleaned = cleanMtext(textContent)
                        if (cleaned.isNotEmpty()) {
                            CadEntity.Text(
                                id = nextId("tx"),
                                layer = entLayer,
                                colorIndex = entColor,
                                trueColor = entTrueColor,
                                position = Point2D(x1, y1),
                                content = cleaned,
                                height = textHeight.coerceAtLeast(0.5),
                                rotationDeg = rotationDeg
                            )
                        } else null
                    }
                    "POINT" -> CadEntity.Point(
                        id = nextId("pt"),
                        layer = entLayer,
                        colorIndex = entColor,
                        trueColor = entTrueColor,
                        position = Point2D(x1, y1)
                    )
                    "SOLID", "3DFACE" -> CadEntity.LwPolyline(
                        id = nextId("sf"),
                        layer = entLayer,
                        colorIndex = entColor,
                        trueColor = entTrueColor,
                        vertices = listOf(PolyVertex(x1, y1), PolyVertex(x2, y2), PolyVertex(x3, y3), PolyVertex(x4, y4)),
                        closed = true
                    )
                    "DIMENSION" -> {
                        val kind = when (dimType and 7) {
                            1 -> DimensionKind.ALIGNED
                            2 -> DimensionKind.ANGULAR
                            3 -> DimensionKind.DIAMETER
                            4 -> DimensionKind.RADIUS
                            6 -> DimensionKind.ORDINATE
                            else -> DimensionKind.LINEAR
                        }
                        val pA = Point2D(x3, y3)
                        val pB = Point2D(x4, y4)
                        val def = Point2D(x1, y1)
                        val valMeas = dimMeasurement ?: CadGeometry.dist(pA, pB)
                        CadEntity.Dimension(
                            id = nextId("dm"),
                            layer = entLayer,
                            colorIndex = entColor,
                            kind = kind,
                            points = listOf(pA, pB),
                            defPoint = def,
                            measuredValue = valMeas,
                            textOverride = textContent.takeIf { it.isNotBlank() && it != "<>" }
                        )
                    }
                    else -> null
                }

                if (built != null) {
                    ensureLayer(entLayer)
                    if (inBlocks && currentBlockName.isNotEmpty()) {
                        currentBlockEntities.add(built)
                    } else {
                        modelEntities.add(built)
                        entityCount++
                        if (entityCount % 500 == 0) onProgress?.invoke(entityCount)
                    }
                }
            }

            // Reset entity state
            entityType = ""
            entLayer = "0"
            entColor = 256
            entTrueColor = null
            x1 = 0.0; y1 = 0.0; x2 = 0.0; y2 = 0.0; x3 = 0.0; y3 = 0.0; x4 = 0.0; y4 = 0.0
            radius = 0.0; startAng = 0.0; endAng = 360.0
            ratio = 1.0; startParam = 0.0; endParam = 2.0 * PI
            textContent = ""; textHeight = 2.5; rotationDeg = 0.0
            flags70 = 0
            polyVertices.clear()
            currentVx = 0.0; currentVy = 0.0; currentBulge = 0.0; hasVertexStarted = false
            splineDegree = 3; splineKnots.clear(); splineCtrlPts.clear(); splineFitPts.clear()
            splineTempX = null; fitTempX = null
            insertBlock = ""; insertSx = 1.0; insertSy = 1.0; insertRot = 0.0
            dimType = 0; dimMeasurement = null
        }

        while (true) {
            val codeLine = reader.readLine() ?: break
            val valLine = reader.readLine() ?: break
            val code = codeLine.trim().toIntOrNull() ?: continue
            val value = valLine.trim()

            if (code == 0) {
                // Flush pending table/entity/block transitions
                if (inTableLayer && value != "LAYER") {
                    if (layerName.isNotBlank()) {
                        layers[layerName] = CadLayer(
                            name = layerName,
                            colorIndex = kotlin.math.abs(layerColor).coerceAtLeast(1),
                            visible = layerColor >= 0 && (layerFlags and 1) == 0,
                            locked = (layerFlags and 4) != 0
                        )
                    }
                    inTableLayer = false
                }
                flushEntity()

                when (value) {
                    "SECTION" -> { currentSection = "" }
                    "ENDSEC" -> {
                        if (inLegacyPolyline) flushLegacyPolyline()
                        currentSection = ""
                        inBlocks = false
                    }
                    "EOF" -> break
                    "LAYER" -> {
                        if (currentSection == "TABLES") {
                            inTableLayer = true
                            layerName = "0"; layerColor = 7; layerFlags = 0
                        }
                    }
                    "BLOCK" -> {
                        if (currentSection == "BLOCKS") {
                            inBlocks = true
                            currentBlockName = ""
                            currentBlockBaseX = 0.0
                            currentBlockBaseY = 0.0
                            currentBlockEntities = ArrayList()
                        }
                    }
                    "ENDBLK" -> {
                        if (inBlocks && currentBlockName.isNotEmpty()) {
                            blocks[currentBlockName] = RawBlock(
                                name = currentBlockName,
                                baseX = currentBlockBaseX,
                                baseY = currentBlockBaseY,
                                entities = currentBlockEntities.toList()
                            )
                        }
                        inBlocks = false
                        currentBlockName = ""
                    }
                    else -> {
                        if (currentSection == "ENTITIES" || inBlocks) {
                            entityType = value
                        }
                    }
                }
                continue
            }

            if (code == 2 && currentSection.isEmpty()) {
                currentSection = value.uppercase()
                continue
            }

            when (currentSection) {
                "HEADER" -> {
                    if (code == 9) headerVar = value
                    else if (headerVar == "\$ACADVER" && code == 1) versionCode = value
                    else if (headerVar == "\$INSUNITS" && code == 70) insUnits = value.toIntOrNull()
                }
                "TABLES" -> {
                    if (inTableLayer) {
                        when (code) {
                            2 -> layerName = value
                            62 -> layerColor = value.toIntOrNull() ?: 7
                            70 -> layerFlags = value.toIntOrNull() ?: 0
                        }
                    }
                }
                "BLOCKS", "ENTITIES" -> {
                    if (inBlocks && entityType.isEmpty()) {
                        when (code) {
                            2 -> currentBlockName = value
                            10 -> currentBlockBaseX = value.toDoubleOrNull() ?: 0.0
                            20 -> currentBlockBaseY = value.toDoubleOrNull() ?: 0.0
                        }
                    } else if (entityType.isNotEmpty()) {
                        when (code) {
                            8 -> entLayer = value.ifBlank { "0" }
                            62 -> entColor = value.toIntOrNull() ?: 256
                            420 -> entTrueColor = value.toLongOrNull()
                            70 -> if (entityType == "DIMENSION") dimType = value.toIntOrNull() ?: 0 else flags70 = value.toIntOrNull() ?: 0
                            71 -> if (entityType == "SPLINE") splineDegree = value.toIntOrNull() ?: 3
                            1 -> textContent = value
                            3 -> if (entityType == "MTEXT") textContent += value
                            2 -> if (entityType == "INSERT") insertBlock = value
                            10 -> {
                                val d = value.toDoubleOrNull() ?: 0.0
                                if (entityType == "LWPOLYLINE") {
                                    if (hasVertexStarted) polyVertices.add(PolyVertex(currentVx, currentVy, currentBulge))
                                    currentVx = d; currentVy = 0.0; currentBulge = 0.0; hasVertexStarted = true
                                } else if (entityType == "SPLINE") {
                                    splineTempX = d
                                } else {
                                    x1 = d
                                }
                            }
                            20 -> {
                                val d = value.toDoubleOrNull() ?: 0.0
                                if (entityType == "LWPOLYLINE") {
                                    currentVy = d
                                } else if (entityType == "SPLINE") {
                                    val sx = splineTempX ?: 0.0
                                    splineCtrlPts.add(Point2D(sx, d))
                                    splineTempX = null
                                } else {
                                    y1 = d
                                }
                            }
                            11 -> {
                                val d = value.toDoubleOrNull() ?: 0.0
                                if (entityType == "SPLINE") fitTempX = d else x2 = d
                            }
                            21 -> {
                                val d = value.toDoubleOrNull() ?: 0.0
                                if (entityType == "SPLINE") {
                                    fitTempX?.let { splineFitPts.add(Point2D(it, d)) }
                                    fitTempX = null
                                } else y2 = d
                            }
                            12 -> x3 = value.toDoubleOrNull() ?: 0.0
                            22 -> y3 = value.toDoubleOrNull() ?: 0.0
                            13 -> x3 = value.toDoubleOrNull() ?: 0.0
                            23 -> y3 = value.toDoubleOrNull() ?: 0.0
                            14 -> x4 = value.toDoubleOrNull() ?: 0.0
                            24 -> y4 = value.toDoubleOrNull() ?: 0.0
                            40 -> {
                                val d = value.toDoubleOrNull() ?: 0.0
                                when (entityType) {
                                    "SPLINE" -> splineKnots.add(d)
                                    "ELLIPSE" -> ratio = d
                                    "TEXT", "MTEXT" -> textHeight = d
                                    else -> radius = d
                                }
                            }
                            41 -> if (entityType == "INSERT") insertSx = value.toDoubleOrNull() ?: 1.0
                                  else if (entityType == "ELLIPSE") startParam = value.toDoubleOrNull() ?: 0.0
                            42 -> if (entityType == "LWPOLYLINE" || entityType == "VERTEX") currentBulge = value.toDoubleOrNull() ?: 0.0
                                  else if (entityType == "INSERT") insertSy = value.toDoubleOrNull() ?: 1.0
                                  else if (entityType == "ELLIPSE") endParam = value.toDoubleOrNull() ?: (2.0 * PI)
                                  else if (entityType == "DIMENSION") dimMeasurement = value.toDoubleOrNull()
                            50 -> if (entityType == "INSERT") insertRot = value.toDoubleOrNull() ?: 0.0
                                  else if (entityType == "TEXT" || entityType == "MTEXT") rotationDeg = value.toDoubleOrNull() ?: 0.0
                                  else startAng = value.toDoubleOrNull() ?: 0.0
                            51 -> endAng = value.toDoubleOrNull() ?: 360.0
                        }
                    }
                }
            }
        }

        // Expand INSERT block references into world entities
        for (ins in inserts) {
            val blk = blocks[ins.blockName] ?: continue
            val rad = Math.toRadians(ins.rotationDeg)
            val cosR = cos(rad)
            val sinR = sin(rad)
            fun xform(pt: Point2D): Point2D {
                val lx = (pt.x - blk.baseX) * ins.scaleX
                val ly = (pt.y - blk.baseY) * ins.scaleY
                return Point2D(
                    ins.x + lx * cosR - ly * sinR,
                    ins.y + lx * sinR + ly * cosR
                )
            }
            for (be in blk.entities) {
                val layerUse = if (be.layer == "0") ins.layer else be.layer
                val colUse = if (be.colorIndex == 0 || be.colorIndex == 256) ins.colorIndex else be.colorIndex
                val expanded: CadEntity? = when (be) {
                    is CadEntity.Line -> be.copy(id = nextId("bi"), layer = layerUse, colorIndex = colUse, start = xform(be.start), end = xform(be.end))
                    is CadEntity.LwPolyline -> be.copy(
                        id = nextId("bp"),
                        layer = layerUse,
                        colorIndex = colUse,
                        vertices = be.vertices.map {
                            val t = xform(Point2D(it.x, it.y))
                            PolyVertex(t.x, t.y, it.bulge)
                        }
                    )
                    is CadEntity.Circle -> be.copy(
                        id = nextId("bc"),
                        layer = layerUse,
                        colorIndex = colUse,
                        center = xform(be.center),
                        radius = be.radius * kotlin.math.abs(ins.scaleX)
                    )
                    is CadEntity.Arc -> be.copy(
                        id = nextId("ba"),
                        layer = layerUse,
                        colorIndex = colUse,
                        center = xform(be.center),
                        radius = be.radius * kotlin.math.abs(ins.scaleX),
                        startAngleDeg = be.startAngleDeg + ins.rotationDeg,
                        endAngleDeg = be.endAngleDeg + ins.rotationDeg
                    )
                    is CadEntity.Text -> be.copy(
                        id = nextId("bt"),
                        layer = layerUse,
                        colorIndex = colUse,
                        position = xform(be.position),
                        rotationDeg = be.rotationDeg + ins.rotationDeg
                    )
                    else -> null
                }
                if (expanded != null) modelEntities.add(expanded)
            }
        }

        if (modelEntities.isEmpty()) {
            throw IllegalArgumentException(
                "No supported 2D CAD geometry found in '$name'. Ensure the file is a valid ASCII DXF (AC1009–AC1032)."
            )
        }

        val detected = CadUnits.fromDxfInsUnits(insUnits)
        val effectiveUnit = if (detected == CadUnit.UNDEFINED) CadUnit.MM else detected
        val versionLabel = ACAD_VERSIONS[versionCode] ?: if (versionCode == "UNKNOWN") "DXF ASCII" else "DXF ($versionCode)"

        return CadDocument(
            name = name,
            format = "DXF",
            versionCode = versionCode,
            versionLabel = versionLabel,
            detectedUnit = detected,
            unit = effectiveUnit,
            layers = layers.values.toList(),
            entities = modelEntities,
            sourceUri = sourceUri
        )
    }

    private fun cleanMtext(raw: String): String {
        return raw
            .replace("\\\\P", "\n")
            .replace("\\P", "\n")
            .replace(Regex("\\\\[A-Za-z][^;]*;"), "")
            .replace("{", "")
            .replace("}", "")
            .trim()
    }
}
