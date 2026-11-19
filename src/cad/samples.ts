import { parseDxfText } from './parsers';
import { CadDocument } from './types';

function dxfHeader(acadVer: string, insunits: number): string {
  return [
    '0', 'SECTION',
    '2', 'HEADER',
    '9', '$ACADVER', '1', acadVer,
    '9', '$INSUNITS', '70', String(insunits),
    '0', 'ENDSEC',
  ].join('\n');
}

function dxfLayerTable(layers: { name: string; color: number }[]): string {
  const rows = layers.flatMap((l) => [
    '0', 'LAYER',
    '2', l.name,
    '70', '0',
    '62', String(l.color),
    '6', 'CONTINUOUS',
  ]);
  return [
    '0', 'SECTION',
    '2', 'TABLES',
    '0', 'TABLE',
    '2', 'LAYER',
    '70', String(layers.length),
    ...rows,
    '0', 'ENDTAB',
    '0', 'ENDSEC',
  ].join('\n');
}

function dxfLine(layer: string, x1: number, y1: number, x2: number, y2: number): string {
  return [
    '0', 'LINE',
    '8', layer,
    '10', String(x1), '20', String(y1), '30', '0',
    '11', String(x2), '21', String(y2), '31', '0',
  ].join('\n');
}

function dxfCircle(layer: string, cx: number, cy: number, r: number): string {
  return [
    '0', 'CIRCLE',
    '8', layer,
    '10', String(cx), '20', String(cy), '30', '0',
    '40', String(r),
  ].join('\n');
}

function dxfArc(layer: string, cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  return [
    '0', 'ARC',
    '8', layer,
    '10', String(cx), '20', String(cy), '30', '0',
    '40', String(r),
    '50', String(startDeg),
    '51', String(endDeg),
  ].join('\n');
}

function dxfPoly(layer: string, pts: [number, number][], closed = false): string {
  const verts = pts.flatMap(([x, y]) => ['10', String(x), '20', String(y)]);
  return [
    '0', 'LWPOLYLINE',
    '8', layer,
    '90', String(pts.length),
    '70', closed ? '1' : '0',
    ...verts,
  ].join('\n');
}

function dxfText(layer: string, x: number, y: number, height: number, text: string, rot = 0): string {
  return [
    '0', 'TEXT',
    '8', layer,
    '10', String(x), '20', String(y), '30', '0',
    '40', String(height),
    '50', String(rot),
    '1', text,
  ].join('\n');
}

