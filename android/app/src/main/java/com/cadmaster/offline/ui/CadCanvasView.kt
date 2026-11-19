package com.cadmaster.offline.ui

import android.graphics.Paint
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import com.cadmaster.offline.CadUiState
import com.cadmaster.offline.CadViewModel
import com.cadmaster.offline.cad.*
import kotlin.math.*

@Composable
fun CadCanvasView(
    state: CadUiState,
    onSizeChanged: (Float, Float) -> Unit,
    onTap: (Float, Float) -> Unit,
    onCursorMove: (Float, Float) -> Unit,
    onTransform: (panX: Float, panY: Float, zoom: Float, cx: Float, cy: Float) -> Unit,
    modifier: Modifier = Modifier
) {
    val bgColor = if (state.darkBackground) Color(0xFF000000) else Color(0xFFFFFFFF)

    val dimTextPaint = remember {
        Paint(Paint.ANTI_ALIAS_FLAG).apply {
            textAlign = Paint.Align.CENTER
            isFakeBoldText = true
        }
    }
    val cadTextPaint = remember { Paint(Paint.ANTI_ALIAS_FLAG) }

    Canvas(
        modifier = modifier
            .fillMaxSize()
            .background(bgColor)
            .onSizeChanged { size ->
                onSizeChanged(size.width.toFloat(), size.height.toFloat())
            }
            .pointerInput(state.activeTool, state.activeDimensionKind) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    val downPos = down.position
                    var movedTotal = 0f
                    var multiTouch = false

                    onCursorMove(downPos.x, downPos.y)

                    do {
                        val event = awaitPointerEvent()
                        val pressed = event.changes.count { it.pressed }
                        if (pressed >= 2) {
                            multiTouch = true
                            val zoom = event.calculateZoom()
                            val pan = event.calculatePan()
                            val centroid = event.calculateCentroid(useCurrent = true)
                            if (zoom != 1f || pan != Offset.Zero) {
                                onTransform(pan.x, pan.y, zoom, centroid.x, centroid.y)
                                event.changes.forEach { it.consume() }
                            }
                        } else if (pressed == 1) {
                            val ch = event.changes.first()
                            val delta = ch.position - ch.previousPosition
                            movedTotal += delta.getDistance()
                            if (state.activeTool == ToolId.PAN || movedTotal > 18f) {
                                onTransform(delta.x, delta.y, 1f, ch.position.x, ch.position.y)
                                ch.consume()
                            } else {
                                onCursorMove(ch.position.x, ch.position.y)
                            }
                        }
                    } while (event.changes.any { it.pressed })

                    if (!multiTouch && movedTotal < 18f && state.activeTool != ToolId.PAN) {
                        onTap(downPos.x, downPos.y)
                    }
                }
            }
    ) {
        val vp = state.viewport
        fun wx(x: Double): Float = (vp.offsetX + x * vp.scale).toFloat()
        fun wy(y: Double): Float = (vp.offsetY - y * vp.scale).toFloat()

        val worldLeft = (0.0 - vp.offsetX) / vp.scale
        val worldRight = (size.width - vp.offsetX) / vp.scale
        val worldBottom = (vp.offsetY - size.height) / vp.scale
        val worldTop = vp.offsetY / vp.scale
        val viewBox = BoundingBox(
            min(worldLeft, worldRight),
            min(worldBottom, worldTop),
            max(worldLeft, worldRight),
            max(worldBottom, worldTop)
        )

        if (state.gridVisible) {
            drawCadGrid(viewBox, vp, state.darkBackground, ::wx, ::wy)
        }

        // UCS Origin Axes
        val ox = wx(0.0)
        val oy = wy(0.0)
        drawLine(Color(0xFFEF4444).copy(alpha = 0.5f), Offset(ox, oy), Offset(ox + 32f, oy), strokeWidth = 1.8f)
        drawLine(Color(0xFF22C55E).copy(alpha = 0.5f), Offset(ox, oy), Offset(ox, oy - 32f), strokeWidth = 1.8f)

        val visibleLayers = state.document.layers.filter { it.visible }.map { it.name }.toSet()
        val layerColorMap = state.document.layers.associate { it.name to it.colorIndex }
        val highlightColor = Color(0xFFFACC15)

        // Render drawing entities + user check dimensions
        val allEntities = state.document.entities + state.checkDimensions
        for (e in allEntities) {
            val isCheckDim = e is CadEntity.Dimension && e.id.startsWith("chk_")
            if (!isCheckDim && e.layer !in visibleLayers) continue
            val bounds = CadGeometry.getEntityBounds(e)
            if (!isCheckDim && !bounds.overlaps(viewBox)) continue

            val isSelected = e.id == state.selectedEntityId
            val layerColorIdx = layerColorMap[e.layer] ?: 7
            val resolvedHex = AciColors.resolveColor(e.colorIndex, e.trueColor, layerColorIdx, state.darkBackground)
            val baseColor = if (isSelected) highlightColor else Color(resolvedHex)
            val strokeW = if (isSelected) 4.2f else 1.8f

            when (e) {
                is CadEntity.Line -> {
                    drawLine(baseColor, Offset(wx(e.start.x), wy(e.start.y)), Offset(wx(e.end.x), wy(e.end.y)), strokeWidth = strokeW, cap = StrokeCap.Round)
                }
                is CadEntity.LwPolyline -> {
                    val v = e.vertices
                    if (v.size >= 2) {
                        val count = if (e.closed) v.size else v.size - 1
                        for (i in 0 until count) {
                            val a = Point2D(v[i].x, v[i].y)
                            val b = Point2D(v[(i + 1) % v.size].x, v[(i + 1) % v.size].y)
                            val segHighlight = isSelected && state.selectedSegmentIndex == i
                            val segColor = if (segHighlight) Color(0xFF38BDF8) else baseColor
                            val segWidth = if (segHighlight) 6.0f else strokeW
                            val bulgeArc = CadGeometry.bulgeToArc(a, b, v[i].bulge)
                            if (bulgeArc != null) {
                                val rPx = (bulgeArc.radius * vp.scale).toFloat()
                                val cx = wx(bulgeArc.center.x)
                                val cy = wy(bulgeArc.center.y)
                                val startDegScreen = -Math.toDegrees(bulgeArc.startAngleRad).toFloat()
                                val endDegScreen = -Math.toDegrees(bulgeArc.endAngleRad).toFloat()
                                var sweep = endDegScreen - startDegScreen
                                if (bulgeArc.ccw) {
                                    if (sweep > 0f) sweep -= 360f
                                } else {
                                    if (sweep < 0f) sweep += 360f
                                }
                                drawArc(
                                    color = segColor,
                                    startAngle = startDegScreen,
                                    sweepAngle = sweep,
                                    useCenter = false,
                                    topLeft = Offset(cx - rPx, cy - rPx),
                                    size = Size(rPx * 2f, rPx * 2f),
                                    style = Stroke(width = segWidth)
                                )
                            } else {
                                drawLine(segColor, Offset(wx(a.x), wy(a.y)), Offset(wx(b.x), wy(b.y)), strokeWidth = segWidth, cap = StrokeCap.Round)
                            }
                        }
                    }
                }
                is CadEntity.Circle -> {
                    val rPx = (e.radius * vp.scale).toFloat()
                    if (rPx >= 0.6f) {
                        drawCircle(baseColor, rPx, Offset(wx(e.center.x), wy(e.center.y)), style = Stroke(width = strokeW))
                    }
                }
                is CadEntity.Arc -> {
                    val rPx = (e.radius * vp.scale).toFloat()
                    if (rPx >= 0.6f) {
                        val cx = wx(e.center.x)
                        val cy = wy(e.center.y)
                        val sweep = CadGeometry.arcSweepDeg(e.startAngleDeg, e.endAngleDeg).toFloat()
                        drawArc(
                            color = baseColor,
                            startAngle = -e.startAngleDeg.toFloat(),
                            sweepAngle = -sweep,
                            useCenter = false,
                            topLeft = Offset(cx - rPx, cy - rPx),
                            size = Size(rPx * 2f, rPx * 2f),
                            style = Stroke(width = strokeW)
                        )
                    }
                }
                is CadEntity.Ellipse -> drawPolylinePath(CadGeometry.evaluateEllipsePoints(e, 48), baseColor, strokeW, ::wx, ::wy)
                is CadEntity.Spline -> drawPolylinePath(CadGeometry.evaluateSplinePoints(e, 14), baseColor, strokeW, ::wx, ::wy)
                is CadEntity.Text -> {
                    val pxSize = (e.height * vp.scale).toFloat().coerceIn(8f, 64f)
                    cadTextPaint.color = android.graphics.Color.argb(
                        (baseColor.alpha * 255).toInt(),
                        (baseColor.red * 255).toInt(),
                        (baseColor.green * 255).toInt(),
                        (baseColor.blue * 255).toInt()
                    )
                    cadTextPaint.textSize = pxSize
                    drawContext.canvas.nativeCanvas.save()
                    val sx = wx(e.position.x)
                    val sy = wy(e.position.y)
                    drawContext.canvas.nativeCanvas.rotate(-e.rotationDeg.toFloat(), sx, sy)
                    drawContext.canvas.nativeCanvas.drawText(e.content, sx, sy, cadTextPaint)
                    drawContext.canvas.nativeCanvas.restore()
                }
                is CadEntity.Point -> {
                    val px = wx(e.position.x)
                    val py = wy(e.position.y)
                    drawLine(baseColor, Offset(px - 6f, py), Offset(px + 6f, py), strokeWidth = 2f)
                    drawLine(baseColor, Offset(px, py - 6f), Offset(px, py + 6f), strokeWidth = 2f)
                }
                is CadEntity.Dimension -> drawCadDimension(e, state, isSelected, dimTextPaint, ::wx, ::wy)
            }
        }

        // Pending Check Dimension Preview
        if (state.pendingPoints.isNotEmpty()) {
            val previewColor = Color(0xFF38BDF8)
            val allPts = state.pendingPoints + listOfNotNull(state.crosshairWorld)
            for (i in 0 until allPts.size - 1) {
                drawLine(
                    color = previewColor,
                    start = Offset(wx(allPts[i].x), wy(allPts[i].y)),
                    end = Offset(wx(allPts[i + 1].x), wy(allPts[i + 1].y)),
                    strokeWidth = 2.5f,
                    pathEffect = PathEffect.dashPathEffect(floatArrayOf(12f, 8f))
                )
            }
            for (pt in state.pendingPoints) {
                drawCircle(previewColor, 7f, Offset(wx(pt.x), wy(pt.y)))
            }
        }

        // Crosshair + OSNAP marker
        state.crosshairWorld?.let { ch ->
            val sx = wx(ch.x)
            val sy = wy(ch.y)
            val crossCol = if (state.darkBackground) Color.White.copy(alpha = 0.4f) else Color.Black.copy(alpha = 0.4f)
            drawLine(crossCol, Offset(0f, sy), Offset(size.width, sy), strokeWidth = 1f)
            drawLine(crossCol, Offset(sx, 0f), Offset(sx, size.height), strokeWidth = 1f)
        }

        state.activeSnap?.let { snap ->
            val sx = wx(snap.point.x)
            val sy = wy(snap.point.y)
            val snapCol = Color(0xFF22C55E)
            when (snap.type) {
                OsnapType.ENDPOINT -> drawRect(snapCol, Offset(sx - 10f, sy - 10f), Size(20f, 20f), style = Stroke(2.5f))
                OsnapType.MIDPOINT -> {
                    val p = Path().apply {
                        moveTo(sx, sy - 12f)
                        lineTo(sx - 11f, sy + 9f)
                        lineTo(sx + 11f, sy + 9f)
                        close()
                    }
                    drawPath(p, snapCol, style = Stroke(2.5f))
                }
                OsnapType.CENTER -> drawCircle(snapCol, 11f, Offset(sx, sy), style = Stroke(2.5f))
                OsnapType.INTERSECTION -> {
                    drawLine(snapCol, Offset(sx - 10f, sy - 10f), Offset(sx + 10f, sy + 10f), strokeWidth = 2.8f)
                    drawLine(snapCol, Offset(sx + 10f, sy - 10f), Offset(sx - 10f, sy + 10f), strokeWidth = 2.8f)
                }
                else -> drawCircle(snapCol, 9f, Offset(sx, sy), style = Stroke(2.5f))
            }
        }
    }
}

