package com.cadmaster.offline

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.Color
import com.cadmaster.offline.ui.CadMasterScreen

class MainActivity : ComponentActivity() {
    private val viewModel: CadViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT)
        )

        if (intent?.action == Intent.ACTION_VIEW) {
            intent.data?.let { uri -> viewModel.openLocalUri(uri) }
        }

        setContent {
            val state by viewModel.uiState.collectAsState()

            val openCadLauncher = rememberLauncherForActivityResult(
                contract = ActivityResultContracts.OpenDocument()
            ) { uri: Uri? ->
                uri?.let { viewModel.openLocalUri(it) }
            }

            val exportPdfLauncher = rememberLauncherForActivityResult(
                contract = ActivityResultContracts.CreateDocument("application/pdf")
            ) { uri: Uri? ->
                uri?.let { viewModel.exportPdfToUri(it) }
            }

            val exportPngLauncher = rememberLauncherForActivityResult(
                contract = ActivityResultContracts.CreateDocument("image/png")
            ) { uri: Uri? ->
                uri?.let { viewModel.exportPngToUri(it) }
            }

            LaunchedEffect(Unit) {
                viewModel.fitToScreen()
            }

            MaterialTheme(
                colorScheme = darkColorScheme(
                    primary = Color(0xFF38BDF8),
                    background = Color.Black,
                    surface = Color(0xFF0D1119)
                )
            ) {
                CadMasterScreen(
                    state = state,
                    onOpenFile = { openCadLauncher.launch(arrayOf("*/*")) },
                    onExportPdf = {
                        val base = state.document.name.substringBeforeLast('.')
                        exportPdfLauncher.launch("${base}_cad_master.pdf")
                    },
                    onExportPng = {
                        val base = state.document.name.substringBeforeLast('.')
                        exportPngLauncher.launch("${base}_cad_master.png")
                    },
                    viewModel = viewModel,
                    onOpenRecentUri = { uriStr ->
                        viewModel.openLocalUri(Uri.parse(uriStr))
                    }
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.action == Intent.ACTION_VIEW) {
            intent.data?.let { uri -> viewModel.openLocalUri(uri) }
        }
    }
}