export function buildArchitecturalFloorPlanDxf(): string {
  const layers = [
    { name: 'WALLS', color: 7 },
    { name: 'DOORS_WINDOWS', color: 4 },
    { name: 'FURNITURE', color: 3 },
    { name: 'GRID_AXIS', color: 1 },
    { name: 'ANNOTATIONS', color: 2 },
  ];
  const ents: string[] = [];

  // Outer building perimeter (12000mm x 8500mm)
  ents.push(dxfPoly('WALLS', [[0, 0], [12000, 0], [12000, 8500], [0, 8500]], true));
  // Inner wall thickness (200mm)
  ents.push(dxfPoly('WALLS', [[200, 200], [11800, 200], [11800, 8300], [200, 8300]], true));

  // Partition walls
  ents.push(dxfLine('WALLS', 5200, 200, 5200, 5200));
  ents.push(dxfLine('WALLS', 5350, 200, 5350, 5200));
  ents.push(dxfLine('WALLS', 200, 5200, 7400, 5200));
  ents.push(dxfLine('WALLS', 200, 5350, 7400, 5350));
  ents.push(dxfLine('WALLS', 7400, 5200, 7400, 8300));
  ents.push(dxfLine('WALLS', 7550, 5200, 7550, 8300));

  // Angled bay window wall on east wing
  ents.push(dxfLine('WALLS', 12000, 2200, 13200, 3400));
  ents.push(dxfLine('WALLS', 13200, 3400, 13200, 6100));
  ents.push(dxfLine('WALLS', 13200, 6100, 12000, 7300));

  // Doors with swing arcs (900mm)
  ents.push(dxfLine('DOORS_WINDOWS', 2100, 200, 2100, 1100));
  ents.push(dxfArc('DOORS_WINDOWS', 2100, 200, 900, 0, 90));
  ents.push(dxfLine('DOORS_WINDOWS', 5350, 4100, 6250, 4100));
  ents.push(dxfArc('DOORS_WINDOWS', 5350, 4100, 900, 0, 90));
  ents.push(dxfLine('DOORS_WINDOWS', 4100, 5350, 4100, 6250));
  ents.push(dxfArc('DOORS_WINDOWS', 4100, 5350, 900, 90, 180));

  // Windows
  ents.push(dxfLine('DOORS_WINDOWS', 1200, 8400, 3400, 8400));
  ents.push(dxfLine('DOORS_WINDOWS', 8800, 100, 11000, 100));

  // Furniture: conference table + chairs
  ents.push(dxfPoly('FURNITURE', [[7800, 2100], [10800, 2100], [10800, 3500], [7800, 3500]], true));
  for (let i = 0; i < 4; i++) {
    ents.push(dxfCircle('FURNITURE', 8250 + i * 700, 1750, 220));
    ents.push(dxfCircle('FURNITURE', 8250 + i * 700, 3850, 220));
  }
  // Desk in studio room
  ents.push(dxfPoly('FURNITURE', [[700, 800], [2700, 800], [2700, 1700], [700, 1700]], true));
  ents.push(dxfCircle('FURNITURE', 1700, 2150, 260));

  // Structural column grid
  ents.push(dxfLine('GRID_AXIS', -800, 0, -800, 8500));
  ents.push(dxfCircle('GRID_AXIS', -800, 8900, 320));
  ents.push(dxfText('ANNOTATIONS', -920, 8780, 260, 'A'));
  ents.push(dxfText('ANNOTATIONS', 1400, 3400, 280, 'STUDIO ROOM'));
  ents.push(dxfText('ANNOTATIONS', 8000, 4500, 280, 'CONFERENCE HALL'));
  ents.push(dxfText('ANNOTATIONS', 1400, 6800, 280, 'LAB BAY'));

  return [
    dxfHeader('AC1027', 4), // mm
    dxfLayerTable(layers),
    '0', 'SECTION', '2', 'ENTITIES',
    ...ents,
    '0', 'ENDSEC',
    '0', 'EOF',
  ].join('\n');
}

export function buildMechanicalFlangeDxf(): string {
  const layers = [
    { name: 'OUTLINE', color: 7 },
    { name: 'CENTERLINES', color: 1 },
    { name: 'HOLES', color: 4 },
    { name: 'NOTES', color: 2 },
  ];
  const ents: string[] = [];

  // Concentric flange rings (mm)
  ents.push(dxfCircle('OUTLINE', 0, 0, 160));
  ents.push(dxfCircle('OUTLINE', 0, 0, 110));
  ents.push(dxfCircle('OUTLINE', 0, 0, 52));
  // Pitch circle diameter
  ents.push(dxfCircle('CENTERLINES', 0, 0, 135));

  // 8 bolt holes around PCD 270mm
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const bx = Math.round(135 * Math.cos(a) * 1000) / 1000;
    const by = Math.round(135 * Math.sin(a) * 1000) / 1000;
    ents.push(dxfCircle('HOLES', bx, by, 12));
  }

  // Side mounting bracket profile with chamfer
  ents.push(
    dxfPoly(
      'OUTLINE',
      [
        [240, -90],
        [440, -90],
        [480, -50],
        [480, 90],
        [240, 90],
      ],
      true
    )
  );
  ents.push(dxfCircle('HOLES', 360, 0, 28));
  ents.push(dxfArc('OUTLINE', 240, 0, 45, 90, 270));

  // Centerlines
  ents.push(dxfLine('CENTERLINES', -190, 0, 190, 0));
  ents.push(dxfLine('CENTERLINES', 0, -190, 0, 190));
  ents.push(dxfLine('CENTERLINES', 220, 0, 500, 0));
  ents.push(dxfLine('CENTERLINES', 360, -110, 360, 110));

  // Angled gusset rib (45 deg check)
  ents.push(dxfLine('OUTLINE', 160, 0, 240, 80));
  ents.push(dxfLine('OUTLINE', 160, 0, 240, -80));

  ents.push(dxfText('NOTES', -160, -210, 14, 'FLANGE OD 320 MM / PCD 270 MM'));

  return [
    dxfHeader('AC1021', 4), // mm
    dxfLayerTable(layers),
    '0', 'SECTION', '2', 'ENTITIES',
    ...ents,
    '0', 'ENDSEC',
    '0', 'EOF',
  ].join('\n');
}

