import DxfParser from 'dxf-parser';
import { Dwg_File_Type, LibreDwg, LibreDwgEx } from '@mlightcad/libredwg-web';
import { aciToHex, int24ToHex } from './aciColors';
import { genEntityId } from './editing';
import { evaluateSplinePoints, getDocumentBounds } from './geometry';
import {
  CadDocument,
  CadEntity,
  CadLayer,
  CadUnit,
  DimensionEntity,
  DimensionStyleConfig,
  Point2D,
  ViewportState,
} from './types';
import { insunitsToCadUnit } from './units';

const ACAD_VERSION_MAP: Record<string, string> = {
  AC1006: 'AutoCAD R10',
  AC1009: 'AutoCAD R11/R12',
  AC1012: 'AutoCAD R13',
  AC1014: 'AutoCAD R14',
  AC1015: 'AutoCAD 2000/2000i/2002',
  AC1018: 'AutoCAD 2004/2005/2006',
  AC1021: 'AutoCAD 2007/2008/2009',
  AC1024: 'AutoCAD 2010/2011/2012',
  AC1027: 'AutoCAD 2013–2017',
  AC1032: 'AutoCAD 2018–2025',
};

let libredwgPromise: Promise<LibreDwgEx> | null = null;

async function getLibreDwg(): Promise<LibreDwgEx> {
  if (!libredwgPromise) {
    libredwgPromise = LibreDwg.create('/wasm').catch((err) => {
      libredwgPromise = null;
      throw err;
    });
  }
  return libredwgPromise;
}

export function createDefaultDimStyle(): DimensionStyleConfig {
  return {
    textSize: 0, // 0 = auto-computed cleanly relative to viewport / drawing scale
    arrowSize: 0,
    precision: 2,
    unitFormat: 'decimal',
    color: '#38BDF8',
    textPosition: 'above',
    measurementScale: 1,
    displayUnit: 'drawing',
  };
}

export function computeFitViewport(
  entities: CadEntity[],
  visibleLayers: Set<string>,
  width = 1000,
  height = 700
): ViewportState {
  const bounds = getDocumentBounds(entities, visibleLayers);
  if (!bounds) {
    return { offsetX: width / 2, offsetY: height / 2, scale: 1 };
  }
  const bw = Math.max(1e-3, bounds.maxX - bounds.minX);
  const bh = Math.max(1e-3, bounds.maxY - bounds.minY);
  const pad = 0.82;
  const scale = Math.min((width * pad) / bw, (height * pad) / bh);
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return {
    scale,
    offsetX: width / 2 - cx * scale,
    offsetY: height / 2 + cy * scale, // CAD Y points up, Canvas Y points down
  };
}

function makeTransform(
  insX: number,
  insY: number,
  scaleX: number,
  scaleY: number,
  rotRad: number,
  baseX = 0,
  baseY = 0
): (p: Point2D) => Point2D {
  const cos = Math.cos(rotRad);
  const sin = Math.sin(rotRad);
  return (p: Point2D): Point2D => {
    const lx = (p.x - baseX) * scaleX;
    const ly = (p.y - baseY) * scaleY;
    return {
      x: insX + lx * cos - ly * sin,
      y: insY + lx * sin + ly * cos,
    };
  };
}

// ==========================================
// DWG PARSER (LibreDWG WebAssembly)
// ==========================================

export async function parseDwgFile(file: File): Promise<CadDocument> {
  const buffer = await file.arrayBuffer();
  return parseDwgBuffer(buffer, file.name, file.size);
}

