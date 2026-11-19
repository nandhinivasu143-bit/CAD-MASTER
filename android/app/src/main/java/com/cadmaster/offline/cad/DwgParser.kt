package com.cadmaster.offline.cad

import java.io.File
import java.io.InputStream

object DwgNativeBridge {
    private val libraryLoaded: Boolean by lazy {
        try {
            System.loadLibrary("cadmaster_dwg")
            true
        } catch (_: UnsatisfiedLinkError) {
            false
        }
    }

    fun isNativeAvailable(): Boolean = libraryLoaded && try {
        nativeIsLibredwgLinked()
    } catch (_: Throwable) {
        false
    }

    fun inspectHeader(filePath: String): String {
        if (!libraryLoaded) {
            return File(filePath).inputStream().use { ins ->
                val bytes = ByteArray(6)
                val read = ins.read(bytes)
                if (read == 6) String(bytes, Charsets.US_ASCII) else ""
            }
        }
        return nativeInspectDwgHeader(filePath)
    }

    fun readDwgToDxf(filePath: String): String {
        if (!libraryLoaded) {
            return "ERROR:JNI library cadmaster_dwg not loaded."
        }
        return nativeReadDwgToDxf(filePath)
    }

    @JvmStatic
    external fun nativeIsLibredwgLinked(): Boolean

    @JvmStatic
    external fun nativeInspectDwgHeader(filePath: String): String

    @JvmStatic
    external fun nativeReadDwgToDxf(filePath: String): String
}

object DwgParser {
    private val SUPPORTED_DWG_VERSIONS = mapOf(
        "AC1012" to "AutoCAD R13 DWG",
        "AC1014" to "AutoCAD R14 DWG",
        "AC1015" to "AutoCAD 2000–2002 DWG",
        "AC1018" to "AutoCAD 2004–2006 DWG",
        "AC1021" to "AutoCAD 2007–2009 DWG",
        "AC1024" to "AutoCAD 2010–2012 DWG",
        "AC1027" to "AutoCAD 2013–2017 DWG",
        "AC1032" to "AutoCAD 2018–2025 DWG"
    )

    private val UNSUPPORTED_LEGACY_VERSIONS = mapOf(
        "AC1002" to "AutoCAD R2.5",
        "AC1003" to "AutoCAD R2.6",
        "AC1004" to "AutoCAD R9",
        "AC1006" to "AutoCAD R10",
        "AC1009" to "AutoCAD R11/R12"
    )

    fun parseFromStream(
        name: String,
        inputStream: InputStream,
        cacheDir: File,
        sourceUri: String? = null
    ): CadDocument {
        val tempFile = File(cacheDir, "dwg_import_${System.currentTimeMillis()}.dwg")
        try {
            tempFile.outputStream().use { out ->
                inputStream.copyTo(out)
            }
            val header = DwgNativeBridge.inspectHeader(tempFile.absolutePath)
            if (header.isBlank() || !header.startsWith("AC")) {
                throw IllegalArgumentException(
                    "Invalid binary DWG file '$name'. Header signature '$header' is not a recognized AutoCAD DWG."
                )
            }
            UNSUPPORTED_LEGACY_VERSIONS[header]?.let { legacyName ->
                throw IllegalArgumentException(
                    "Unsupported DWG version: $legacyName ($header). Only AutoCAD R13–2025 (AC1012–AC1032) DWG or ASCII DXF files are supported offline."
                )
            }
            val versionLabel = SUPPORTED_DWG_VERSIONS[header]
                ?: throw IllegalArgumentException(
                    "Unsupported or unknown DWG version code '$header' in '$name'. Please convert to DXF or AutoCAD 2000–2024 DWG."
                )

            if (!DwgNativeBridge.isNativeAvailable()) {
                throw IllegalStateException(
                    "Detected valid $versionLabel ($header), but the optional native LibreDWG shared library (libredwg.so) is not bundled in this APK build. Open a DXF file or build with LibreDWG NDK per android/README_BUILD_APK.md."
                )
            }

            val dxfOrError = DwgNativeBridge.readDwgToDxf(tempFile.absolutePath)
            if (dxfOrError.startsWith("ERROR:")) {
                throw IllegalStateException(dxfOrError.removePrefix("ERROR:"))
            }

            val doc = DxfParser.parseString(name, dxfOrError, sourceUri)
            return doc.copy(
                format = "DWG",
                versionCode = header,
                versionLabel = versionLabel
            )
        } finally {
            tempFile.delete()
        }
    }
}
