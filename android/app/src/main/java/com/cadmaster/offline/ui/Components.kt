package com.cadmaster.offline.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.cadmaster.offline.*
import com.cadmaster.offline.cad.*

private val SurfaceDark = Color(0xFF0D1119)
private val SurfaceCard = Color(0xFF151C28)
private val BorderSubtle = Color(0xFF263142)
private val AccentCyan = Color(0xFF38BDF8)

private val CHECK_DIM_KINDS = listOf(
    DimensionKind.POINT_TO_POINT,
    DimensionKind.HORIZONTAL,
    DimensionKind.VERTICAL,
    DimensionKind.ALIGNED,
    DimensionKind.ANGULAR,
    DimensionKind.RADIUS,
    DimensionKind.DIAMETER,
    DimensionKind.ARC_LENGTH,
    DimensionKind.AREA,
    DimensionKind.PERIMETER,
    DimensionKind.POLYLINE_LENGTH
)

private enum class SettingsTab(val label: String) {
    FILES("Files"),
    LAYERS("Layers"),
    UNITS("Units"),
    SNAP("Snap")
}

@Composable
fun CadMasterScreen(
    state: CadUiState,
    onOpenFile: () -> Unit,
    onExportPdf: () -> Unit,
    onExportPng: () -> Unit,
    viewModel: CadViewModel,
    onOpenRecentUri: (String) -> Unit
) {
    val snackbarHostState = remember { SnackbarHostState() }

    LaunchedEffect(state.toastMessage) {
        state.toastMessage?.let {
            snackbarHostState.showSnackbar(it, duration = SnackbarDuration.Short)
            viewModel.clearToast()
        }
    }

    Scaffold(
        containerColor = Color.Black,
        contentWindowInsets = WindowInsets.safeDrawing,
        snackbarHost = { SnackbarHost(snackbarHostState) }
    ) { innerPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
        ) {
            Column(modifier = Modifier.fillMaxSize()) {
                if (!state.fullScreenMode) {
                    MobileTopHeader(
                        canUndo = state.canUndo,
                        canRedo = state.canRedo,
                        onUndo = viewModel::undo,
                        onRedo = viewModel::redo,
                        onOpen = onOpenFile,
                        settingsActive = state.activeSheet == ActiveSheet.SETTINGS,
                        onOpenSettings = { viewModel.openSheet(ActiveSheet.SETTINGS) }
                    )
                }

                Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                    CadCanvasView(
                        state = state,
                        onSizeChanged = viewModel::updateCanvasSize,
                        onTap = viewModel::onCanvasTap,
                        onCursorMove = viewModel::onCanvasCursorMove,
                        onTransform = viewModel::applyPanAndPinch
                    )

                    CanvasHud(
                        state = state,
                        onOpenSettingsFiles = { viewModel.openSheet(ActiveSheet.SETTINGS) },
                        onExitFullScreen = { viewModel.toggleFullScreen() },
                        onClearChecks = { viewModel.clearCheckedDimensions() },
                        onFinishMultiPoint = { viewModel.finishMultiPointOperation() },
                        modifier = Modifier
                            .align(Alignment.TopStart)
                            .padding(start = 10.dp, top = 10.dp, end = 62.dp)
                    )

                    CanvasViewportControls(
                        onFit = { viewModel.fitToScreen() },
                        onZoomIn = { viewModel.zoomBy(1.3) },
                        onZoomOut = { viewModel.zoomBy(1.0 / 1.3) },
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .padding(top = 10.dp, end = 10.dp)
                    )
                }

                FixedBottomMeasurementBar(
                    popup = state.measurementPopup,
                    unit = state.effectiveDisplayUnit,
                    precision = state.dimStyle.precision,
                    onSelectUnit = viewModel::setDisplayUnit,
                    onDeleteSelected = if (state.selectedEntityId != null) viewModel::deleteSelectedEntity else null,
                    onCopy = viewModel::copyPopupToClipboard,
                    onClose = viewModel::clearSelection
                )

                if (!state.fullScreenMode) {
                    BottomMobileNavBar(
                        state = state,
                        onSelectTool = viewModel::setTool,
                        onOpenMeasureSheet = { viewModel.openSheet(ActiveSheet.DIMENSIONS) }
                    )
                }
            }

            if (state.isLoading) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(Color.Black.copy(alpha = 0.72f)),
                    contentAlignment = Alignment.Center
                ) {
                    Card(colors = CardDefaults.cardColors(containerColor = SurfaceCard)) {
                        Column(
                            modifier = Modifier.padding(24.dp),
                            horizontalAlignment = Alignment.CenterHorizontally
                        ) {
                            CircularProgressIndicator(color = AccentCyan)
                            Spacer(Modifier.height(14.dp))
                            Text(
                                text = state.loadingMessage.ifBlank { "Opening CAD file..." },
                                color = Color.White,
                                fontWeight = FontWeight.Medium
                            )
                        }
                    }
                }
            }
        }
    }

    state.activeSheet?.let { sheet ->
        MobileBottomSheetModal(
            sheet = sheet,
            state = state,
            viewModel = viewModel,
            onDismiss = { viewModel.openSheet(null) },
            onOpenFile = onOpenFile,
            onExportPdf = onExportPdf,
            onExportPng = onExportPng,
            onOpenRecentUri = onOpenRecentUri
        )
    }

    state.errorMessage?.let { err ->
        AlertDialog(
            onDismissRequest = { viewModel.clearError() },
            containerColor = SurfaceCard,
            titleContentColor = Color(0xFFF87171),
            textContentColor = Color(0xFFE2E8F0),
            title = { Text("Cannot Open File") },
            text = { Text(err) },
            confirmButton = {
                TextButton(onClick = { viewModel.clearError() }) {
                    Text("OK", color = AccentCyan)
                }
            }
        )
    }
}

