package com.cadmaster.offline

import android.app.Application
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.cadmaster.offline.cad.*
import com.cadmaster.offline.data.CadRoomDatabase
import com.cadmaster.offline.data.RecentFileEntity
import com.cadmaster.offline.data.UserSettingsEntity
import com.cadmaster.offline.export.CadOfflineExporter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.Locale
import kotlin.math.*

data class CadHistorySnapshot(
    val entities: List<CadEntity>,
    val checkDimensions: List<CadEntity.Dimension>
)

data class ActiveMeasurementPopup(
    val title: String,
    val primaryText: String,
    val subtitle: String,
    val start: Point2D? = null,
    val end: Point2D? = null,
    val segments: List<PolylineSegmentInfo> = emptyList(),
    val selectedSegmentIndex: Int? = null
)

data class CadUiState(
    val document: CadDocument = SampleDrawings.loadArchitecturalSample(),
    val checkDimensions: List<CadEntity.Dimension> = emptyList(),
    val undoStack: List<CadHistorySnapshot> = emptyList(),
    val redoStack: List<CadHistorySnapshot> = emptyList(),
    val viewport: ViewportState = ViewportState(0.0, 0.0, 1.0),
    val canvasSizePx: Pair<Float, Float> = 1080f to 1600f,
    val activeTool: ToolId = ToolId.MEASURE,
    val activeDimensionKind: DimensionKind = DimensionKind.ALIGNED,
    val pendingPoints: List<Point2D> = emptyList(),
    val crosshairWorld: Point2D? = null,
    val activeSnap: SnapResult? = null,
    val selectedEntityId: String? = null,
    val selectedSegmentIndex: Int? = null,
    val measurementPopup: ActiveMeasurementPopup? = null,
    val gridVisible: Boolean = true,
    val darkBackground: Boolean = true,
    val fullScreenMode: Boolean = false,
    val osnapSettings: OsnapSettings = OsnapSettings(),
    val dimStyle: DimensionStyleConfig = DimensionStyleConfig(),
    val isLoading: Boolean = false,
    val loadingMessage: String = "",
    val errorMessage: String? = null,
    val toastMessage: String? = null,
    val activeSheet: ActiveSheet? = null,
    val recentFiles: List<RecentFileEntity> = emptyList()
) {
    val canUndo: Boolean get() = undoStack.isNotEmpty()
    val canRedo: Boolean get() = redoStack.isNotEmpty()
    val effectiveDisplayUnit: CadUnit get() = dimStyle.displayUnit ?: document.unit
}

enum class ActiveSheet {
    DIMENSIONS,
    SETTINGS
}

class CadViewModel(application: Application) : AndroidViewModel(application) {
    private val dao = CadRoomDatabase.getInstance(application).cadDao()
    private val _uiState = MutableStateFlow(CadUiState())
    val uiState: StateFlow<CadUiState> = _uiState.asStateFlow()

    private var dimSeq = 1

    init {
        viewModelScope.launch {
            dao.getSettings()?.let { saved ->
                val modes = saved.osnapModesCsv
                    .split(',')
                    .mapNotNull { runCatching { OsnapType.valueOf(it.trim()) }.getOrNull() }
                    .toSet()
                val preferredUnit = runCatching { CadUnit.valueOf(saved.preferredUnitCode) }.getOrNull()
                _uiState.update { s ->
                    s.copy(
                        gridVisible = saved.gridVisible,
                        darkBackground = saved.darkBackground,
                        osnapSettings = OsnapSettings(
                            enabled = saved.osnapEnabled,
                            snapRadiusPx = saved.snapRadiusPx,
                            modes = if (modes.isNotEmpty()) modes else s.osnapSettings.modes
                        ),
                        dimStyle = s.dimStyle.copy(precision = saved.precision),
                        document = if (preferredUnit != null && s.document.detectedUnit == CadUnit.UNDEFINED) {
                            s.document.copy(unit = preferredUnit)
                        } else s.document
                    )
                }
            }
        }
        viewModelScope.launch {
            dao.observeRecentFiles().collect { recents ->
                _uiState.update { it.copy(recentFiles = recents) }
            }
        }
    }

