package com.cadmaster.offline.cad

import java.util.Locale
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.roundToInt

object CadUnits {
    private val TO_MM = mapOf(
        CadUnit.MM to 1.0,
        CadUnit.CM to 10.0,
        CadUnit.M to 1000.0,
        CadUnit.IN to 25.4,
        CadUnit.FT to 304.8,
        CadUnit.UNDEFINED to 1.0
    )

    fun fromDxfInsUnits(insUnits: Int?): CadUnit {
        return when (insUnits) {
            1 -> CadUnit.IN
            2 -> CadUnit.FT
            4 -> CadUnit.MM
            5 -> CadUnit.CM
            6 -> CadUnit.M
            else -> CadUnit.UNDEFINED
        }
    }

    fun convert(value: Double, from: CadUnit, to: CadUnit): Double {
        if (from == to || from == CadUnit.UNDEFINED || to == CadUnit.UNDEFINED) {
            return value
        }
        val mm = value * (TO_MM[from] ?: 1.0)
        return mm / (TO_MM[to] ?: 1.0)
    }

    fun convertArea(areaInFromSq: Double, from: CadUnit, to: CadUnit): Double {
        if (from == to || from == CadUnit.UNDEFINED || to == CadUnit.UNDEFINED) {
            return areaInFromSq
        }
        val linear = (TO_MM[from] ?: 1.0) / (TO_MM[to] ?: 1.0)
        return areaInFromSq * linear * linear
    }

    fun formatLength(
        rawDrawingValue: Double,
        drawingUnit: CadUnit,
        displayUnit: CadUnit = drawingUnit,
        precision: Int = 2,
        format: UnitFormat = UnitFormat.DECIMAL,
        scaleFactor: Double = 1.0,
        includeUnit: Boolean = true
    ): String {
        val scaled = convert(rawDrawingValue * scaleFactor, drawingUnit, displayUnit)
        val p = precision.coerceIn(0, 6)

        if (format == UnitFormat.ARCHITECTURAL && (displayUnit == CadUnit.IN || displayUnit == CadUnit.FT)) {
            val totalInches = if (displayUnit == CadUnit.FT) scaled * 12.0 else scaled
            val sign = if (totalInches < 0) "-" else ""
            val absIn = abs(totalInches)
            val feet = floor(absIn / 12.0).toInt()
            val remIn = absIn - feet * 12.0
            val wholeIn = floor(remIn).toInt()
            val sixteenths = ((remIn - wholeIn) * 16.0).roundToInt()
            val frac = simplifyFraction(sixteenths, 16)
            return "$sign$feet'-$wholeIn${if (frac.isNotEmpty()) " $frac" else ""}\""
        }

        if (format == UnitFormat.ENGINEERING && (displayUnit == CadUnit.IN || displayUnit == CadUnit.FT)) {
            val totalInches = if (displayUnit == CadUnit.FT) scaled * 12.0 else scaled
            val sign = if (totalInches < 0) "-" else ""
            val absIn = abs(totalInches)
            val feet = floor(absIn / 12.0).toInt()
            val remIn = absIn - feet * 12.0
            return "$sign$feet'-${String.format(Locale.US, "%.${p}f", remIn)}\""
        }

        if (format == UnitFormat.FRACTIONAL) {
            val whole = floor(abs(scaled)).toInt()
            val sixteenths = ((abs(scaled) - whole) * 16.0).roundToInt()
            val frac = simplifyFraction(sixteenths, 16)
            val sign = if (scaled < 0) "-" else ""
            val suffix = if (includeUnit) " ${displayUnit.code}" else ""
            return "$sign$whole${if (frac.isNotEmpty()) " $frac" else ""}$suffix"
        }

        val numStr = String.format(Locale.US, "%.${p}f", scaled)
        return if (includeUnit) "$numStr ${displayUnit.code}" else numStr
    }

    fun formatArea(
        rawDrawingArea: Double,
        drawingUnit: CadUnit,
        displayUnit: CadUnit = drawingUnit,
        precision: Int = 2,
        scaleFactor: Double = 1.0
    ): String {
        val converted = convertArea(rawDrawingArea * scaleFactor * scaleFactor, drawingUnit, displayUnit)
        val p = precision.coerceIn(0, 6)
        return "${String.format(Locale.US, "%.${p}f", converted)} ${displayUnit.code}²"
    }

    fun formatAngle(angleDeg: Double, precision: Int = 2): String {
        val p = precision.coerceIn(0, 4)
        return "${String.format(Locale.US, "%.${p}f", angleDeg)}°"
    }

    fun formatCoord(value: Double, precision: Int = 2): String {
        return String.format(Locale.US, "%.${precision.coerceIn(0, 6)}f", value)
    }

    private fun simplifyFraction(num: Int, den: Int): String {
        if (num <= 0) return ""
        if (num >= den) return ""
        var a = num
        var b = den
        while (b != 0) {
            val t = a % b
            a = b
            b = t
        }
        return "${num / a}/${den / a}"
    }
}