@Composable
private fun MobileTopHeader(
    canUndo: Boolean,
    canRedo: Boolean,
    onUndo: () -> Unit,
    onRedo: () -> Unit,
    onOpen: () -> Unit,
    settingsActive: Boolean,
    onOpenSettings: () -> Unit
) {
    Surface(color = SurfaceDark, tonalElevation = 4.dp) {
        Column(modifier = Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(54.dp)
                    .padding(horizontal = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                // App Logo + Name
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    modifier = Modifier.weight(1f)
                ) {
                    Box(
                        modifier = Modifier
                            .size(30.dp)
                            .clip(RoundedCornerShape(9.dp))
                            .background(AccentCyan.copy(alpha = 0.16f))
                            .border(1.dp, AccentCyan.copy(alpha = 0.45f), RoundedCornerShape(9.dp)),
                        contentAlignment = Alignment.Center
                    ) {
                        Icon(
                            Icons.Default.Architecture,
                            contentDescription = "CAD Master Logo",
                            tint = AccentCyan,
                            modifier = Modifier.size(17.dp)
                        )
                    }
                    Text(
                        text = "CAD Master",
                        color = Color.White,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }

                // Undo, Redo, Open File & Settings
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    Box(
                        modifier = Modifier
                            .size(36.dp, 40.dp)
                            .clip(RoundedCornerShape(10.dp))
                            .background(if (canUndo) SurfaceCard else Color(0xFF101520))
                            .border(1.dp, if (canUndo) BorderSubtle else Color(0xFF1B2332), RoundedCornerShape(10.dp))
                            .clickable(enabled = canUndo, onClick = onUndo),
                        contentAlignment = Alignment.Center
                    ) {
                        Icon(
                            Icons.Default.Undo,
                            contentDescription = "Undo",
                            tint = if (canUndo) Color.White else Color(0xFF475569),
                            modifier = Modifier.size(18.dp)
                        )
                    }

                    Box(
                        modifier = Modifier
                            .size(36.dp, 40.dp)
                            .clip(RoundedCornerShape(10.dp))
                            .background(if (canRedo) SurfaceCard else Color(0xFF101520))
                            .border(1.dp, if (canRedo) BorderSubtle else Color(0xFF1B2332), RoundedCornerShape(10.dp))
                            .clickable(enabled = canRedo, onClick = onRedo),
                        contentAlignment = Alignment.Center
                    ) {
                        Icon(
                            Icons.Default.Redo,
                            contentDescription = "Redo",
                            tint = if (canRedo) Color.White else Color(0xFF475569),
                            modifier = Modifier.size(18.dp)
                        )
                    }

                    Row(
                        modifier = Modifier
                            .height(40.dp)
                            .clip(RoundedCornerShape(10.dp))
                            .background(Color(0xFF0284C7))
                            .clickable(onClick = onOpen)
                            .padding(horizontal = 10.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Icon(Icons.Default.FolderOpen, contentDescription = "Open File", tint = Color.White, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(4.dp))
                        Text("Open", color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                    }

                    Box(
                        modifier = Modifier
                            .size(40.dp)
                            .clip(RoundedCornerShape(10.dp))
                            .background(if (settingsActive) AccentCyan.copy(alpha = 0.2f) else SurfaceCard)
                            .border(1.dp, if (settingsActive) AccentCyan else BorderSubtle, RoundedCornerShape(10.dp))
                            .clickable(onClick = onOpenSettings),
                        contentAlignment = Alignment.Center
                    ) {
                        Icon(
                            Icons.Default.Settings,
                            contentDescription = "Settings",
                            tint = if (settingsActive) AccentCyan else Color.White,
                            modifier = Modifier.size(19.dp)
                        )
                    }
                }
            }
            HorizontalDivider(color = BorderSubtle, thickness = 1.dp)
        }
    }
}

@Composable
private fun CanvasViewportControls(
    onFit: () -> Unit,
    onZoomIn: () -> Unit,
    onZoomOut: () -> Unit,
    modifier: Modifier = Modifier
) {
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        SmallHeaderIcon(Icons.Default.FitScreen, "Fit", onFit, tint = AccentCyan)
        SmallHeaderIcon(Icons.Default.ZoomIn, "Zoom In", onZoomIn)
        SmallHeaderIcon(Icons.Default.ZoomOut, "Zoom Out", onZoomOut)
    }
}