    private fun persistSettings() {
        val s = _uiState.value
        viewModelScope.launch(Dispatchers.IO) {
            dao.saveSettings(
                UserSettingsEntity(
                    preferredUnitCode = s.document.unit.name,
                    precision = s.dimStyle.precision,
                    gridVisible = s.gridVisible,
                    osnapEnabled = s.osnapSettings.enabled,
                    snapRadiusPx = s.osnapSettings.snapRadiusPx,
                    osnapModesCsv = s.osnapSettings.modes.joinToString(",") { it.name },
                    darkBackground = s.darkBackground
                )
            )
        }
    }

    fun updateCanvasSize(widthPx: Float, heightPx: Float) {
        val prev = _uiState.value.canvasSizePx
        if (abs(prev.first - widthPx) > 2f || abs(prev.second - heightPx) > 2f) {
            val firstFit = _uiState.value.viewport.scale == 1.0 && _uiState.value.viewport.offsetX == 0.0
            _uiState.update { it.copy(canvasSizePx = widthPx to heightPx) }
            if (firstFit && widthPx > 50f && heightPx > 50f) {
                fitToScreen()
            }
        }
    }

    fun fitToScreen() {
        val s = _uiState.value
        val (w, h) = s.canvasSizePx
        if (w <= 20f || h <= 20f) return
        val visibleLayers = s.document.layers.filter { it.visible }.map { it.name }.toSet()
        val visibleEntities = s.document.entities.filter { it.layer in visibleLayers }
        val bounds = CadGeometry.getDocumentBounds(visibleEntities.ifEmpty { s.document.entities })
        val bw = bounds.width.coerceAtLeast(1.0)
        val bh = bounds.height.coerceAtLeast(1.0)
        val padding = 0.84
        val newScale = min((w * padding) / bw, (h * padding) / bh).coerceIn(1e-5, 5000.0)
        val bc = bounds.center
        val offsetX = (w * 0.5) - bc.x * newScale
        val offsetY = (h * 0.5) + bc.y * newScale
        _uiState.update { it.copy(viewport = ViewportState(offsetX, offsetY, newScale)) }
    }

    fun zoomBy(factor: Double) {
        _uiState.update { s ->
            val vp = s.viewport
            val (w, h) = s.canvasSizePx
            val fx = w * 0.5
            val fy = h * 0.5
            val worldBeforeX = (fx - vp.offsetX) / vp.scale
            val worldBeforeY = (vp.offsetY - fy) / vp.scale
            val nextScale = (vp.scale * factor).coerceIn(1e-5, 8000.0)
            s.copy(
                viewport = ViewportState(
                    offsetX = fx - worldBeforeX * nextScale,
                    offsetY = fy + worldBeforeY * nextScale,
                    scale = nextScale
                )
            )
        }
    }

    fun applyPanAndPinch(panX: Float, panY: Float, zoomFactor: Float, centroidX: Float, centroidY: Float) {
        _uiState.update { s ->
            val vp = s.viewport
            val cx = centroidX.toDouble()
            val cy = centroidY.toDouble()
            val worldBeforeX = (cx - vp.offsetX) / vp.scale
            val worldBeforeY = (vp.offsetY - cy) / vp.scale
            val nextScale = (vp.scale * zoomFactor).coerceIn(1e-5, 8000.0)
            s.copy(
                viewport = ViewportState(
                    offsetX = cx - worldBeforeX * nextScale + panX,
                    offsetY = cy + worldBeforeY * nextScale + panY,
                    scale = nextScale
                )
            )
        }
    }

    fun loadSample(mechanical: Boolean) {
        val doc = if (mechanical) SampleDrawings.loadMechanicalSample() else SampleDrawings.loadArchitecturalSample()
        _uiState.update {
            it.copy(
                document = doc,
                checkDimensions = emptyList(),
                undoStack = emptyList(),
                redoStack = emptyList(),
                selectedEntityId = null,
                selectedSegmentIndex = null,
                measurementPopup = null,
                pendingPoints = emptyList(),
                activeSheet = null,
                toastMessage = "Loaded ${doc.name}"
            )
        }
        fitToScreen()
    }

