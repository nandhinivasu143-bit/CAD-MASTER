import { jsPDF } from 'jspdf';
import { getDocumentBounds, measureEntity } from './geometry';
import { CadDocument, CadEntity, DimensionEntity } from './types';
import { cadUnitToInsunits, formatAngle, formatArea, formatLength, UNIT_LABELS, UNIT_SHORT } from './units';

async function downloadBlob(blob: Blob, filename: string, useSavePicker = false) {
  const win = window as unknown as {
    showSaveFilePicker?: (opts: {
      suggestedName?: string;
      types?: { description: string; accept: Record<string, string[]> }[];
    }) => Promise<{
      createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }>;
    }>;
  };
  if (useSavePicker && typeof win.showSaveFilePicker === 'function') {
    try {
      const ext = filename.endsWith('.dxf') ? '.dxf' : '.bin';
      const handle = await win.showSaveFilePicker({
        suggestedName: filename,
        types: [
          {
            description: 'AutoCAD DXF Drawing',
            accept: { 'application/dxf': [ext] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      // Fallback to standard local download if picker blocked in iframe
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Exports the entire CAD document (entities + dimension annotations) as standard AutoCAD R2000 DXF (AC1015).
 */
export function exportDocumentToDxf(doc: CadDocument, customFileName?: string, useSavePicker = false) {
  const out: string[] = [];
  const push = (...vals: (string | number)[]) => {
    for (const v of vals) out.push(String(v));
  };

  push('0', 'SECTION', '2', 'HEADER');
  push('9', '$ACADVER', '1', 'AC1015');
  push('9', '$INSUNITS', '70', cadUnitToInsunits(doc.nativeUnit));
  push('0', 'ENDSEC');

  const layerList = Object.values(doc.layers);
  push('0', 'SECTION', '2', 'TABLES');
  push('0', 'TABLE', '2', 'LAYER', '70', layerList.length);
  for (const l of layerList) {
    push('0', 'LAYER', '2', l.name, '70', l.locked ? 4 : 0, '62', l.visible ? Math.abs(l.aci || 7) : -Math.abs(l.aci || 7), '6', 'CONTINUOUS');
  }
  push('0', 'ENDTAB', '0', 'ENDSEC');

  push('0', 'SECTION', '2', 'ENTITIES');
  for (const e of doc.entities) {
    switch (e.type) {
      case 'LINE':
        push('0', 'LINE', '8', e.layer, '10', e.start.x, '20', e.start.y, '30', 0, '11', e.end.x, '21', e.end.y, '31', 0);
        break;
      case 'LWPOLYLINE':
        push('0', 'LWPOLYLINE', '8', e.layer, '90', e.vertices.length, '70', e.closed ? 1 : 0);
        for (const v of e.vertices) {
          push('10', v.x, '20', v.y);
          if (v.bulge) push('42', v.bulge);
        }
        break;
      case 'CIRCLE':
        push('0', 'CIRCLE', '8', e.layer, '10', e.center.x, '20', e.center.y, '30', 0, '40', e.radius);
        break;
      case 'ARC':
        push(
          '0',
          'ARC',
          '8',
          e.layer,
          '10',
          e.center.x,
          '20',
          e.center.y,
          '30',
          0,
          '40',
          e.radius,
          '50',
          (e.startAngle * 180) / Math.PI,
          '51',
          (e.endAngle * 180) / Math.PI
        );
        break;
      case 'ELLIPSE':
        push(
          '0',
          'ELLIPSE',
          '8',
          e.layer,
          '10',
          e.center.x,
          '20',
          e.center.y,
          '30',
          0,
          '11',
          e.majorAxis.x,
          '21',
          e.majorAxis.y,
          '31',
          0,
          '40',
          e.axisRatio,
          '41',
          e.startAngle,
          '42',
          e.endAngle
        );
        break;
      case 'SPLINE': {
        const pts = e.controlPoints.length >= 2 ? e.controlPoints : e.sampledPoints;
        push('0', 'LWPOLYLINE', '8', e.layer, '90', pts.length, '70', e.closed ? 1 : 0);
        for (const p of pts) push('10', p.x, '20', p.y);
        break;
      }
      case 'TEXT':
        push(
          '0',
          'TEXT',
          '8',
          e.layer,
          '10',
          e.position.x,
          '20',
          e.position.y,
          '30',
          0,
          '40',
          e.height,
          '50',
          (e.rotation * 180) / Math.PI,
          '1',
          e.text
        );
        break;
      case 'POINT':
        push('0', 'POINT', '8', e.layer, '10', e.position.x, '20', e.position.y, '30', 0);
        break;
      case 'DIMENSION': {
        const dimType = e.kind === 'aligned' ? 33 : e.kind === 'angular' ? 34 : e.kind === 'diameter' ? 35 : e.kind === 'radius' ? 36 : e.kind === 'ordinate' ? 38 : 32;
        const label =
          e.textOverride ||
          (e.kind === 'area'
            ? formatArea(e.value, doc.nativeUnit, doc.dimStyle)
            : e.kind === 'angular'
              ? formatAngle(e.value, doc.dimStyle.precision)
              : formatLength(e.value, doc.nativeUnit, doc.dimStyle));
        push(
          '0',
          'DIMENSION',
          '8',
          e.layer,
          '10',
          e.textPoint.x,
          '20',
          e.textPoint.y,
          '30',
          0,
          '11',
          e.textPoint.x,
          '21',
          e.textPoint.y,
          '31',
          0,
          '70',
          dimType,
          '1',
          label,
          '13',
          e.p1.x,
          '23',
          e.p1.y,
          '33',
          0,
          '14',
          e.p2.x,
          '24',
          e.p2.y,
          '34',
          0
        );
        break;
      }
    }
  }
  push('0', 'ENDSEC', '0', 'EOF');

  const base = (customFileName || doc.name).replace(/\.(dwg|dxf)$/i, '');
  void downloadBlob(new Blob([out.join('\n')], { type: 'application/dxf' }), `${base}.dxf`, useSavePicker);
}

export function exportCanvasPng(canvas: HTMLCanvasElement, docName: string) {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const base = docName.replace(/\.(dwg|dxf)$/i, '');
    downloadBlob(blob, `${base}_snapshot.png`);
  }, 'image/png');
}

export function exportDrawingPdf(canvas: HTMLCanvasElement, doc: CadDocument) {
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a3' });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();

  // Outer engineering border
  pdf.setDrawColor(40, 50, 68);
  pdf.setLineWidth(0.5);
  pdf.rect(10, 10, pageW - 20, pageH - 20);

  // Canvas high-res image inside viewport frame
  const imgData = canvas.toDataURL('image/png', 1.0);
  const frameX = 12;
  const frameY = 12;
  const frameW = pageW - 24;
  const frameH = pageH - 42;
  const aspect = canvas.width / Math.max(1, canvas.height);
  let drawW = frameW;
  let drawH = frameW / aspect;
  if (drawH > frameH) {
    drawH = frameH;
    drawW = frameH * aspect;
  }
  const offsetX = frameX + (frameW - drawW) / 2;
  const offsetY = frameY + (frameH - drawH) / 2;
  pdf.addImage(imgData, 'PNG', offsetX, offsetY, drawW, drawH);

  // Title block at bottom
  const tbY = pageH - 28;
  pdf.setFillColor(245, 247, 250);
  pdf.rect(10, tbY, pageW - 20, 18, 'F');
  pdf.rect(10, tbY, pageW - 20, 18);

  pdf.setTextColor(15, 23, 42);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(11);
  pdf.text(`DRAWING: ${doc.name}`, 15, tbY + 7);

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8.5);
  const bounds = getDocumentBounds(doc.entities);
  const extentStr = bounds
    ? `${(bounds.maxX - bounds.minX).toFixed(2)} x ${(bounds.maxY - bounds.minY).toFixed(2)} ${UNIT_SHORT[doc.nativeUnit]}`
    : 'N/A';
  pdf.text(
    `Format: ${doc.format} (${doc.acadVersion})   |   Units: ${UNIT_LABELS[doc.nativeUnit]}   |   Scale: 1:${doc.dimStyle.measurementScale}   |   Extents: ${extentStr}`,
    15,
    tbY + 13.5
  );
  pdf.text(
    `Entities: ${doc.entities.length}   |   Layers: ${Object.keys(doc.layers).length}   |   Exported: ${new Date().toLocaleDateString()}`,
    pageW - 15,
    tbY + 13.5,
    { align: 'right' }
  );

  const base = doc.name.replace(/\.(dwg|dxf)$/i, '');
  pdf.save(`${base}_drawing.pdf`);
}

interface ReportRow {
  index: number;
  kind: string;
  layer: string;
  formattedValue: string;
  dx: string;
  dy: string;
  angle: string;
  coords: string;
}

function buildMeasurementRows(doc: CadDocument, selectedIds: Set<string>): ReportRow[] {
  const rows: ReportRow[] = [];
  const style = doc.dimStyle;
  let idx = 1;

  const dims = doc.entities.filter((e): e is DimensionEntity => e.type === 'DIMENSION');
  for (const d of dims) {
    const valStr =
      d.kind === 'area'
        ? formatArea(d.value, doc.nativeUnit, style)
        : d.kind === 'angular'
          ? formatAngle(d.value, style.precision)
          : formatLength(d.value, doc.nativeUnit, style);
    const dx = Math.abs(d.p2.x - d.p1.x);
    const dy = Math.abs(d.p2.y - d.p1.y);
    const ang = ((Math.atan2(d.p2.y - d.p1.y, d.p2.x - d.p1.x) * 180) / Math.PI + 360) % 360;
    rows.push({
      index: idx++,
      kind: `DIM (${d.kind})`,
      layer: d.layer,
      formattedValue: d.textOverride || valStr,
      dx: formatLength(dx, doc.nativeUnit, style),
      dy: formatLength(dy, doc.nativeUnit, style),
      angle: formatAngle(ang, style.precision),
      coords: `(${d.p1.x.toFixed(2)}, ${d.p1.y.toFixed(2)}) -> (${d.p2.x.toFixed(2)}, ${d.p2.y.toFixed(2)})`,
    });
  }

  // Also include selected entities or all measurable geometry if no dims placed yet
  const geomTargets: CadEntity[] =
    selectedIds.size > 0
      ? doc.entities.filter((e) => selectedIds.has(e.id) && e.type !== 'DIMENSION')
      : dims.length === 0
        ? doc.entities.filter((e) => e.type !== 'DIMENSION').slice(0, 150)
        : [];

  for (const e of geomTargets) {
    const m = measureEntity(e);
    if (!m) continue;
    rows.push({
      index: idx++,
      kind: m.entityType,
      layer: m.layer,
      formattedValue: m.isArea
        ? formatArea(m.primaryValue, doc.nativeUnit, style)
        : formatLength(m.primaryValue, doc.nativeUnit, style),
      dx: m.dx !== undefined ? formatLength(m.dx, doc.nativeUnit, style) : '-',
      dy: m.dy !== undefined ? formatLength(m.dy, doc.nativeUnit, style) : '-',
      angle: m.angleDeg !== undefined ? formatAngle(m.angleDeg, style.precision) : '-',
      coords:
        m.start && m.end
          ? `(${m.start.x.toFixed(2)}, ${m.start.y.toFixed(2)}) -> (${m.end.x.toFixed(2)}, ${m.end.y.toFixed(2)})`
          : m.center
            ? `Center (${m.center.x.toFixed(2)}, ${m.center.y.toFixed(2)})`
            : '-',
    });
  }

  return rows;
}

export function exportMeasurementReportPdf(doc: CadDocument, selectedIds: Set<string>) {
  const rows = buildMeasurementRows(doc, selectedIds);
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = pdf.internal.pageSize.getWidth();

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(14);
  pdf.text('CAD MASTER — MEASUREMENT SCHEDULE REPORT', 14, 18);

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(71, 85, 105);
  pdf.text(`Drawing: ${doc.name}   |   Format: ${doc.format} (${doc.acadVersion})`, 14, 25);
  pdf.text(
    `Drawing Units: ${UNIT_LABELS[doc.nativeUnit]}   |   Scale: 1:${doc.dimStyle.measurementScale}   |   Generated: ${new Date().toLocaleString()}`,
    14,
    30
  );

  let y = 40;
  const drawHeader = () => {
    pdf.setFillColor(15, 23, 42);
    pdf.rect(14, y, pageW - 28, 7, 'F');
    pdf.setTextColor(255, 255, 255);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8);
    pdf.text('#', 16, y + 4.8);
    pdf.text('Type', 24, y + 4.8);
    pdf.text('Layer', 54, y + 4.8);
    pdf.text('Measurement', 84, y + 4.8);
    pdf.text('dX', 118, y + 4.8);
    pdf.text('dY', 140, y + 4.8);
    pdf.text('Angle', 162, y + 4.8);
    y += 8.5;
    pdf.setTextColor(15, 23, 42);
    pdf.setFont('helvetica', 'normal');
  };

  drawHeader();

  if (rows.length === 0) {
    pdf.text('No dimensions or measurable entities selected in this drawing.', 14, y + 6);
  } else {
    for (const r of rows) {
      if (y > 275) {
        pdf.addPage();
        y = 18;
        drawHeader();
      }
      pdf.setFontSize(8);
      pdf.text(String(r.index), 16, y + 3.5);
      pdf.text(r.kind.slice(0, 18), 24, y + 3.5);
      pdf.text(r.layer.slice(0, 16), 54, y + 3.5);
      pdf.setFont('helvetica', 'bold');
      pdf.text(r.formattedValue, 84, y + 3.5);
      pdf.setFont('helvetica', 'normal');
      pdf.text(r.dx, 118, y + 3.5);
      pdf.text(r.dy, 140, y + 3.5);
      pdf.text(r.angle, 162, y + 3.5);
      pdf.setDrawColor(226, 232, 240);
      pdf.line(14, y + 5.5, pageW - 14, y + 5.5);
      y += 6.5;
    }
  }

  const base = doc.name.replace(/\.(dwg|dxf)$/i, '');
  pdf.save(`${base}_measurements.pdf`);
}

export function exportMeasurementsCsv(doc: CadDocument, selectedIds: Set<string>) {
  const rows = buildMeasurementRows(doc, selectedIds);
  const esc = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
  const header = ['Index', 'Type', 'Layer', 'Measurement', 'Delta_X', 'Delta_Y', 'Angle', 'CAD_Coordinates'];
  const lines = [
    header.join(','),
    ...rows.map((r) =>
      [r.index, esc(r.kind), esc(r.layer), esc(r.formattedValue), esc(r.dx), esc(r.dy), esc(r.angle), esc(r.coords)].join(',')
    ),
  ];
  const base = doc.name.replace(/\.(dwg|dxf)$/i, '');
  // UTF-8 BOM for clean Excel opening
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(blob, `${base}_measurements.csv`);
}

export function printCanvasDrawing(canvas: HTMLCanvasElement, doc: CadDocument) {
  const imgData = canvas.toDataURL('image/png', 1.0);
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  document.body.appendChild(iframe);

  const iDoc = iframe.contentWindow?.document;
  if (iDoc) {
    iDoc.open();
    iDoc.write(`
      <!doctype html>
      <html>
        <head>
          <title>${doc.name}</title>
          <style>
            @page { size: landscape; margin: 10mm; }
            body { font-family: sans-serif; margin: 0; color: #0f172a; }
            .frame { border: 1px solid #334155; padding: 8px; }
            img { width: 100%; max-height: 82vh; object-fit: contain; display: block; }
            .meta { margin-top: 8px; font-size: 11px; display: flex; justify-content: space-between; border-top: 1px solid #cbd5e1; padding-top: 6px; }
          </style>
        </head>
        <body>
          <div class="frame">
            <img src="${imgData}" />
            <div class="meta">
              <strong>${doc.name} (${doc.format} · ${doc.acadVersion})</strong>
              <span>Units: ${UNIT_LABELS[doc.nativeUnit]} · Scale 1:${doc.dimStyle.measurementScale}</span>
            </div>
          </div>
        </body>
      </html>
    `);
    iDoc.close();
    setTimeout(() => {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
      setTimeout(() => document.body.removeChild(iframe), 1000);
    }, 250);
  }
}