@Composable
private fun SmallHeaderIcon(
    icon: ImageVector,
    desc: String,
    onClick: () -> Unit,
    tint: Color = Color.White
) {
    Box(
        modifier = Modifier
            .size(40.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(SurfaceDark.copy(alpha = 0.88f))
            .border(1.dp, BorderSubtle, RoundedCornerShape(10.dp))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center
    ) {
        Icon(icon, contentDescription = desc, tint = tint, modifier = Modifier.size(19.dp))
    }
}

@Composable
private fun CanvasHud(
    state: CadUiState,
    onOpenSettingsFiles: () -> Unit,
    onExitFullScreen: () -> Unit,
    onClearChecks: () -> Unit,
    onFinishMultiPoint: () -> Unit,
    modifier: Modifier = Modifier
) {
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            if (state.fullScreenMode) {
                Box(
                    modifier = Modifier
                        .size(38.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(SurfaceDark.copy(alpha = 0.85f))
                        .border(1.dp, BorderSubtle, RoundedCornerShape(8.dp))
                        .clickable(onClick = onExitFullScreen),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(Icons.Default.FullscreenExit, contentDescription = "Exit Full Screen", tint = AccentCyan)
                }
            }

            Row(
                modifier = Modifier
                    .clip(RoundedCornerShape(10.dp))
                    .background(SurfaceDark.copy(alpha = 0.86f))
                    .border(1.dp, BorderSubtle, RoundedCornerShape(10.dp))
                    .clickable(onClick = onOpenSettingsFiles)
                    .padding(horizontal = 10.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                Text(
                    text = state.document.name,
                    color = Color(0xFFE2E8F0),
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false)
                )
                Text(
                    text = state.document.unit.code,
                    color = AccentCyan,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 11.sp
                )
            }
        }

        if (state.activeTool == ToolId.DIMENSION) {
            Row(
                modifier = Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .background(AccentCyan.copy(alpha = 0.16f))
                    .border(1.dp, AccentCyan.copy(alpha = 0.5f), RoundedCornerShape(6.dp))
                    .padding(horizontal = 8.dp, vertical = 4.dp)
            ) {
                Text(
                    text = "${state.activeDimensionKind.label}: ${state.activeDimensionKind.hint}",
                    color = AccentCyan,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Medium
                )
            }
        }

        if (state.activeTool == ToolId.DIMENSION &&
            state.activeDimensionKind in setOf(DimensionKind.AREA, DimensionKind.PERIMETER) &&
            state.pendingPoints.size >= 2
        ) {
            Button(
                onClick = onFinishMultiPoint,
                colors = ButtonDefaults.buttonColors(containerColor = AccentCyan, contentColor = Color.Black),
                contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp)
            ) {
                Icon(Icons.Default.Check, contentDescription = null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text("Finish (${state.pendingPoints.size} pts)", fontWeight = FontWeight.Bold)
            }
        }

        if (state.checkDimensions.isNotEmpty()) {
            Row(
                modifier = Modifier
                    .clip(RoundedCornerShape(8.dp))
                    .background(Color(0xFF450A0A).copy(alpha = 0.9f))
                    .border(1.dp, Color(0xFFEF4444).copy(alpha = 0.5f), RoundedCornerShape(8.dp))
                    .clickable(onClick = onClearChecks)
                    .padding(horizontal = 10.dp, vertical = 5.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Icon(Icons.Default.DeleteSweep, contentDescription = null, tint = Color(0xFFFCA5A5), modifier = Modifier.size(15.dp))
                Spacer(Modifier.width(5.dp))
                Text("Clear Checks (${state.checkDimensions.size})", color = Color(0xFFFECACA), fontSize = 11.sp)
            }
        }
    }
}

@Composable
private fun FixedBottomMeasurementBar(
    popup: ActiveMeasurementPopup?,
    unit: CadUnit,
    precision: Int,
    onSelectUnit: (CadUnit) -> Unit,
    onDeleteSelected: (() -> Unit)?,
    onCopy: () -> Unit,
    onClose: () -> Unit
) {
    Surface(color = Color(0xFF101521)) {
        Column(modifier = Modifier.fillMaxWidth()) {
            HorizontalDivider(color = if (popup != null) AccentCyan.copy(alpha = 0.6f) else BorderSubtle, thickness = 1.dp)

            if (popup == null) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text(
                        text = "Selected Line Length: Tap any line",
                        color = Color(0xFFCBD5E1),
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Medium,
                        modifier = Modifier.weight(1f),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    UnitSelectorChips(selectedUnit = unit, onSelectUnit = onSelectUnit)
                }
            } else {
                Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(popup.title, color = Color(0xFF94A3B8), fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                            Text(popup.primaryText, color = AccentCyan, fontSize = 17.sp, fontWeight = FontWeight.Bold)
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                            Button(
                                onClick = onCopy,
                                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF0284C7)),
                                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 6.dp)
                            ) {
                                Icon(Icons.Default.ContentCopy, contentDescription = "Copy", modifier = Modifier.size(15.dp))
                                Spacer(Modifier.width(4.dp))
                                Text("Copy", fontSize = 12.sp)
                            }
                            if (onDeleteSelected != null) {
                                IconButton(onClick = onDeleteSelected) {
                                    Icon(Icons.Default.Delete, contentDescription = "Delete Selected", tint = Color(0xFFFCA5A5))
                                }
                            }
                            IconButton(onClick = onClose) {
                                Icon(Icons.Default.Close, contentDescription = "Close", tint = Color(0xFF94A3B8))
                            }
                        }
                    }

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text(
                            text = popup.subtitle,
                            color = Color(0xFFE2E8F0),
                            fontSize = 11.sp,
                            modifier = Modifier.weight(1f),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                        Spacer(Modifier.width(6.dp))
                        UnitSelectorChips(selectedUnit = unit, onSelectUnit = onSelectUnit)
                    }

                    if (popup.start != null && popup.end != null) {
                        Spacer(Modifier.height(3.dp))
                        Text(
                            text = "Start (${CadUnits.formatCoord(popup.start.x, precision)}, ${CadUnits.formatCoord(popup.start.y, precision)}) -> End (${CadUnits.formatCoord(popup.end.x, precision)}, ${CadUnits.formatCoord(popup.end.y, precision)})",
                            color = Color(0xFF94A3B8),
                            fontFamily = FontFamily.Monospace,
                            fontSize = 10.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                    }

                    if (popup.segments.isNotEmpty()) {
                        Spacer(Modifier.height(6.dp))
                        Row(
                            modifier = Modifier.horizontalScroll(rememberScrollState()),
                            horizontalArrangement = Arrangement.spacedBy(6.dp)
                        ) {
                            popup.segments.take(12).forEach { seg ->
                                val isSel = seg.index == popup.selectedSegmentIndex
                                Box(
                                    modifier = Modifier
                                        .clip(RoundedCornerShape(6.dp))
                                        .background(if (isSel) AccentCyan.copy(alpha = 0.22f) else SurfaceDark)
                                        .border(1.dp, if (isSel) AccentCyan else BorderSubtle, RoundedCornerShape(6.dp))
                                        .padding(horizontal = 8.dp, vertical = 4.dp)
                                ) {
                                    Text(
                                        text = "Seg ${seg.index + 1}: ${CadUnits.formatLength(seg.length, unit, unit, precision)}",
                                        color = if (isSel) AccentCyan else Color.LightGray,
                                        fontSize = 10.sp
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun UnitSelectorChips(
    selectedUnit: CadUnit,
    onSelectUnit: (CadUnit) -> Unit
) {
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        listOf(CadUnit.MM, CadUnit.CM, CadUnit.M, CadUnit.IN, CadUnit.FT).forEach { u ->
            val active = selectedUnit == u
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .background(if (active) Color(0xFF0284C7) else SurfaceCard)
                    .border(1.dp, if (active) AccentCyan else BorderSubtle, RoundedCornerShape(6.dp))
                    .clickable { onSelectUnit(u) }
                    .padding(horizontal = 6.dp, vertical = 4.dp)
            ) {
                Text(
                    text = u.code,
                    color = if (active) Color.White else Color(0xFF94A3B8),
                    fontSize = 10.sp,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.SemiBold
                )
            }
        }
    }
}

@Composable
private fun BottomMobileNavBar(
    state: CadUiState,
    onSelectTool: (ToolId) -> Unit,
    onOpenMeasureSheet: () -> Unit
) {
    Surface(color = SurfaceDark, tonalElevation = 6.dp) {
        Column(modifier = Modifier.fillMaxWidth()) {
            HorizontalDivider(color = BorderSubtle, thickness = 1.dp)
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 8.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                NavBarButton(
                    label = "Select",
                    icon = Icons.Default.NearMe,
                    selected = state.activeTool == ToolId.SELECT && state.activeSheet == null,
                    modifier = Modifier.weight(1f)
                ) { onSelectTool(ToolId.SELECT) }

                NavBarButton(
                    label = "Pan",
                    icon = Icons.Default.PanTool,
                    selected = state.activeTool == ToolId.PAN && state.activeSheet == null,
                    modifier = Modifier.weight(1f)
                ) { onSelectTool(ToolId.PAN) }

                NavBarButton(
                    label = "Line Length",
                    icon = Icons.Default.TouchApp,
                    selected = state.activeTool == ToolId.MEASURE && state.activeSheet == null,
                    modifier = Modifier.weight(1f)
                ) { onSelectTool(ToolId.MEASURE) }

                NavBarButton(
                    label = "Measure",
                    icon = Icons.Default.Straighten,
                    selected = state.activeSheet == ActiveSheet.DIMENSIONS || (state.activeTool == ToolId.DIMENSION && state.activeSheet == null),
                    modifier = Modifier.weight(1f)
                ) { onOpenMeasureSheet() }
            }
        }
    }
}

@Composable
private fun NavBarButton(
    label: String,
    icon: ImageVector,
    selected: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit
) {
    val fg = if (selected) AccentCyan else Color(0xFF94A3B8)
    Column(
        modifier = modifier
            .defaultMinSize(minHeight = 52.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(if (selected) AccentCyan.copy(alpha = 0.16f) else Color.Transparent)
            .clickable(onClick = onClick)
            .padding(horizontal = 4.dp, vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Icon(icon, contentDescription = label, tint = fg, modifier = Modifier.size(21.dp))
        Spacer(Modifier.height(2.dp))
        Text(
            text = label,
            color = fg,
            fontSize = 11.sp,
            fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium,
            maxLines = 1
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MobileBottomSheetModal(
    sheet: ActiveSheet,
    state: CadUiState,
    viewModel: CadViewModel,
    onDismiss: () -> Unit,
    onOpenFile: () -> Unit,
    onExportPdf: () -> Unit,
    onExportPng: () -> Unit,
    onOpenRecentUri: (String) -> Unit
) {
    var settingsTab by remember { mutableStateOf(SettingsTab.FILES) }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = SurfaceDark,
        contentColor = Color.White
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp)
                .padding(bottom = 28.dp)
        ) {
            when (sheet) {
                ActiveSheet.DIMENSIONS -> {
                    Text("Dimension Tools", fontSize = 17.sp, fontWeight = FontWeight.Bold)
                    Text("Choose a measurement tool, then tap on the drawing", color = Color(0xFF94A3B8), fontSize = 12.sp)
                    Spacer(Modifier.height(10.dp))
                    LazyVerticalGrid(
                        columns = GridCells.Fixed(2),
                        modifier = Modifier.heightIn(max = 360.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        items(CHECK_DIM_KINDS) { kind ->
                            val selected = state.activeTool == ToolId.DIMENSION && state.activeDimensionKind == kind
                            Column(
                                modifier = Modifier
                                    .defaultMinSize(minHeight = 56.dp)
                                    .clip(RoundedCornerShape(10.dp))
                                    .background(if (selected) AccentCyan.copy(alpha = 0.2f) else SurfaceCard)
                                    .border(1.dp, if (selected) AccentCyan else BorderSubtle, RoundedCornerShape(10.dp))
                                    .clickable { viewModel.selectDimensionKind(kind) }
                                    .padding(10.dp)
                            ) {
                                Text(kind.label, color = if (selected) AccentCyan else Color.White, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                                Text(kind.hint, color = Color(0xFF94A3B8), fontSize = 10.sp)
                            }
                        }
                    }
                    if (state.checkDimensions.isNotEmpty()) {
                        Spacer(Modifier.height(10.dp))
                        OutlinedButton(
                            onClick = { viewModel.clearCheckedDimensions() },
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text("Clear Checked Dimensions (${state.checkDimensions.size})", color = Color(0xFFF87171))
                        }
                    }
                }

                ActiveSheet.SETTINGS -> {
                    Text("Viewer Settings & Files", fontSize = 17.sp, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(10.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        SettingsTab.entries.forEach { tab ->
                            val active = settingsTab == tab
                            Box(
                                modifier = Modifier
                                    .weight(1f)
                                    .clip(RoundedCornerShape(10.dp))
                                    .background(if (active) Color(0xFF0284C7) else SurfaceCard)
                                    .border(1.dp, if (active) AccentCyan else BorderSubtle, RoundedCornerShape(10.dp))
                                    .clickable { settingsTab = tab }
                                    .padding(vertical = 8.dp),
                                contentAlignment = Alignment.Center
                            ) {
                                Text(tab.label, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = Color.White)
                            }
                        }
                    }
                    Spacer(Modifier.height(12.dp))

                    when (settingsTab) {
                        SettingsTab.FILES -> {
                            Button(
                                onClick = onOpenFile,
                                modifier = Modifier.fillMaxWidth().height(48.dp),
                                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF0284C7))
                            ) {
                                Icon(Icons.Default.FolderOpen, null)
                                Spacer(Modifier.width(8.dp))
                                Text("Open DWG / DXF File")
                            }
                            Spacer(Modifier.height(10.dp))
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                OutlinedButton(onClick = { viewModel.loadSample(false) }, modifier = Modifier.weight(1f)) {
                                    Text("Floor Plan")
                                }
                                OutlinedButton(onClick = { viewModel.loadSample(true) }, modifier = Modifier.weight(1f)) {
                                    Text("Flange Part")
                                }
                            }
                            Spacer(Modifier.height(8.dp))
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                OutlinedButton(onClick = { viewModel.fitToScreen(); onDismiss() }, modifier = Modifier.weight(1f)) {
                                    Text("Fit Screen")
                                }
                                OutlinedButton(onClick = { viewModel.toggleFullScreen(); onDismiss() }, modifier = Modifier.weight(1f)) {
                                    Text(if (state.fullScreenMode) "Exit Full" else "Full Screen")
                                }
                            }
                            Spacer(Modifier.height(8.dp))
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                OutlinedButton(onClick = onExportPdf, modifier = Modifier.weight(1f)) {
                                    Icon(Icons.Default.PictureAsPdf, contentDescription = null, modifier = Modifier.size(16.dp))
                                    Spacer(Modifier.width(6.dp))
                                    Text("Export PDF")
                                }
                                OutlinedButton(onClick = onExportPng, modifier = Modifier.weight(1f)) {
                                    Icon(Icons.Default.Image, contentDescription = null, modifier = Modifier.size(16.dp))
                                    Spacer(Modifier.width(6.dp))
                                    Text("Export PNG")
                                }
                            }
                            Spacer(Modifier.height(10.dp))
                            Text("Recent Files", color = Color(0xFF94A3B8), fontSize = 12.sp)
                            Spacer(Modifier.height(6.dp))
                            LazyColumn(modifier = Modifier.heightIn(max = 180.dp)) {
                                items(state.recentFiles) { rf ->
                                    ListItem(
                                        headlineContent = { Text(rf.displayName, color = Color.White) },
                                        supportingContent = { Text("${rf.format} • ${rf.entityCount} objs", color = Color(0xFF94A3B8), fontSize = 12.sp) },
                                        trailingContent = {
                                            IconButton(onClick = { viewModel.deleteRecent(rf.uriString) }) {
                                                Icon(Icons.Default.DeleteOutline, null, tint = Color(0xFF94A3B8))
                                            }
                                        },
                                        modifier = Modifier.clickable { onOpenRecentUri(rf.uriString) },
                                        colors = ListItemDefaults.colors(containerColor = SurfaceCard)
                                    )
                                    Spacer(Modifier.height(4.dp))
                                }
                            }
                        }

                        SettingsTab.LAYERS -> {
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                                Text("Layers (${state.document.layers.size})", fontWeight = FontWeight.SemiBold)
                                Row {
                                    TextButton(onClick = { viewModel.setAllLayersVisible(true) }) { Text("All On", color = AccentCyan) }
                                    TextButton(onClick = { viewModel.setAllLayersVisible(false) }) { Text("All Off", color = Color(0xFFF87171)) }
                                }
                            }
                            LazyColumn(modifier = Modifier.heightIn(max = 320.dp)) {
                                items(state.document.layers) { layer ->
                                    val col = Color(AciColors.resolveColor(layer.colorIndex, null, layer.colorIndex, true))
                                    Row(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .clickable { viewModel.toggleLayerVisibility(layer.name) }
                                            .padding(vertical = 8.dp),
                                        verticalAlignment = Alignment.CenterVertically
                                    ) {
                                        Box(Modifier.size(14.dp).clip(CircleShape).background(col))
                                        Spacer(Modifier.width(12.dp))
                                        Text(layer.name, modifier = Modifier.weight(1f), color = Color.White)
                                        Switch(
                                            checked = layer.visible,
                                            onCheckedChange = { viewModel.toggleLayerVisibility(layer.name) }
                                        )
                                    }
                                }
                            }
                        }

                        SettingsTab.UNITS -> {
                            Text("Drawing Units", color = Color(0xFF94A3B8), fontSize = 12.sp)
                            Row(modifier = Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                listOf(CadUnit.MM, CadUnit.CM, CadUnit.M, CadUnit.IN, CadUnit.FT).forEach { u ->
                                    FilterChip(
                                        selected = state.document.unit == u,
                                        onClick = { viewModel.setUnit(u) },
                                        label = { Text("${u.label} (${u.code})") }
                                    )
                                }
                            }
                            Spacer(Modifier.height(6.dp))
                            Text("Decimal Precision", color = Color(0xFF94A3B8), fontSize = 12.sp)
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                (0..4).forEach { p ->
                                    FilterChip(
                                        selected = state.dimStyle.precision == p,
                                        onClick = { viewModel.setPrecision(p) },
                                        label = { Text("$p") }
                                    )
                                }
                            }
                            Spacer(Modifier.height(6.dp))
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                                Text("Show Coordinate Grid")
                                Switch(checked = state.gridVisible, onCheckedChange = { viewModel.toggleGrid() })
                            }
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                                Text("Black Background")
                                Switch(checked = state.darkBackground, onCheckedChange = { viewModel.toggleBackground() })
                            }
                        }

                        SettingsTab.SNAP -> {
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                                Text("Object Snap (OSNAP)", fontWeight = FontWeight.SemiBold)
                                Switch(
                                    checked = state.osnapSettings.enabled,
                                    onCheckedChange = { enabled -> viewModel.updateOsnap { it.copy(enabled = enabled) } }
                                )
                            }
                            LazyVerticalGrid(
                                columns = GridCells.Fixed(2),
                                modifier = Modifier.heightIn(max = 220.dp),
                                horizontalArrangement = Arrangement.spacedBy(6.dp),
                                verticalArrangement = Arrangement.spacedBy(6.dp)
                            ) {
                                items(OsnapType.entries) { mode ->
                                    val on = mode in state.osnapSettings.modes
                                    FilterChip(
                                        selected = on,
                                        onClick = {
                                            viewModel.updateOsnap { cur ->
                                                val next = if (on) cur.modes - mode else cur.modes + mode
                                                cur.copy(modes = next)
                                            }
                                        },
                                        label = { Text(mode.label, fontSize = 11.sp) }
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