private fun DrawScope.drawCadGrid(
    viewBox: BoundingBox,
    vp: ViewportState,
    darkBg: Boolean,
    wx: (Double) -> Float,
    wy: (Double) -> Float
) {
    val targetPx = 48.0
    val rawStep = targetPx / vp.scale
    val pow10 = 10.0.pow(floor(log10(rawStep.coerceAtLeast(1e-6))))
    val step = when {
        rawStep / pow10 < 2.0 -> pow10
        rawStep / pow10 < 5.0 -> 2.0 * pow10
        else -> 5.0 * pow10
    }
    val minorColor = if (darkBg) Color(0xFF141B24) else Color(0xFFE2E8F0)
    val majorColor = if (darkBg) Color(0xFF1E293B) else Color(0xFFCBD5E1)

    val startX = floor(viewBox.minX / step) * step
    val endX = ceil(viewBox.maxX / step) * step
    var x = startX
    var guard = 0
    while (x <= endX && guard < 150) {
        val sx = wx(x)
        val isMajor = abs((x / (step * 5.0)) - (x / (step * 5.0)).roundToInt()) < 1e-4
        drawLine(if (isMajor) majorColor else minorColor, Offset(sx, 0f), Offset(sx, size.height), strokeWidth = 1f)
        x += step
        guard++
    }

    val startY = floor(viewBox.minY / step) * step
    val endY = ceil(viewBox.maxY / step) * step
    var y = startY
    guard = 0
    while (y <= endY && guard < 150) {
        val sy = wy(y)
        val isMajor = abs((y / (step * 5.0)) - (y / (step * 5.0)).roundToInt()) < 1e-4
        drawLine(if (isMajor) majorColor else minorColor, Offset(0f, sy), Offset(size.width, sy), strokeWidth = 1f)
        y += step
        guard++
    }
}

