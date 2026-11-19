package com.cadmaster.offline.export

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.pdf.PdfDocument
import android.net.Uri
import com.cadmaster.offline.CadViewModel
import com.cadmaster.offline.cad.*
import kotlin.math.*

/**
 * 100% offline PDF & PNG exporter using native Android Canvas and PdfDocument APIs.
 * Zero network access or external services required.
 */
object CadOfflineExporter {

    fun exportToPdf(
        context: Context,
        document: CadDocument,
        checkDimensions: List<CadEntity.Dimension>,
        displayUnit: CadUnit,
        style: DimensionStyleConfig,
        darkBackground: Boolean,
        outputUri: Uri
    ) {
        val pageWidth = 1191 // A3 landscape in points
        val pageHeight = 842
        val pdf = PdfDocument()
        try {
            val pageInfo = PdfDocument.PageInfo.Builder(pageWidth, pageHeight, 1).create()
            val page = pdf.startPage(pageInfo)
            renderDrawingSheet(
                canvas = page.canvas,
                width = pageWidth.toFloat(),
                height = pageHeight.toFloat(),
                document = document,
                checkDimensions = checkDimensions,
                displayUnit = displayUnit,
                style = style,
                darkBackground = darkBackground
            )
            pdf.finishPage(page)
            context.contentResolver.openOutputStream(outputUri)?.use { out ->
                pdf.writeTo(out)
            } ?: throw IllegalStateException("Unable to open output stream for PDF export.")
        } finally {
            pdf.close()
        }
    }

