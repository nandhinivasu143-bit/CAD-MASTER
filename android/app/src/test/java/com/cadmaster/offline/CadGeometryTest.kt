package com.cadmaster.offline

import com.cadmaster.offline.cad.*
import org.junit.Assert.*
import org.junit.Test
import kotlin.math.PI

class CadGeometryTest {

    @Test
    fun `measures 45 degree line accurately in world coordinates`() {
        val len = 1250.0
        val leg = len / kotlin.math.sqrt(2.0)
        val line = CadEntity.Line(
            id = "l1",
            layer = "0",
            start = Point2D(100.0, 200.0),
            end = Point2D(100.0 + leg, 200.0 + leg)
        )
        val meas = CadGeometry.measureEntity(line)
        assertEquals(1250.0, meas.primaryValue, 1e-4)
        assertEquals(45.0, meas.angleDeg!!, 1e-4)
        assertEquals(leg, meas.dx!!, 1e-4)
        assertEquals(leg, meas.dy!!, 1e-4)
    }

    @Test
    fun `parses sample architectural dxf with layers and INSUNITS`() {
        val doc = SampleDrawings.loadArchitecturalSample()
        assertEquals("DXF", doc.format)
        assertEquals(CadUnit.MM, doc.unit)
        assertTrue(doc.layers.any { it.name == "WALLS" })
        assertTrue(doc.entities.size >= 8)

        val closedPoly = doc.entities.filterIsInstance<CadEntity.LwPolyline>().first { it.closed }
        val meas = CadGeometry.measureEntity(closedPoly)
        assertEquals(41000.0, meas.primaryValue, 1e-4)
        assertEquals(102000000.0, meas.circumferenceOrArea!!, 1e-2)
    }

    @Test
    fun `finds endpoint midpoint center and intersection osnaps`() {
        val l1 = CadEntity.Line("l1", "0", start = Point2D(0.0, 0.0), end = Point2D(100.0, 100.0))
        val l2 = CadEntity.Line("l2", "0", start = Point2D(0.0, 100.0), end = Point2D(100.0, 0.0))
        val c1 = CadEntity.Circle("c1", "0", center = Point2D(200.0, 200.0), radius = 40.0)
        val entities = listOf(l1, l2, c1)
        val visible = setOf("0")
        val settings = OsnapSettings(enabled = true, snapRadiusPx = 40f)

        val endSnap = CadOsnap.findBestSnap(Point2D(1.5, 1.0), entities, visible, settings, viewportScale = 2.0)
        assertNotNull(endSnap)
        assertEquals(OsnapType.ENDPOINT, endSnap!!.type)
        assertEquals(0.0, endSnap.point.x, 1e-6)

        val intSnap = CadOsnap.findBestSnap(Point2D(51.0, 49.5), entities, visible, settings, viewportScale = 2.0)
        assertNotNull(intSnap)
        assertEquals(OsnapType.INTERSECTION, intSnap!!.type)
        assertEquals(50.0, intSnap.point.x, 1e-4)
        assertEquals(50.0, intSnap.point.y, 1e-4)

        val cenSnap = CadOsnap.findBestSnap(Point2D(202.0, 199.0), entities, visible, settings, viewportScale = 2.0)
        assertNotNull(cenSnap)
        assertEquals(OsnapType.CENTER, cenSnap!!.type)
    }

    @Test
    fun `converts units accurately between mm cm m inches and feet`() {
        assertEquals(25.4, CadUnits.convert(1.0, CadUnit.IN, CadUnit.MM), 1e-6)
        assertEquals(12.0, CadUnits.convert(1.0, CadUnit.FT, CadUnit.IN), 1e-6)
        assertEquals(1.0, CadUnits.convert(1000.0, CadUnit.MM, CadUnit.M), 1e-6)
        assertEquals(2.54, CadUnits.convert(1.0, CadUnit.IN, CadUnit.CM), 1e-6)
        assertEquals(PI * 25.0 * 25.0, CadGeometry.measureEntity(CadEntity.Circle("c", "0", center = Point2D(0.0, 0.0), radius = 25.0)).circumferenceOrArea!!, 1e-4)
    }
}