private fun DrawScope.drawPolylinePath(
    pts: List<Point2D>,
    color: Color,
    strokeW: Float,
    wx: (Double) -> Float,
    wy: (Double) -> Float
) {
    if (pts.size < 2) return
    val p = Path()
    p.moveTo(wx(pts[0].x), wy(pts[0].y))
    for (i in 1 until pts.size) p.lineTo(wx(pts[i].x), wy(pts[i].y))
    drawPath(p, color, style = Stroke(width = strokeW))
}

private fun DrawScope.drawCadDimension(
    dim: CadEntity.Dimension,
    state: CadUiState,
    selected: Boolean,
    textPaint: Paint,
    wx: (Double) -> Float,
    wy: (Double) -> Float
) {
    val dimCol = if (selected) Color(0xFFFACC15) else Color(dim.customColor ?: state.dimStyle.colorHex)
    val label = CadViewModel.formatDimensionLabel(dim, state.document.unit, state.dimStyle)
    val pts = dim.points
    if (pts.isEmpty()) return

    val arrowSize = state.dimStyle.arrowSizePx * 2.2f
    textPaint.textSize = state.dimStyle.textHeightPx * 2.4f
    textPaint.color = android.graphics.Color.argb(
        255,
        (dimCol.red * 255).toInt(),
        (dimCol.green * 255).toInt(),
        (dimCol.blue * 255).toInt()
    )

    if (pts.size >= 2) {
        val a = pts[0]
        val b = pts[1]
        val ax = wx(a.x); val ay = wy(a.y)
        val bx = wx(b.x); val by = wy(b.y)

        when (dim.kind) {
            DimensionKind.HORIZONTAL -> {
                val dimY = min(ay, by) - 28f
                drawLine(dimCol.copy(alpha = 0.55f), Offset(ax, ay), Offset(ax, dimY - 6f), strokeWidth = 1.4f)
                drawLine(dimCol.copy(alpha = 0.55f), Offset(bx, by), Offset(bx, dimY - 6f), strokeWidth = 1.4f)
                drawArrowLine(Offset(ax, dimY), Offset(bx, dimY), dimCol, arrowSize)
                drawDimPillText(label, (ax + bx) * 0.5f, dimY - 10f, textPaint)
            }
            DimensionKind.VERTICAL -> {
                val dimX = max(ax, bx) + 28f
                drawLine(dimCol.copy(alpha = 0.55f), Offset(ax, ay), Offset(dimX + 6f, ay), strokeWidth = 1.4f)
                drawLine(dimCol.copy(alpha = 0.55f), Offset(bx, by), Offset(dimX + 6f, by), strokeWidth = 1.4f)
                drawArrowLine(Offset(dimX, ay), Offset(dimX, by), dimCol, arrowSize)
                drawDimPillText(label, dimX + 34f, (ay + by) * 0.5f, textPaint)
            }
            DimensionKind.AREA, DimensionKind.PERIMETER, DimensionKind.POLYLINE_LENGTH -> {
                val closed = dim.kind == DimensionKind.AREA || dim.kind == DimensionKind.PERIMETER
                val count = if (closed) pts.size else pts.size - 1
                for (i in 0 until count) {
                    val p1 = pts[i]
                    val p2 = pts[(i + 1) % pts.size]
                    drawLine(dimCol, Offset(wx(p1.x), wy(p1.y)), Offset(wx(p2.x), wy(p2.y)), strokeWidth = 2.6f)
                }
                val cx = pts.map { wx(it.x) }.average().toFloat()
                val cy = pts.map { wy(it.y) }.average().toFloat()
                drawDimPillText(label, cx, cy, textPaint)
            }
            else -> {
                drawArrowLine(Offset(ax, ay), Offset(bx, by), dimCol, arrowSize)
                drawDimPillText(label, (ax + bx) * 0.5f, (ay + by) * 0.5f - 12f, textPaint)
            }
        }
    } else {
        val px = wx(pts[0].x)
        val py = wy(pts[0].y)
        drawLine(dimCol, Offset(px, py), Offset(px + 42f, py - 42f), strokeWidth = 2f)
        drawDimPillText(label, px + 56f, py - 48f, textPaint)
    }
}