    fun openLocalUri(uri: Uri) {
        val ctx = getApplication<Application>()
        viewModelScope.launch {
            _uiState.update {
                it.copy(isLoading = true, loadingMessage = "Opening CAD drawing...", errorMessage = null, activeSheet = null)
            }
            try {
                runCatching {
                    ctx.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                val fileName = resolveFileName(ctx, uri)
                val ext = fileName.substringAfterLast('.', "").lowercase(Locale.US)
                val doc = withContext(Dispatchers.IO) {
                    ctx.contentResolver.openInputStream(uri)?.use { stream ->
                        if (ext == "dwg") {
                            DwgParser.parseFromStream(fileName, stream, ctx.cacheDir, uri.toString())
                        } else {
                            DxfParser.parseStream(fileName, stream, uri.toString()) { count ->
                                _uiState.update { st -> st.copy(loadingMessage = "Reading $count objects...") }
                            }
                        }
                    } ?: throw IllegalStateException("Cannot open '$fileName'.")
                }
                dao.upsertRecentFile(
                    RecentFileEntity(
                        uriString = uri.toString(),
                        displayName = doc.name,
                        format = doc.format,
                        versionLabel = doc.versionLabel,
                        unitCode = doc.unit.code,
                        entityCount = doc.entities.size,
                        openedAtEpochMs = System.currentTimeMillis()
                    )
                )
                _uiState.update {
                    it.copy(
                        document = doc,
                        checkDimensions = emptyList(),
                        undoStack = emptyList(),
                        redoStack = emptyList(),
                        isLoading = false,
                        loadingMessage = "",
                        selectedEntityId = null,
                        selectedSegmentIndex = null,
                        measurementPopup = null,
                        pendingPoints = emptyList(),
                        toastMessage = "Opened ${doc.name}"
                    )
                }
                fitToScreen()
            } catch (t: Throwable) {
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        loadingMessage = "",
                        errorMessage = t.message ?: "Unable to open CAD file."
                    )
                }
            }
        }
    }

    fun deleteRecent(uriString: String) {
        viewModelScope.launch(Dispatchers.IO) { dao.deleteRecentFile(uriString) }
    }

    fun exportPdfToUri(uri: Uri) {
        val ctx = getApplication<Application>()
        val s = _uiState.value
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true, loadingMessage = "Exporting PDF offline...", activeSheet = null) }
            try {
                withContext(Dispatchers.IO) {
                    CadOfflineExporter.exportToPdf(
                        context = ctx,
                        document = s.document,
                        checkDimensions = s.checkDimensions,
                        displayUnit = s.effectiveDisplayUnit,
                        style = s.dimStyle,
                        darkBackground = s.darkBackground,
                        outputUri = uri
                    )
                }
                _uiState.update { it.copy(isLoading = false, loadingMessage = "", toastMessage = "Exported PDF offline") }
            } catch (t: Throwable) {
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        loadingMessage = "",
                        errorMessage = t.message ?: "Failed to export PDF."
                    )
                }
            }
        }
    }

    fun exportPngToUri(uri: Uri) {
        val ctx = getApplication<Application>()
        val s = _uiState.value
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true, loadingMessage = "Exporting PNG offline...", activeSheet = null) }
            try {
                withContext(Dispatchers.IO) {
                    CadOfflineExporter.exportToPng(
                        context = ctx,
                        document = s.document,
                        checkDimensions = s.checkDimensions,
                        displayUnit = s.effectiveDisplayUnit,
                        style = s.dimStyle,
                        darkBackground = s.darkBackground,
                        outputUri = uri
                    )
                }
                _uiState.update { it.copy(isLoading = false, loadingMessage = "", toastMessage = "Exported PNG offline") }
            } catch (t: Throwable) {
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        loadingMessage = "",
                        errorMessage = t.message ?: "Failed to export PNG."
                    )
                }
            }
        }
    }

    fun setTool(tool: ToolId) {
        _uiState.update { it.copy(activeTool = tool, pendingPoints = emptyList(), activeSheet = null) }
    }

    fun selectDimensionKind(kind: DimensionKind) {
        _uiState.update {
            it.copy(
                activeTool = ToolId.DIMENSION,
                activeDimensionKind = kind,
                pendingPoints = emptyList(),
                activeSheet = null
            )
        }
    }

    fun undo() {
        _uiState.update { s ->
            if (s.undoStack.isEmpty()) return@update s
            val prev = s.undoStack.last()
            val current = CadHistorySnapshot(s.document.entities, s.checkDimensions)
            s.copy(
                document = s.document.copy(entities = prev.entities),
                checkDimensions = prev.checkDimensions,
                undoStack = s.undoStack.dropLast(1),
                redoStack = (s.redoStack + current).takeLast(50),
                selectedEntityId = null,
                selectedSegmentIndex = null,
                measurementPopup = null
            )
        }
    }

    fun redo() {
        _uiState.update { s ->
            if (s.redoStack.isEmpty()) return@update s
            val next = s.redoStack.last()
            val current = CadHistorySnapshot(s.document.entities, s.checkDimensions)
            s.copy(
                document = s.document.copy(entities = next.entities),
                checkDimensions = next.checkDimensions,
                undoStack = (s.undoStack + current).takeLast(50),
                redoStack = s.redoStack.dropLast(1),
                selectedEntityId = null,
                selectedSegmentIndex = null,
                measurementPopup = null
            )
        }
    }

    fun deleteSelectedEntity() {
        _uiState.update { s ->
            val targetId = s.selectedEntityId ?: return@update s
            val current = CadHistorySnapshot(s.document.entities, s.checkDimensions)
            s.copy(
                document = s.document.copy(entities = s.document.entities.filterNot { it.id == targetId }),
                checkDimensions = s.checkDimensions.filterNot { it.id == targetId },
                undoStack = (s.undoStack + current).takeLast(50),
                redoStack = emptyList(),
                selectedEntityId = null,
                selectedSegmentIndex = null,
                measurementPopup = null
            )
        }
    }

    fun clearCheckedDimensions() {
        _uiState.update { s ->
            if (s.checkDimensions.isEmpty()) return@update s
            val current = CadHistorySnapshot(s.document.entities, s.checkDimensions)
            s.copy(
                checkDimensions = emptyList(),
                undoStack = (s.undoStack + current).takeLast(50),
                redoStack = emptyList(),
                pendingPoints = emptyList(),
                selectedEntityId = null,
                measurementPopup = null,
                activeSheet = null
            )
        }
    }

    fun openSheet(sheet: ActiveSheet?) {
        _uiState.update { it.copy(activeSheet = if (it.activeSheet == sheet) null else sheet) }
    }

    fun toggleGrid() {
        _uiState.update { it.copy(gridVisible = !it.gridVisible) }
        persistSettings()
    }

    fun toggleBackground() {
        _uiState.update { it.copy(darkBackground = !it.darkBackground) }
        persistSettings()
    }

    fun toggleFullScreen() {
        _uiState.update { it.copy(fullScreenMode = !it.fullScreenMode) }
    }

    fun toggleLayerVisibility(layerName: String) {
        _uiState.update { s ->
            val updated = s.document.layers.map {
                if (it.name == layerName) it.copy(visible = !it.visible) else it
            }
            s.copy(document = s.document.copy(layers = updated))
        }
    }

    fun setAllLayersVisible(visible: Boolean) {
        _uiState.update { s ->
            val updated = s.document.layers.map { it.copy(visible = visible) }
            s.copy(document = s.document.copy(layers = updated))
        }
    }

    fun setUnit(unit: CadUnit) {
        _uiState.update { s -> s.copy(document = s.document.copy(unit = unit)) }
        persistSettings()
    }

    fun setDisplayUnit(unit: CadUnit) {
        _uiState.update { s ->
            val updatedDoc = if (s.document.unit == CadUnit.UNDEFINED) s.document.copy(unit = unit) else s.document
            val nextStyle = s.dimStyle.copy(displayUnit = unit)
            val reMeasured = s.selectedEntityId?.let { id ->
                updatedDoc.entities.find { it.id == id }?.let { ent ->
                    buildMeasurementPopup(ent, s.selectedSegmentIndex, updatedDoc.unit, unit, nextStyle.precision)
                }
            } ?: s.measurementPopup
            s.copy(document = updatedDoc, dimStyle = nextStyle, measurementPopup = reMeasured)
        }
    }

    fun setPrecision(precision: Int) {
        _uiState.update { s -> s.copy(dimStyle = s.dimStyle.copy(precision = precision.coerceIn(0, 4))) }
        persistSettings()
    }

    fun updateOsnap(transform: (OsnapSettings) -> OsnapSettings) {
        _uiState.update { it.copy(osnapSettings = transform(it.osnapSettings)) }
        persistSettings()
    }

    fun clearError() { _uiState.update { it.copy(errorMessage = null) } }
    fun clearToast() { _uiState.update { it.copy(toastMessage = null) } }
    fun clearSelection() {
        _uiState.update {
            it.copy(
                selectedEntityId = null,
                selectedSegmentIndex = null,
                measurementPopup = null,
                pendingPoints = emptyList()
            )
        }
    }

    fun copyPopupToClipboard() {
        val popup = _uiState.value.measurementPopup ?: return
        val ctx = getApplication<Application>()
        val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("CAD Dimension", "${popup.title}: ${popup.primaryText} (${popup.subtitle})"))
        _uiState.update { it.copy(toastMessage = "Copied: ${popup.primaryText}") }
    }

    fun onCanvasCursorMove(screenX: Float, screenY: Float) {
        val s = _uiState.value
        val worldPt = screenToWorld(screenX, screenY, s.viewport)
        val visibleLayers = s.document.layers.filter { it.visible }.map { it.name }.toSet()
        val snap = CadOsnap.findBestSnap(
            worldCursor = worldPt,
            entities = s.document.entities,
            visibleLayers = visibleLayers,
            settings = s.osnapSettings,
            viewportScale = s.viewport.scale,
            referencePoint = s.pendingPoints.lastOrNull()
        )
        _uiState.update { it.copy(crosshairWorld = snap?.point ?: worldPt, activeSnap = snap) }
    }

    fun onCanvasTap(screenX: Float, screenY: Float) {
        val s = _uiState.value
        val rawWorld = screenToWorld(screenX, screenY, s.viewport)
        val visibleLayers = s.document.layers.filter { it.visible }.map { it.name }.toSet()
        val snap = CadOsnap.findBestSnap(
            worldCursor = rawWorld,
            entities = s.document.entities,
            visibleLayers = visibleLayers,
            settings = s.osnapSettings,
            viewportScale = s.viewport.scale,
            referencePoint = s.pendingPoints.lastOrNull()
        )
        val pickPt = snap?.point ?: rawWorld
        val touchToleranceWorld = 42.0 / s.viewport.scale

        _uiState.update { it.copy(crosshairWorld = pickPt, activeSnap = snap) }

        when (s.activeTool) {
            ToolId.PAN -> Unit
            ToolId.SELECT, ToolId.MEASURE -> {
                val hit = CadGeometry.hitTest(rawWorld, s.document.entities, visibleLayers, touchToleranceWorld)
                if (hit == null) {
                    clearSelection()
                } else {
                    val popup = buildMeasurementPopup(
                        hit.entity,
                        hit.segmentIndex,
                        s.document.unit,
                        s.effectiveDisplayUnit,
                        s.dimStyle.precision
                    )
                    _uiState.update {
                        it.copy(
                            selectedEntityId = hit.entity.id,
                            selectedSegmentIndex = hit.segmentIndex,
                            measurementPopup = popup
                        )
                    }
                }
            }
            ToolId.DIMENSION -> handleDimensionCheckTap(rawWorld, pickPt, visibleLayers, touchToleranceWorld)
        }
    }

    private fun buildMeasurementPopup(
        entity: CadEntity,
        segmentIndex: Int?,
        nativeUnit: CadUnit,
        displayUnit: CadUnit,
        precision: Int
    ): ActiveMeasurementPopup {
        val meas = CadGeometry.measureEntity(entity, segmentIndex)
        val formatted = if (meas.isArea) {
            CadUnits.formatArea(meas.primaryValue, nativeUnit, displayUnit, precision)
        } else {
            CadUnits.formatLength(meas.primaryValue, nativeUnit, displayUnit, precision)
        }
        val labelPrefix = when (entity) {
            is CadEntity.Line -> "Selected Line Length"
            is CadEntity.LwPolyline -> "Polyline Total Length"
            else -> meas.primaryLabel
        }
        val subtitleParts = buildList {
            meas.angleDeg?.let { add("Angle ${CadUnits.formatAngle(it, precision)}") }
            meas.dx?.let { add("ΔX ${CadUnits.formatLength(it, nativeUnit, displayUnit, precision)}") }
            meas.dy?.let { add("ΔY ${CadUnits.formatLength(it, nativeUnit, displayUnit, precision)}") }
            meas.radius?.let { add("R ${CadUnits.formatLength(it, nativeUnit, displayUnit, precision)}") }
            meas.diameter?.let { add("Ø ${CadUnits.formatLength(it, nativeUnit, displayUnit, precision)}") }
            meas.circumferenceOrArea?.let {
                if (meas.entityType == "CIRCLE" || meas.entityType.contains("POLYLINE")) {
                    add("Area ${CadUnits.formatArea(it, nativeUnit, displayUnit, precision)}")
                }
            }
        }.joinToString(" • ")

        return ActiveMeasurementPopup(
            title = "${meas.entityType} (${meas.layer})",
            primaryText = "$labelPrefix: $formatted",
            subtitle = subtitleParts.ifEmpty { "Layer ${meas.layer}" },
            start = meas.start,
            end = meas.end,
            segments = meas.segments,
            selectedSegmentIndex = segmentIndex
        )
    }

    private fun handleDimensionCheckTap(
        rawWorld: Point2D,
        pickPt: Point2D,
        visibleLayers: Set<String>,
        tol: Double
    ) {
        val s = _uiState.value
        val kind = s.activeDimensionKind

        when (kind) {
            DimensionKind.RADIUS, DimensionKind.DIAMETER -> {
                val hit = CadGeometry.hitTest(rawWorld, s.document.entities, visibleLayers, tol)
                val (center, r) = when (val ent = hit?.entity) {
                    is CadEntity.Circle -> ent.center to ent.radius
                    is CadEntity.Arc -> ent.center to ent.radius
                    else -> {
                        _uiState.update { it.copy(toastMessage = "Tap a Circle or Arc") }
                        return
                    }
                }
                val value = if (kind == DimensionKind.RADIUS) r else r * 2.0
                val ang = atan2(pickPt.y - center.y, pickPt.x - center.x)
                val edgePt = Point2D(center.x + r * cos(ang), center.y + r * sin(ang))
                addCheckDimension(
                    CadEntity.Dimension(
                        id = "chk_${dimSeq++}",
                        kind = kind,
                        points = listOf(center, edgePt),
                        radius = r,
                        measuredValue = value,
                        customColor = s.dimStyle.colorHex
                    )
                )
                return
            }
            DimensionKind.ARC_LENGTH -> {
                val hit = CadGeometry.hitTest(rawWorld, s.document.entities, visibleLayers, tol)
                val arc = hit?.entity as? CadEntity.Arc
                if (arc == null) {
                    _uiState.update { it.copy(toastMessage = "Tap an Arc") }
                    return
                }
                val sweep = CadGeometry.arcSweepDeg(arc.startAngleDeg, arc.endAngleDeg)
                addCheckDimension(
                    CadEntity.Dimension(
                        id = "chk_${dimSeq++}",
                        kind = kind,
                        points = listOf(arc.center),
                        radius = arc.radius,
                        startAngleDeg = arc.startAngleDeg,
                        endAngleDeg = arc.endAngleDeg,
                        measuredValue = arc.radius * Math.toRadians(sweep),
                        customColor = s.dimStyle.colorHex
                    )
                )
                return
            }
            DimensionKind.POLYLINE_LENGTH -> {
                val hit = CadGeometry.hitTest(rawWorld, s.document.entities, visibleLayers, tol)
                val poly = hit?.entity as? CadEntity.LwPolyline
                if (poly == null) {
                    _uiState.update { it.copy(toastMessage = "Tap any Polyline") }
                    return
                }
                val segs = CadGeometry.polylineSegments(poly)
                addCheckDimension(
                    CadEntity.Dimension(
                        id = "chk_${dimSeq++}",
                        kind = kind,
                        points = poly.vertices.map { Point2D(it.x, it.y) },
                        measuredValue = segs.sumOf { it.length },
                        customColor = s.dimStyle.colorHex
                    )
                )
                return
            }
            DimensionKind.AREA, DimensionKind.PERIMETER -> {
                if (s.pendingPoints.isEmpty()) {
                    val hit = CadGeometry.hitTest(rawWorld, s.document.entities, visibleLayers, tol)
                    if (hit?.entity is CadEntity.Circle) {
                        val c = hit.entity
                        val v = if (kind == DimensionKind.AREA) PI * c.radius * c.radius else 2.0 * PI * c.radius
                        val ring = List(24) { i ->
                            val a = (i * 2.0 * PI) / 24.0
                            Point2D(c.center.x + c.radius * cos(a), c.center.y + c.radius * sin(a))
                        }
                        addCheckDimension(
                            CadEntity.Dimension("chk_${dimSeq++}", kind = kind, points = ring, measuredValue = v, customColor = s.dimStyle.colorHex)
                        )
                        return
                    }
                    if (hit?.entity is CadEntity.LwPolyline && hit.entity.closed) {
                        val pts = hit.entity.vertices.map { Point2D(it.x, it.y) }
                        val v = if (kind == DimensionKind.AREA) CadGeometry.computePolygonArea(pts)
                        else CadGeometry.polylineSegments(hit.entity).sumOf { it.length }
                        addCheckDimension(
                            CadEntity.Dimension("chk_${dimSeq++}", kind = kind, points = pts, measuredValue = v, customColor = s.dimStyle.colorHex)
                        )
                        return
                    }
                }
                _uiState.update { it.copy(pendingPoints = s.pendingPoints + pickPt) }
                return
            }
            else -> {}
        }

        val pts = s.pendingPoints + pickPt
        when (kind) {
            DimensionKind.ANGULAR -> {
                if (pts.size < 3) {
                    _uiState.update { it.copy(pendingPoints = pts) }
                } else {
                    val v = pts[0]
                    val a1 = atan2(pts[1].y - v.y, pts[1].x - v.x)
                    val a2 = atan2(pts[2].y - v.y, pts[2].x - v.x)
                    var diff = Math.toDegrees(abs(a2 - a1))
                    if (diff > 180.0) diff = 360.0 - diff
                    addCheckDimension(
                        CadEntity.Dimension("chk_${dimSeq++}", kind = kind, points = pts, measuredValue = diff, customColor = s.dimStyle.colorHex)
                    )
                }
            }
            DimensionKind.ORDINATE -> {
                val valCoord = if (abs(pickPt.x) >= abs(pickPt.y)) pickPt.x else pickPt.y
                addCheckDimension(
                    CadEntity.Dimension("chk_${dimSeq++}", kind = kind, points = listOf(pickPt), measuredValue = valCoord, customColor = s.dimStyle.colorHex)
                )
            }
            else -> {
                if (pts.size < 2) {
                    _uiState.update { it.copy(pendingPoints = pts) }
                } else {
                    val p1 = pts[0]
                    val p2 = pts[1]
                    val dx = abs(p2.x - p1.x)
                    val dy = abs(p2.y - p1.y)
                    val value = when (kind) {
                        DimensionKind.HORIZONTAL -> dx
                        DimensionKind.VERTICAL -> dy
                        else -> CadGeometry.dist(p1, p2)
                    }
                    addCheckDimension(
                        CadEntity.Dimension("chk_${dimSeq++}", kind = kind, points = listOf(p1, p2), measuredValue = value, customColor = s.dimStyle.colorHex)
                    )
                }
            }
        }
    }

    fun finishMultiPointOperation() {
        val s = _uiState.value
        val pts = s.pendingPoints
        if (s.activeTool == ToolId.DIMENSION && pts.size >= 2) {
            val kind = s.activeDimensionKind
            val value = if (kind == DimensionKind.AREA && pts.size >= 3) {
                CadGeometry.computePolygonArea(pts)
            } else {
                var p = 0.0
                for (i in pts.indices) p += CadGeometry.dist(pts[i], pts[(i + 1) % pts.size])
                p
            }
            addCheckDimension(
                CadEntity.Dimension("chk_${dimSeq++}", kind = kind, points = pts, measuredValue = value, customColor = s.dimStyle.colorHex)
            )
        }
    }

    private fun addCheckDimension(dim: CadEntity.Dimension) {
        val s = _uiState.value
        val displayUnit = s.effectiveDisplayUnit
        val formatted = formatDimensionLabel(dim, s.document.unit, displayUnit, s.dimStyle)
        val p0 = dim.points.firstOrNull()
        val p1 = dim.points.getOrNull(1)
        val ang = if (p0 != null && p1 != null) CadGeometry.angleDeg(p0, p1) else null
        val dx = if (p0 != null && p1 != null) abs(p1.x - p0.x) else null
        val dy = if (p0 != null && p1 != null) abs(p1.y - p0.y) else null
        val currentSnapshot = CadHistorySnapshot(s.document.entities, s.checkDimensions)

        _uiState.update {
            it.copy(
                checkDimensions = it.checkDimensions + dim,
                undoStack = (it.undoStack + currentSnapshot).takeLast(50),
                redoStack = emptyList(),
                pendingPoints = emptyList(),
                selectedEntityId = dim.id,
                measurementPopup = ActiveMeasurementPopup(
                    title = dim.kind.label,
                    primaryText = formatted,
                    subtitle = if (ang != null && dx != null && dy != null) {
                        "Angle ${CadUnits.formatAngle(ang, s.dimStyle.precision)} • ΔX ${CadUnits.formatLength(dx, s.document.unit, displayUnit, s.dimStyle.precision)} • ΔY ${CadUnits.formatLength(dy, s.document.unit, displayUnit, s.dimStyle.precision)}"
                    } else "CAD World Coordinates",
                    start = p0,
                    end = p1
                )
            )
        }
    }

    private fun screenToWorld(sx: Float, sy: Float, vp: ViewportState): Point2D {
        return Point2D((sx - vp.offsetX) / vp.scale, (vp.offsetY - sy) / vp.scale)
    }

    private fun resolveFileName(ctx: Context, uri: Uri): String {
        ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (idx >= 0) {
                    val name = cursor.getString(idx)
                    if (!name.isNullOrBlank()) return name
                }
            }
        }
        return uri.lastPathSegment?.substringAfterLast('/') ?: "Drawing.dxf"
    }

    companion object {
        fun formatDimensionLabel(
            dim: CadEntity.Dimension,
            unit: CadUnit,
            displayUnit: CadUnit = unit,
            style: DimensionStyleConfig
        ): String {
            if (!dim.textOverride.isNullOrBlank()) return dim.textOverride
            return when (dim.kind) {
                DimensionKind.ANGULAR -> CadUnits.formatAngle(dim.measuredValue, style.precision)
                DimensionKind.AREA -> CadUnits.formatArea(dim.measuredValue, unit, displayUnit, style.precision)
                DimensionKind.RADIUS -> "R ${CadUnits.formatLength(dim.measuredValue, unit, displayUnit, style.precision)}"
                DimensionKind.DIAMETER -> "Ø ${CadUnits.formatLength(dim.measuredValue, unit, displayUnit, style.precision)}"
                else -> CadUnits.formatLength(dim.measuredValue, unit, displayUnit, style.precision)
            }
        }
    }
}