export async function parseDwgBuffer(
  buffer: ArrayBuffer,
  fileName: string,
  fileSize?: number
): Promise<CadDocument> {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 16) {
    throw new Error('File is too small or empty to be a valid AutoCAD DWG drawing.');
  }

  const magic = new TextDecoder('ascii').decode(bytes.slice(0, 6));
  if (!magic.startsWith('AC10')) {
    throw new Error(
      `Invalid DWG header signature ("${magic.replace(/[^\x20-\x7E]/g, '?')}"). This file does not appear to be a valid binary AutoCAD DWG drawing.`
    );
  }

  const acadVersion = ACAD_VERSION_MAP[magic] || `AutoCAD (${magic})`;
  if (magic === 'AC1006' || magic === 'AC1009') {
    throw new Error(
      `Unsupported legacy DWG version ${magic} (${acadVersion}). The LibreDWG engine supports AutoCAD R13 (AC1012) through AutoCAD 2018+ (AC1032). Please convert pre-R13 files to DXF or R2000+ DWG.`
    );
  }

  const libredwg = await getLibreDwg();
  const dwgPtr = libredwg.dwg_read_data(buffer, Dwg_File_Type.DWG);
  if (!dwgPtr) {
    throw new Error(
      `Failed to decode DWG file (${acadVersion}). The file may be corrupted, encrypted, or use an unsupported AutoCAD DWG dialect (${magic}).`
    );
  }

  try {
    const db = libredwg.convert(dwgPtr);
    const warnings: string[] = [];

    // Layers
    const layers: Record<string, CadLayer> = {
      '0': { name: '0', color: '#F8FAFC', aci: 7, visible: true, locked: false },
    };

    const layerEntries = db.tables?.LAYER?.entries || [];
    for (const l of layerEntries) {
      const name = l.name || '0';
      const aci = l.colorIndex ?? 7;
      const color = int24ToHex((l as any).color) || aciToHex(aci);
      layers[name] = {
        name,
        color,
        aci,
        visible: !(l.off || l.frozen || aci < 0),
        locked: Boolean(l.locked),
      };
    }

    // Blocks lookup
    const blockMap = new Map<string, { basePoint: Point2D; entities: any[] }>();
    const blockRecords = db.tables?.BLOCK_RECORD?.entries || [];
    for (const br of blockRecords) {
      if (br.name) {
        blockMap.set(br.name, {
          basePoint: { x: br.basePoint?.x || 0, y: br.basePoint?.y || 0 },
          entities: br.entities || [],
        });
      }
    }

    const entities: CadEntity[] = [];
    const ensureLayer = (name: string) => {
      if (!layers[name]) {
        layers[name] = { name, color: '#F8FAFC', aci: 7, visible: true, locked: false };
      }
    };

    const convertDwgEntity = (
      raw: any,
      xf: (p: Point2D) => Point2D,
      rotOffset: number,
      scaleFactor: number,
      parentLayer?: string,
      depth = 0
    ) => {
      if (!raw || depth > 8) return;
      const layer = raw.layer && raw.layer !== '0' ? raw.layer : parentLayer || raw.layer || '0';
      ensureLayer(layer);

      let color = 'BYLAYER';
      if (raw.color && typeof raw.color === 'number' && raw.color !== 0) {
        color = int24ToHex(raw.color) || 'BYLAYER';
      } else if (raw.colorIndex !== undefined && raw.colorIndex !== 256 && raw.colorIndex !== 0) {
        color = aciToHex(raw.colorIndex);
      }

      const type = String(raw.type || '').toUpperCase();

      if (type === 'INSERT') {
        const blk = blockMap.get(raw.name);
        if (!blk || !blk.entities?.length) return;
        const ins = raw.insertionPoint || { x: 0, y: 0 };
        const sx = raw.xScale ?? 1;
        const sy = raw.yScale ?? 1;
        const rot = raw.rotation ?? 0; // LibreDWG DwgInsertEntity.rotation is in radians
        const innerXf = makeTransform(ins.x, ins.y, sx, sy, rot, blk.basePoint.x, blk.basePoint.y);
        const composed = (p: Point2D) => xf(innerXf(p));
        const colCount = Math.max(1, raw.columnCount || 1);
        const rowCount = Math.max(1, raw.rowCount || 1);
        if (colCount === 1 && rowCount === 1) {
          for (const child of blk.entities) {
            convertDwgEntity(child, composed, rotOffset + rot, scaleFactor * Math.abs(sx), layer, depth + 1);
          }
        } else {
          for (let c = 0; c < colCount; c++) {
            for (let r = 0; r < rowCount; r++) {
              const ox = c * (raw.columnSpacing || 0);
              const oy = r * (raw.rowSpacing || 0);
              const gridXf = (p: Point2D) => composed({ x: p.x + ox, y: p.y + oy });
              for (const child of blk.entities) {
                convertDwgEntity(child, gridXf, rotOffset + rot, scaleFactor * Math.abs(sx), layer, depth + 1);
              }
            }
          }
        }
        return;
      }

      if (type === 'LINE' && raw.startPoint && raw.endPoint) {
        entities.push({
          id: genEntityId('dwg'),
          type: 'LINE',
          layer,
          color,
          aci: raw.colorIndex,
          start: xf({ x: raw.startPoint.x, y: raw.startPoint.y }),
          end: xf({ x: raw.endPoint.x, y: raw.endPoint.y }),
        });
      } else if ((type === 'LWPOLYLINE' || type === 'POLYLINE' || type === 'POLYLINE_2D' || type === 'POLYLINE_3D') && Array.isArray(raw.vertices) && raw.vertices.length >= 2) {
        const closed = Boolean((raw.flag & 1) === 1 || raw.closed);
        entities.push({
          id: genEntityId('dwg'),
          type: 'LWPOLYLINE',
          layer,
          color,
          aci: raw.colorIndex,
          closed,
          vertices: raw.vertices.map((v: any) => {
            const p = xf({ x: v.x ?? v.location?.x ?? 0, y: v.y ?? v.location?.y ?? 0 });
            return { x: p.x, y: p.y, bulge: v.bulge || 0 };
          }),
        });
      } else if (type === 'CIRCLE' && raw.center && raw.radius > 0) {
        entities.push({
          id: genEntityId('dwg'),
          type: 'CIRCLE',
          layer,
          color,
          aci: raw.colorIndex,
          center: xf({ x: raw.center.x, y: raw.center.y }),
          radius: raw.radius * scaleFactor,
        });
      } else if (type === 'ARC' && raw.center && raw.radius > 0) {
        entities.push({
          id: genEntityId('dwg'),
          type: 'ARC',
          layer,
          color,
          aci: raw.colorIndex,
          center: xf({ x: raw.center.x, y: raw.center.y }),
          radius: raw.radius * scaleFactor,
          startAngle: (raw.startAngle ?? 0) + rotOffset,
          endAngle: (raw.endAngle ?? Math.PI) + rotOffset,
        });
      } else if (type === 'ELLIPSE' && raw.center && raw.majorAxisEndPoint) {
        const maj = raw.majorAxisEndPoint;
        const rotMaj = makeTransform(0, 0, scaleFactor, scaleFactor, rotOffset)(maj);
        entities.push({
          id: genEntityId('dwg'),
          type: 'ELLIPSE',
          layer,
          color,
          aci: raw.colorIndex,
          center: xf({ x: raw.center.x, y: raw.center.y }),
          majorAxis: rotMaj,
          axisRatio: raw.axisRatio ?? 0.5,
          startAngle: raw.startAngle ?? 0,
          endAngle: raw.endAngle ?? Math.PI * 2,
        });
      } else if (type === 'SPLINE') {
        const cps = (raw.controlPoints || []).map((p: any) => xf({ x: p.x, y: p.y }));
        const fps = (raw.fitPoints || []).map((p: any) => xf({ x: p.x, y: p.y }));
        const closed = Boolean((raw.flag & 1) === 1);
        const sampledPoints = evaluateSplinePoints(
          raw.degree || 3,
          cps,
          fps,
          raw.knots || [],
          raw.weights,
          closed
        );
        if (sampledPoints.length >= 2) {
          entities.push({
            id: genEntityId('dwg'),
            type: 'SPLINE',
            layer,
            color,
            aci: raw.colorIndex,
            degree: raw.degree || 3,
            controlPoints: cps,
            fitPoints: fps,
            knots: raw.knots || [],
            weights: raw.weights,
            closed,
            sampledPoints,
          });
        }
      } else if ((type === 'TEXT' || type === 'MTEXT') && (raw.startPoint || raw.insertionPoint)) {
        const pos = raw.startPoint || raw.insertionPoint;
        const textVal = String(raw.text || '').replace(/\\P/g, ' ').replace(/\{\\[^;]+;|[{}]/g, '');
        if (textVal.trim()) {
          entities.push({
            id: genEntityId('dwg'),
            type: 'TEXT',
            layer,
            color,
            aci: raw.colorIndex,
            position: xf({ x: pos.x, y: pos.y }),
            text: textVal,
            height: (raw.textHeight || raw.height || 10) * scaleFactor,
            rotation: (raw.rotation || 0) + rotOffset,
          });
        }
      } else if (type === 'POINT' && raw.position) {
        entities.push({
          id: genEntityId('dwg'),
          type: 'POINT',
          layer,
          color,
          aci: raw.colorIndex,
          position: xf({ x: raw.position.x, y: raw.position.y }),
        });
      } else if ((type === 'SOLID' || type === '3DFACE') && raw.corner1 && raw.corner2 && raw.corner3) {
        const pts = [raw.corner1, raw.corner2, raw.corner3, raw.corner4 || raw.corner3].map((p: any) =>
          xf({ x: p.x, y: p.y })
        );
        entities.push({
          id: genEntityId('dwg'),
          type: 'LWPOLYLINE',
          layer,
          color,
          aci: raw.colorIndex,
          closed: true,
          vertices: pts.map((p) => ({ x: p.x, y: p.y, bulge: 0 })),
        });
      } else if (type === 'DIMENSION') {
        // Render imported dimension block geometry if present OR construct DimensionEntity
        if (raw.name && blockMap.has(raw.name)) {
          const blk = blockMap.get(raw.name)!;
          for (const child of blk.entities) {
            convertDwgEntity(child, xf, rotOffset, scaleFactor, layer, depth + 1);
          }
        } else if (raw.subDefinitionPoint1 && raw.subDefinitionPoint2 && raw.textPoint) {
          const p1 = xf({ x: raw.subDefinitionPoint1.x, y: raw.subDefinitionPoint1.y });
          const p2 = xf({ x: raw.subDefinitionPoint2.x, y: raw.subDefinitionPoint2.y });
          const tp = xf({ x: raw.textPoint.x, y: raw.textPoint.y });
          const val = raw.measurement ?? Math.hypot(p2.x - p1.x, p2.y - p1.y);
          const dimEnt: DimensionEntity = {
            id: genEntityId('dim'),
            type: 'DIMENSION',
            kind: 'aligned',
            layer,
            color: color === 'BYLAYER' ? '#38BDF8' : color,
            p1,
            p2,
            textPoint: tp,
            value: val,
            textOverride: raw.text && raw.text !== '<>' ? raw.text : undefined,
            style: {},
          };
          entities.push(dimEnt);
        }
      }
    };

    const identity = (p: Point2D) => p;
    for (const ent of db.entities || []) {
      convertDwgEntity(ent, identity, 0, 1);
    }

    if (entities.length === 0) {
      warnings.push('No supported 2D model-space entities were found in this DWG file.');
    }

    const insunits = (db.header as any)?.INSUNITS;
    const { unit, detected } = insunitsToCadUnit(insunits);
    const visibleSet = new Set(Object.values(layers).filter((l) => l.visible).map((l) => l.name));

    return {
      id: genEntityId('doc'),
      name: fileName,
      format: 'DWG',
      acadVersion,
      rawVersionCode: magic,
      nativeUnit: unit,
      unitWasDetected: detected,
      entities,
      layers,
      dimStyle: createDefaultDimStyle(),
      viewport: computeFitViewport(entities, visibleSet),
      undoStack: [],
      redoStack: [],
      isDirty: false,
      warnings,
      fileSize,
    };
  } finally {
    libredwg.dwg_free(dwgPtr);
  }
}