export function buildElectricalPanelDxf(): string {
  const layers = [
    { name: 'ENCLOSURE', color: 7 },
    { name: 'POWER_BUS', color: 1 },
    { name: 'CONTROL_WIRING', color: 4 },
    { name: 'COMPONENTS', color: 3 },
    { name: 'LABELS', color: 2 },
  ];
  const ents: string[] = [];

  // 36" x 24" NEMA enclosure
  ents.push(dxfPoly('ENCLOSURE', [[0, 0], [36, 0], [36, 24], [0, 24]], true));
  ents.push(dxfPoly('ENCLOSURE', [[1.5, 1.5], [34.5, 1.5], [34.5, 22.5], [1.5, 22.5]], true));

  // Busbars
  ents.push(dxfLine('POWER_BUS', 4, 19.5, 32, 19.5));
  ents.push(dxfLine('POWER_BUS', 4, 18.5, 32, 18.5));
  ents.push(dxfLine('POWER_BUS', 4, 17.5, 32, 17.5));

  // Breakers & contactors
  for (let i = 0; i < 4; i++) {
    const x = 5 + i * 6.5;
    ents.push(dxfPoly('COMPONENTS', [[x, 11], [x + 4.5, 11], [x + 4.5, 15.5], [x, 15.5]], true));
    ents.push(dxfLine('CONTROL_WIRING', x + 2.25, 15.5, x + 2.25, 19.5));
    ents.push(dxfLine('CONTROL_WIRING', x + 2.25, 11, x + 2.25, 6.5));
    ents.push(dxfCircle('COMPONENTS', x + 2.25, 5.2, 0.9));
  }

  // Terminal block rail
  ents.push(dxfPoly('COMPONENTS', [[4, 2.5], [32, 2.5], [32, 4.0], [4, 4.0]], true));
  ents.push(dxfText('LABELS', 2, 20.6, 0.9, '3-PHASE 480V DISTRIBUTION PANEL (INCHES)'));

  return [
    dxfHeader('AC1015', 1), // inches
    dxfLayerTable(layers),
    '0', 'SECTION', '2', 'ENTITIES',
    ...ents,
    '0', 'ENDSEC',
    '0', 'EOF',
  ].join('\n');
}

export interface SampleDefinition {
  id: string;
  title: string;
  subtitle: string;
  fileName: string;
  load: () => Promise<CadDocument>;
}

export const SAMPLE_DRAWINGS: SampleDefinition[] = [
  {
    id: 'arch-plan',
    title: 'Architectural Floor Plan',
    subtitle: 'Multi-layer · Metric (mm) · AC1027',
    fileName: 'Office_Floor_Plan_Metric.dxf',
    load: () => parseDxfText(buildArchitecturalFloorPlanDxf(), 'Office_Floor_Plan_Metric.dxf'),
  },
  {
    id: 'mech-flange',
    title: 'Precision Flange & Bracket',
    subtitle: 'Bolts, Arcs, Angled Ribs · Metric (mm)',
    fileName: 'Precision_Flange_Bracket.dxf',
    load: () => parseDxfText(buildMechanicalFlangeDxf(), 'Precision_Flange_Bracket.dxf'),
  },
  {
    id: 'elec-panel',
    title: 'Electrical Control Enclosure',
    subtitle: 'Busbars & Breakers · Imperial (in)',
    fileName: 'Control_Panel_NEMA_480V.dxf',
    load: () => parseDxfText(buildElectricalPanelDxf(), 'Control_Panel_NEMA_480V.dxf'),
  },
];