private fun DrawScope.drawArrowLine(a: Offset, b: Offset, color: Color, arrowLen: Float) {
    drawLine(color, a, b, strokeWidth = 2.2f)
    val dx = b.x - a.x
    val dy = b.y - a.y
    val len = hypot(dx, dy)
    if (len < 6f) return
    val ux = dx / len
    val uy = dy / len
    val nx = -uy
    val ny = ux
    val w = arrowLen * 0.38f

    val aPath = Path().apply {
        moveTo(a.x, a.y)
        lineTo(a.x + ux * arrowLen + nx * w, a.y + uy * arrowLen + ny * w)
        lineTo(a.x + ux * arrowLen - nx * w, a.y + uy * arrowLen - ny * w)
        close()
    }
    drawPath(aPath, color)

    val bPath = Path().apply {
        moveTo(b.x, b.y)
        lineTo(b.x - ux * arrowLen + nx * w, b.y - uy * arrowLen + ny * w)
        lineTo(b.x - ux * arrowLen - nx * w, b.y - uy * arrowLen - ny * w)
        close()
    }
    drawPath(bPath, color)
}

private fun DrawScope.drawDimPillText(label: String, x: Float, y: Float, paint: Paint) {
    val bg = Paint().apply {
        color = android.graphics.Color.argb(215, 10, 14, 22)
        style = Paint.Style.FILL
    }
    val w = paint.measureText(label) + 18f
    val h = paint.textSize + 10f
    drawContext.canvas.nativeCanvas.drawRoundRect(
        x - w * 0.5f,
        y - h * 0.72f,
        x + w * 0.5f,
        y + h * 0.28f,
        8f,
        8f,
        bg
    )
    drawContext.canvas.nativeCanvas.drawText(label, x, y, paint)
}