// ==========================================
// DXF PARSER (dxf-parser + LibreDWG fallback)
// ==========================================

export async function parseDxfFile(file: File): Promise<CadDocument> {
  const text = await file.text();
  return parseDxfText(text, file.name, file.size);
}

export async function parseDxfText(
  text: string,
  fileName: string,
  fileSize?: number
): Promise<CadDocument> {
  // Check for binary DXF ("AutoCAD Binary DXF")
  if (text.startsWith('AutoCAD Binary DXF')) {
    const encoder = new TextEncoder();
    const libredwg = await getLibreDwg();
    const dwgPtr = libredwg.dwg_read_data(encoder.encode(text).buffer, Dwg_File_Type.DXF);
    if (!dwgPtr) {
      throw new Error('Failed to decode Binary DXF file.');
    }
    libredwg.dwg_free(dwgPtr);
  }

  const parser = new DxfParser();
  let dxf: any;
  try {
    dxf = parser.parseSync(text);
  } catch (err: any) {
    throw new Error(`Invalid or unsupported DXF file: ${err?.message || 'Parse failure'}`);
  }

  if (!dxf) {
    throw new Error('Failed to parse DXF drawing: empty structure returned.');
  }

  const rawVersion = String(dxf.header?.$ACADVER || 'Unknown');
  const acadVersion = ACAD_VERSION_MAP[rawVersion] || (rawVersion !== 'Unknown' ? `DXF (${rawVersion})` : 'DXF');

  const insunits = dxf.header?.$INSUNITS;
  const { unit, detected } = insunitsToCadUnit(insunits);

  const layers: Record<string, CadLayer> = {
    '0': { name: '0', color: '#F8FAFC', aci: 7, visible: true, locked: false },
  };

  if (dxf.tables?.layer?.layers) {
    for (const [name, l] of Object.entries<any>(dxf.tables.layer.layers)) {
      const aci = l.colorIndex ?? 7;
      const hex = l.color && l.color > 0 ? `#${l.color.toString(16).padStart(6, '0').toUpperCase()}` : aciToHex(aci);
      layers[name] = {
        name,
        color: hex,
        aci,
        visible: l.visible !== false && !l.frozen && aci >= 0,
        locked: Boolean(l.locked),
      };
    }
  }

  const ensureLayer = (name: string) => {
    if (!layers[name]) {
      layers[name] = { name, color: '#F8FAFC', aci: 7, visible: true, locked: false };
    }
  };

  const blocks: Record<string, any> = dxf.blocks || {};
  const entities: CadEntity[] = [];

  const convertDxfEntity = (
    raw: any,
    xf: (p: Point2D) => Point2D,
    rotOffsetDeg: number,
    scaleFactor: number,
    parentLayer?: string,
    depth = 0
  ) => {
    if (!raw || depth > 8) return;
    if (raw.inPaperSpace) return; // Model space primary view

    const layer = raw.layer && raw.layer !== '0' ? raw.layer : parentLayer || raw.layer || '0';
    ensureLayer(layer);

    let color = 'BYLAYER';
    if (raw.colorIndex !== undefined && raw.colorIndex !== 256 && raw.colorIndex !== 0) {
      color = aciToHex(raw.colorIndex);
    } else if (raw.color && raw.color > 0 && raw.colorIndex !== 256) {
      color = `#${raw.color.toString(16).padStart(6, '0').toUpperCase()}`;
    }

    const type = String(raw.type || '').toUpperCase();

    if (type === 'INSERT') {
      const blk = blocks[raw.name];
      if (!blk || !Array.isArray(blk.entities)) return;
      const ins = raw.position || { x: 0, y: 0 };
      const sx = raw.xScale ?? 1;
      const sy = raw.yScale ?? 1;
      const rotDeg = raw.rotation ?? 0;
      const rotRad = (rotDeg * Math.PI) / 180;
      const base = blk.position || { x: 0, y: 0 };
      const innerXf = makeTransform(ins.x, ins.y, sx, sy, rotRad, base.x, base.y);
      const composed = (p: Point2D) => xf(innerXf(p));

      const cols = Math.max(1, raw.columnCount || 1);
      const rows = Math.max(1, raw.rowCount || 1);
      for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
          const ox = c * (raw.columnSpacing || 0);
          const oy = r * (raw.rowSpacing || 0);
          const gridXf = (p: Point2D) => composed({ x: p.x + ox, y: p.y + oy });
          for (const child of blk.entities) {
            convertDxfEntity(child, gridXf, rotOffsetDeg + rotDeg, scaleFactor * Math.abs(sx), layer, depth + 1);
          }
        }
      }
      return;
    }

    if (type === 'LINE' && Array.isArray(raw.vertices) && raw.vertices.length >= 2) {
      entities.push({
        id: genEntityId('dxf'),
        type: 'LINE',
        layer,
        color,
        aci: raw.colorIndex,
        start: xf({ x: raw.vertices[0].x, y: raw.vertices[0].y }),
        end: xf({ x: raw.vertices[1].x, y: raw.vertices[1].y }),
      });
    } else if ((type === 'LWPOLYLINE' || type === 'POLYLINE') && Array.isArray(raw.vertices) && raw.vertices.length >= 2) {
      entities.push({
        id: genEntityId('dxf'),
        type: 'LWPOLYLINE',
        layer,
        color,
        aci: raw.colorIndex,
        closed: Boolean(raw.shape),
        vertices: raw.vertices.map((v: any) => {
          const p = xf({ x: v.x, y: v.y });
          return { x: p.x, y: p.y, bulge: v.bulge || 0 };
        }),
      });
    } else if (type === 'CIRCLE' && raw.center && raw.radius > 0) {
      entities.push({
        id: genEntityId('dxf'),
        type: 'CIRCLE',
        layer,
        color,
        aci: raw.colorIndex,
        center: xf({ x: raw.center.x, y: raw.center.y }),
        radius: raw.radius * scaleFactor,
      });
    } else if (type === 'ARC' && raw.center && raw.radius > 0) {
      const rotRad = (rotOffsetDeg * Math.PI) / 180;
      entities.push({
        id: genEntityId('dxf'),
        type: 'ARC',
        layer,
        color,
        aci: raw.colorIndex,
        center: xf({ x: raw.center.x, y: raw.center.y }),
        radius: raw.radius * scaleFactor,
        startAngle: (raw.startAngle ?? 0) + rotRad,
        endAngle: (raw.endAngle ?? Math.PI) + rotRad,
      });
    } else if (type === 'ELLIPSE' && raw.center && raw.majorAxisEndPoint) {
      const rotRad = (rotOffsetDeg * Math.PI) / 180;
      const rotMaj = makeTransform(0, 0, scaleFactor, scaleFactor, rotRad)(raw.majorAxisEndPoint);
      entities.push({
        id: genEntityId('dxf'),
        type: 'ELLIPSE',
        layer,
        color,
        aci: raw.colorIndex,
        center: xf({ x: raw.center.x, y: raw.center.y }),
        majorAxis: rotMaj,
        axisRatio: raw.axisRatio ?? 0.5,
        startAngle: raw.startAngle ?? 0,
        endAngle: raw.endAngle ?? Math.PI * 2,
      });
    } else if (type === 'SPLINE') {
      const cps = (raw.controlPoints || []).map((p: any) => xf({ x: p.x, y: p.y }));
      const fps = (raw.fitPoints || []).map((p: any) => xf({ x: p.x, y: p.y }));
      const closed = Boolean(raw.closed);
      const sampledPoints = evaluateSplinePoints(
        raw.degreeOfSplineCurve || 3,
        cps,
        fps,
        raw.knotValues || [],
        raw.weights,
        closed
      );
      if (sampledPoints.length >= 2) {
        entities.push({
          id: genEntityId('dxf'),
          type: 'SPLINE',
          layer,
          color,
          aci: raw.colorIndex,
          degree: raw.degreeOfSplineCurve || 3,
          controlPoints: cps,
          fitPoints: fps,
          knots: raw.knotValues || [],
          weights: raw.weights,
          closed,
          sampledPoints,
        });
      }
    } else if ((type === 'TEXT' || type === 'MTEXT') && (raw.startPoint || raw.position)) {
      const pos = raw.startPoint || raw.position;
      const textVal = String(raw.text || '').replace(/\\P/g, ' ').replace(/\{\\[^;]+;|[{}]/g, '');
      if (textVal.trim()) {
        entities.push({
          id: genEntityId('dxf'),
          type: 'TEXT',
          layer,
          color,
          aci: raw.colorIndex,
          position: xf({ x: pos.x, y: pos.y }),
          text: textVal,
          height: (raw.textHeight || raw.height || 10) * scaleFactor,
          rotation: ((raw.rotation || 0) + rotOffsetDeg) * (Math.PI / 180),
        });
      }
    } else if (type === 'POINT' && raw.position) {
      entities.push({
        id: genEntityId('dxf'),
        type: 'POINT',
        layer,
        color,
        aci: raw.colorIndex,
        position: xf({ x: raw.position.x, y: raw.position.y }),
      });
    } else if ((type === 'SOLID' || type === '3DFACE') && Array.isArray(raw.points) && raw.points.length >= 3) {
      entities.push({
        id: genEntityId('dxf'),
        type: 'LWPOLYLINE',
        layer,
        color,
        aci: raw.colorIndex,
        closed: true,
        vertices: raw.points.map((p: any) => ({ ...xf({ x: p.x, y: p.y }), bulge: 0 })),
      });
    } else if (type === 'DIMENSION') {
      if (raw.block && blocks[raw.block]) {
        for (const child of blocks[raw.block].entities || []) {
          convertDxfEntity(child, xf, rotOffsetDeg, scaleFactor, layer, depth + 1);
        }
      } else if (raw.anchorPoint && raw.middleOfText) {
        const p1 = xf({ x: raw.linearOrRotatedPoint1?.x ?? raw.anchorPoint.x, y: raw.linearOrRotatedPoint1?.y ?? raw.anchorPoint.y });
        const p2 = xf({ x: raw.linearOrRotatedPoint2?.x ?? raw.anchorPoint.x, y: raw.linearOrRotatedPoint2?.y ?? raw.anchorPoint.y });
        const tp = xf({ x: raw.middleOfText.x, y: raw.middleOfText.y });
        entities.push({
          id: genEntityId('dim'),
          type: 'DIMENSION',
          kind: 'aligned',
          layer,
          color: color === 'BYLAYER' ? '#38BDF8' : color,
          p1,
          p2,
          textPoint: tp,
          value: raw.actualMeasurement ?? Math.hypot(p2.x - p1.x, p2.y - p1.y),
          textOverride: raw.text && raw.text !== '<>' ? raw.text : undefined,
          style: {},
        });
      }
    }
  };

  const identity = (p: Point2D) => p;
  for (const ent of dxf.entities || []) {
    convertDxfEntity(ent, identity, 0, 1);
  }

  const warnings: string[] = [];
  if (entities.length === 0) {
    warnings.push('No supported 2D model-space entities found in this DXF file.');
  }

  const visibleSet = new Set(Object.values(layers).filter((l) => l.visible).map((l) => l.name));

  return {
    id: genEntityId('doc'),
    name: fileName,
    format: 'DXF',
    acadVersion,
    rawVersionCode: rawVersion,
    nativeUnit: unit,
    unitWasDetected: detected,
    entities,
    layers,
    dimStyle: createDefaultDimStyle(),
    viewport: computeFitViewport(entities, visibleSet),
    undoStack: [],
    redoStack: [],
    isDirty: false,
    warnings,
    fileSize,
  };
}

export async function parseCadFile(file: File): Promise<CadDocument> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.dwg')) {
    return parseDwgFile(file);
  }
  if (lower.endsWith('.dxf')) {
    return parseDxfFile(file);
  }
  throw new Error(`Unsupported file format "${file.name}". Please select an AutoCAD .dwg or .dxf file.`);
}

export function createBlankDocument(name = 'Untitled_Drawing.dxf', unit: CadUnit = 'mm'): CadDocument {
  const layers: Record<string, CadLayer> = {
    '0': { name: '0', color: '#F8FAFC', aci: 7, visible: true, locked: false },
    DIMENSIONS: { name: 'DIMENSIONS', color: '#38BDF8', aci: 4, visible: true, locked: false },
  };
  return {
    id: genEntityId('doc'),
    name,
    format: 'NEW',
    acadVersion: 'AC1027 (AutoCAD 2013)',
    rawVersionCode: 'AC1027',
    nativeUnit: unit,
    unitWasDetected: true,
    entities: [],
    layers,
    dimStyle: createDefaultDimStyle(),
    viewport: { offsetX: 500, offsetY: 350, scale: 1 },
    undoStack: [],
    redoStack: [],
    isDirty: false,
    warnings: [],
  };
}
