package com.cadmaster.offline.cad

/**
 * Standard AutoCAD Color Index (ACI 1..255) palette mapped to ARGB hex longs,
 * plus contrast resolution for black CAD workspaces.
 */
object AciColors {
    private val STANDARD_ACI: Map<Int, Long> = mapOf(
        0 to 0xFFFFFFFFL, // ByBlock
        1 to 0xFFFF3B30L, // Red
        2 to 0xFFFACC15L, // Yellow
        3 to 0xFF22C55EL, // Green
        4 to 0xFF06B6D4L, // Cyan
        5 to 0xFF3B82F6L, // Blue
        6 to 0xFFD946EFL, // Magenta
        7 to 0xFFF8FAFC,   // White (contrast-adapted)
        8 to 0xFF64748BL, // Dark Gray
        9 to 0xFF94A3B8L, // Light Gray
        10 to 0xFFFF0000L,
        11 to 0xFFFF7F7FL,
        12 to 0xFFCC0000L,
        20 to 0xFFFF3F00L,
        30 to 0xFFFF7F00L,
        40 to 0xFFFFBF00L,
        50 to 0xFFFFFF00L,
        60 to 0xFFBFFF00L,
        70 to 0xFF7FFF00L,
        80 to 0xFF3FFF00L,
        90 to 0xFF00FF00L,
        100 to 0xFF00FF3FL,
        110 to 0xFF00FF7FL,
        120 to 0xFF00FFBFL,
        130 to 0xFF00FFFFL,
        140 to 0xFF00BFFFL,
        150 to 0xFF007FFFL,
        160 to 0xFF003FFFL,
        170 to 0xFF3B82F6L,
        180 to 0xFF6366F1L,
        190 to 0xFF8B5CF6L,
        200 to 0xFFA855F7L,
        210 to 0xFFD946EFL,
        220 to 0xFFEC4899L,
        230 to 0xFFF43F5EL,
        240 to 0xFFF43F5EL,
        250 to 0xFF475569L,
        251 to 0xFF64748BL,
        252 to 0xFF94A3B8L,
        253 to 0xFFCBD5E1L,
        254 to 0xFFE2E8F0L,
        255 to 0xFFFFFFFFL
    )

    fun resolveColor(
        entityColorIndex: Int,
        trueColor: Long?,
        layerColorIndex: Int,
        darkBackground: Boolean = true
    ): Long {
        if (trueColor != null) {
            return (0xFF000000L or (trueColor and 0x00FFFFFFL))
        }
        val effectiveIndex = when {
            entityColorIndex == 256 || entityColorIndex < 0 -> layerColorIndex
            entityColorIndex == 0 -> 7
            else -> entityColorIndex
        }
        val base = STANDARD_ACI[effectiveIndex] ?: fallbackAci(effectiveIndex)
        if (effectiveIndex == 7 || effectiveIndex == 255) {
            return if (darkBackground) 0xFFF1F5F9L else 0xFF0F172AL
        }
        return base
    }

    private fun fallbackAci(index: Int): Long {
        val clamped = index.coerceIn(1, 255)
        if (clamped >= 250) {
            val v = 60 + (clamped - 250) * 35
            return 0xFF000000L or ((v shl 16) or (v shl 8) or v).toLong()
        }
        val hue = ((clamped - 10).coerceAtLeast(0) % 240) / 240.0 * 360.0
        val sat = if (clamped % 2 == 0) 0.85 else 0.55
        val light = 0.58
        return hslToArgb(hue, sat, light)
    }

    private fun hslToArgb(h: Double, s: Double, l: Double): Long {
        val c = (1.0 - kotlin.math.abs(2.0 * l - 1.0)) * s
        val x = c * (1.0 - kotlin.math.abs((h / 60.0) % 2.0 - 1.0))
        val m = l - c / 2.0
        val (r1, g1, b1) = when {
            h < 60 -> Triple(c, x, 0.0)
            h < 120 -> Triple(x, c, 0.0)
            h < 180 -> Triple(0.0, c, x)
            h < 240 -> Triple(0.0, x, c)
            h < 300 -> Triple(x, 0.0, c)
            else -> Triple(c, 0.0, x)
        }
        val r = ((r1 + m) * 255).toInt().coerceIn(0, 255)
        val g = ((g1 + m) * 255).toInt().coerceIn(0, 255)
        val b = ((b1 + m) * 255).toInt().coerceIn(0, 255)
        return 0xFF000000L or ((r.toLong() shl 16) or (g.toLong() shl 8) or b.toLong())
    }
}