    fun exportToPng(
        context: Context,
        document: CadDocument,
        checkDimensions: List<CadEntity.Dimension>,
        displayUnit: CadUnit,
        style: DimensionStyleConfig,
        darkBackground: Boolean,
        outputUri: Uri
    ) {
        val width = 2400
        val height = 1600
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        try {
            val canvas = Canvas(bitmap)
            renderDrawingSheet(
                canvas = canvas,
                width = width.toFloat(),
                height = height.toFloat(),
                document = document,
                checkDimensions = checkDimensions,
                displayUnit = displayUnit,
                style = style,
                darkBackground = darkBackground
            )
            context.contentResolver.openOutputStream(outputUri)?.use { out ->
                if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)) {
                    throw IllegalStateException("PNG compression failed.")
                }
            } ?: throw IllegalStateException("Unable to open output stream for PNG export.")
        } finally {
            bitmap.recycle()
        }
    }

    private fun renderDrawingSheet(
        canvas: Canvas,
        width: Float,
        height: Float,
        document: CadDocument,
        checkDimensions: List<CadEntity.Dimension>,
        displayUnit: CadUnit,
        style: DimensionStyleConfig,
        darkBackground: Boolean
    ) {
        val bgColor = if (darkBackground) Color.rgb(10, 14, 22) else Color.WHITE
        val borderColor = if (darkBackground) Color.rgb(51, 65, 85) else Color.rgb(51, 65, 85)
        val titleBgColor = if (darkBackground) Color.rgb(17, 24, 39) else Color.rgb(245, 247, 250)
        val titleTextColor = if (darkBackground) Color.rgb(241, 245, 249) else Color.rgb(15, 23, 42)
        val subTextColor = if (darkBackground) Color.rgb(148, 163, 184) else Color.rgb(71, 85, 105)

        canvas.drawColor(bgColor)

        val margin = width * 0.02f
        val titleHeight = height * 0.08f
        val frameRect = RectF(margin, margin, width - margin, height - margin - titleHeight)

        val visibleLayers = document.layers.filter { it.visible }.map { it.name }.toSet()
        val layerColorMap = document.layers.associate { it.name to it.colorIndex }
        val visibleEntities = document.entities.filter { it.layer in visibleLayers }
        val allEntities = visibleEntities + checkDimensions
        val bounds = CadGeometry.getDocumentBounds(allEntities.ifEmpty { document.entities })

        val bw = bounds.width.coerceAtLeast(1.0)
        val bh = bounds.height.coerceAtLeast(1.0)
        val drawScale = min((frameRect.width() * 0.88) / bw, (frameRect.height() * 0.88) / bh)
        val bc = bounds.center
        val offsetX = frameRect.centerX() - bc.x * drawScale
        val offsetY = frameRect.centerY() + bc.y * drawScale

        fun wx(x: Double): Float = (offsetX + x * drawScale).toFloat()
        fun wy(y: Double): Float = (offsetY - y * drawScale).toFloat()

        canvas.save()
        canvas.clipRect(frameRect)

        val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
        }
        val textPaint = Paint(Paint.ANTI_ALIAS_FLAG)
        val strokeBase = max(1.2f, width * 0.0012f)

        for (e in allEntities) {
            val isCheckDim = e is CadEntity.Dimension && e.id.startsWith("chk_")
            val layerColorIdx = layerColorMap[e.layer] ?: 7
            val resolvedArgb = AciColors.resolveColor(e.colorIndex, e.trueColor, layerColorIdx, darkBackground).toInt()
            strokePaint.color = resolvedArgb
            strokePaint.strokeWidth = if (isCheckDim) strokeBase * 1.4f else strokeBase

            when (e) {
                is CadEntity.Line -> {
                    canvas.drawLine(wx(e.start.x), wy(e.start.y), wx(e.end.x), wy(e.end.y), strokePaint)
                }
                is CadEntity.LwPolyline -> {
                    val v = e.vertices
                    if (v.size >= 2) {
                        val count = if (e.closed) v.size else v.size - 1
                        for (i in 0 until count) {
                            val a = Point2D(v[i].x, v[i].y)
                            val b = Point2D(v[(i + 1) % v.size].x, v[(i + 1) % v.size].y)
                            val bulgeArc = CadGeometry.bulgeToArc(a, b, v[i].bulge)
                            if (bulgeArc != null) {
                                val rPx = (bulgeArc.radius * drawScale).toFloat()
                                val cx = wx(bulgeArc.center.x)
                                val cy = wy(bulgeArc.center.y)
                                val startDeg = -Math.toDegrees(bulgeArc.startAngleRad).toFloat()
                                val endDeg = -Math.toDegrees(bulgeArc.endAngleRad).toFloat()
                                var sweep = endDeg - startDeg
                                if (bulgeArc.ccw) {
                                    if (sweep > 0f) sweep -= 360f
                                } else {
                                    if (sweep < 0f) sweep += 360f
                                }
                                canvas.drawArc(cx - rPx, cy - rPx, cx + rPx, cy + rPx, startDeg, sweep, false, strokePaint)
                            } else {
                                canvas.drawLine(wx(a.x), wy(a.y), wx(b.x), wy(b.y), strokePaint)
                            }
                        }
                    }
                }
                is CadEntity.Circle -> {
                    val rPx = (e.radius * drawScale).toFloat()
                    if (rPx > 0.5f) {
                        canvas.drawCircle(wx(e.center.x), wy(e.center.y), rPx, strokePaint)
                    }
                }
                is CadEntity.Arc -> {
                    val rPx = (e.radius * drawScale).toFloat()
                    if (rPx > 0.5f) {
                        val cx = wx(e.center.x)
                        val cy = wy(e.center.y)
                        val sweep = CadGeometry.arcSweepDeg(e.startAngleDeg, e.endAngleDeg).toFloat()
                        canvas.drawArc(cx - rPx, cy - rPx, cx + rPx, cy + rPx, -e.startAngleDeg.toFloat(), -sweep, false, strokePaint)
                    }
                }
                is CadEntity.Ellipse -> {
                    drawPolylinePts(canvas, CadGeometry.evaluateEllipsePoints(e, 48), ::wx, ::wy, strokePaint)
                }
                is CadEntity.Spline -> {
                    drawPolylinePts(canvas, CadGeometry.evaluateSplinePoints(e, 14), ::wx, ::wy, strokePaint)
                }
                is CadEntity.Text -> {
                    textPaint.color = resolvedArgb
                    textPaint.textSize = (e.height * drawScale).toFloat().coerceIn(8f, height * 0.04f)
                    canvas.save()
                    val sx = wx(e.position.x)
                    val sy = wy(e.position.y)
                    canvas.rotate(-e.rotationDeg.toFloat(), sx, sy)
                    canvas.drawText(e.content, sx, sy, textPaint)
                    canvas.restore()
                }
                is CadEntity.Point -> {
                    val px = wx(e.position.x)
                    val py = wy(e.position.y)
                    val s = strokeBase * 3f
                    canvas.drawLine(px - s, py, px + s, py, strokePaint)
                    canvas.drawLine(px, py - s, px, py + s, strokePaint)
                }
                is CadEntity.Dimension -> {
                    val dimCol = (e.customColor ?: style.colorHex).toInt()
                    strokePaint.color = dimCol
                    textPaint.color = dimCol
                    textPaint.textAlign = Paint.Align.CENTER
                    textPaint.textSize = max(12f, height * 0.016f)
                    val label = CadViewModel.formatDimensionLabel(e, document.unit, displayUnit, style)
                    val pts = e.points
                    if (pts.size >= 2) {
                        val p0 = pts[0]
                        val p1 = pts[1]
                        canvas.drawLine(wx(p0.x), wy(p0.y), wx(p1.x), wy(p1.y), strokePaint)
                        val mx = (wx(p0.x) + wx(p1.x)) * 0.5f
                        val my = (wy(p0.y) + wy(p1.y)) * 0.5f - textPaint.textSize * 0.35f
                        canvas.drawText(label, mx, my, textPaint)
                    } else if (pts.size == 1) {
                        canvas.drawText(label, wx(pts[0].x), wy(pts[0].y), textPaint)
                    }
                    textPaint.textAlign = Paint.Align.LEFT
                }
            }
        }

        canvas.restore()

        // Outer engineering border & Title Block
        val borderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = borderColor
            style = Paint.Style.STROKE
            strokeWidth = strokeBase
        }
        canvas.drawRect(margin, margin, width - margin, height - margin, borderPaint)

        val titleTop = height - margin - titleHeight
        val fillPaint = Paint().apply {
            color = titleBgColor
            style = Paint.Style.FILL
        }
        canvas.drawRect(margin, titleTop, width - margin, height - margin, fillPaint)
        canvas.drawRect(margin, titleTop, width - margin, height - margin, borderPaint)

        val titlePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = titleTextColor
            isFakeBoldText = true
            textSize = titleHeight * 0.32f
        }
        val metaPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = subTextColor
            textSize = titleHeight * 0.24f
        }
        canvas.drawText("CAD MASTER — ${document.name}", margin * 1.8f, titleTop + titleHeight * 0.42f, titlePaint)
        canvas.drawText(
            "Format: ${document.format} (${document.versionLabel})  |  Units: ${displayUnit.label} (${displayUnit.code})  |  Entities: ${document.entities.size}",
            margin * 1.8f,
            titleTop + titleHeight * 0.78f,
            metaPaint
        )
    }

    private fun drawPolylinePts(
        canvas: Canvas,
        pts: List<Point2D>,
        wx: (Double) -> Float,
        wy: (Double) -> Float,
        paint: Paint
    ) {
        if (pts.size < 2) return
        val path = Path()
        path.moveTo(wx(pts[0].x), wy(pts[0].y))
        for (i in 1 until pts.size) {
            path.lineTo(wx(pts[i].x), wy(pts[i].y))
        }
        canvas.drawPath(path, paint)
    }
}
