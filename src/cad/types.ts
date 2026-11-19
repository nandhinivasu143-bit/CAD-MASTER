export interface Point2D {
  x: number;
  y: number;
}

export type CadUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft' | 'undefined';

export type UnitFormat = 'decimal' | 'architectural' | 'engineering' | 'fractional';

export type CanvasBgTheme = 'black' | 'white' | 'darkblue';

export type OsnapType =
  | 'endpoint'
  | 'midpoint'
  | 'center'
  | 'intersection'
  | 'nearest'
  | 'perpendicular'
  | 'tangent'
  | 'quadrant'
  | 'node';

export interface OsnapSettings {
  enabled: boolean;
  endpoint: boolean;
  midpoint: boolean;
  center: boolean;
  intersection: boolean;
  nearest: boolean;
  perpendicular: boolean;
  tangent: boolean;
  quadrant: boolean;
  node: boolean;
}

export interface SnapResult {
  point: Point2D;
  type: OsnapType;
  entityId?: string;
  screenDist: number;
}

export interface CadLayer {
  name: string;
  color: string;
  aci: number;
  visible: boolean;
  locked: boolean;
}

export type DimensionKind =
  | 'linear'
  | 'aligned'
  | 'horizontal'
  | 'vertical'
  | 'angular'
  | 'radius'
  | 'diameter'
  | 'arcLength'
  | 'baseline'
  | 'continue'
  | 'ordinate'
  | 'pointToPoint'
  | 'perpendicular'
  | 'area'
  | 'perimeter'
  | 'chain'
  | 'polylineLength';

export interface DimensionStyleConfig {
  textSize: number; // world units or auto-scaled when 0
  arrowSize: number;
  precision: number; // 0..6
  unitFormat: UnitFormat;
  color: string;
  textPosition: 'above' | 'centered' | 'outside';
  measurementScale: number; // e.g., 1.0, 50, 100
  displayUnit: CadUnit | 'drawing';
}

export interface BaseEntity {
  id: string;
  layer: string;
  color: string; // resolved hex or 'BYLAYER'
  aci?: number;
  lineType?: string;
  lineweight?: number;
  visible?: boolean;
}

export interface LineEntity extends BaseEntity {
  type: 'LINE';
  start: Point2D;
  end: Point2D;
}

export interface PolylineVertex {
  x: number;
  y: number;
  bulge?: number; // tan(theta/4), 0 or undefined for straight segment
}

export interface PolylineEntity extends BaseEntity {
  type: 'LWPOLYLINE';
  vertices: PolylineVertex[];
  closed: boolean;
}

export interface CircleEntity extends BaseEntity {
  type: 'CIRCLE';
  center: Point2D;
  radius: number;
}

export interface ArcEntity extends BaseEntity {
  type: 'ARC';
  center: Point2D;
  radius: number;
  startAngle: number; // radians
  endAngle: number; // radians (drawn CCW from startAngle to endAngle)
}

export interface EllipseEntity extends BaseEntity {
  type: 'ELLIPSE';
  center: Point2D;
  majorAxis: Point2D; // relative vector from center to major endpoint
  axisRatio: number; // minor / major
  startAngle: number; // parameter radians
  endAngle: number; // parameter radians
}

export interface SplineEntity extends BaseEntity {
  type: 'SPLINE';
  degree: number;
  controlPoints: Point2D[];
  fitPoints: Point2D[];
  knots: number[];
  weights?: number[];
  closed: boolean;
  sampledPoints: Point2D[]; // dense tessellated polyline in world coordinates
}

export interface TextEntity extends BaseEntity {
  type: 'TEXT';
  position: Point2D;
  text: string;
  height: number;
  rotation: number; // radians
}

export interface PointEntity extends BaseEntity {
  type: 'POINT';
  position: Point2D;
}

export interface DimensionEntity extends BaseEntity {
  type: 'DIMENSION';
  kind: DimensionKind;
  p1: Point2D;
  p2: Point2D;
  p3?: Point2D; // for 3-point angular, ordinate bend, perpendicular foot, etc.
  textPoint: Point2D;
  points?: Point2D[]; // for area, perimeter, chain, polylineLength
  value: number; // raw CAD value in drawing units (length, angle in deg, or area)
  textOverride?: string;
  style: Partial<DimensionStyleConfig>;
  isBaselineAnchor?: boolean;
  baselineOrigin?: Point2D;
  ordinateAxis?: 'x' | 'y';
  chainSegments?: number[];
}

export type CadEntity =
  | LineEntity
  | PolylineEntity
  | CircleEntity
  | ArcEntity
  | EllipseEntity
  | SplineEntity
  | TextEntity
  | PointEntity
  | DimensionEntity;

export interface PolylineSegmentInfo {
  index: number;
  start: Point2D;
  end: Point2D;
  length: number;
  dx: number;
  dy: number;
  angleDeg: number;
  isArc: boolean;
  radius?: number;
}

export interface EntityMeasurement {
  entityId: string;
  entityType: CadEntity['type'];
  layer: string;
  primaryLabel: string;
  primaryValue: number;
  isArea?: boolean;
  isAngle?: boolean;
  start?: Point2D;
  end?: Point2D;
  center?: Point2D;
  dx?: number;
  dy?: number;
  angleDeg?: number;
  radius?: number;
  diameter?: number;
  circumference?: number;
  area?: number;
  arcLength?: number;
  chordLength?: number;
  startAngleDeg?: number;
  endAngleDeg?: number;
  sweepAngleDeg?: number;
  segments?: PolylineSegmentInfo[];
  activeSegmentIndex?: number;
  closed?: boolean;
  vertexCount?: number;
}

export interface ViewportState {
  offsetX: number; // screen X of world (0,0)
  offsetY: number; // screen Y of world (0,0)
  scale: number; // pixels per drawing unit
}

export interface CadDocument {
  id: string;
  name: string;
  format: 'DWG' | 'DXF' | 'NEW';
  acadVersion: string;
  rawVersionCode: string;
  nativeUnit: CadUnit;
  unitWasDetected: boolean;
  entities: CadEntity[];
  layers: Record<string, CadLayer>;
  dimStyle: DimensionStyleConfig;
  viewport: ViewportState;
  undoStack: CadEntity[][];
  redoStack: CadEntity[][];
  isDirty: boolean;
  warnings: string[];
  fileSize?: number;
}

export type ToolId =
  | 'select'
  | 'pan'
  | 'measureInstant'
  | 'line'
  | 'polyline'
  | 'circle'
  | 'rectangle'
  | 'arc'
  | 'move'
  | 'copy'
  | 'rotate'
  | 'mirror'
  | 'offset'
  | 'trim'
  | 'extend'
  | 'delete'
  | 'dim_linear'
  | 'dim_aligned'
  | 'dim_horizontal'
  | 'dim_vertical'
  | 'dim_angular'
  | 'dim_radius'
  | 'dim_diameter'
  | 'dim_arcLength'
  | 'dim_baseline'
  | 'dim_continue'
  | 'dim_ordinate'
  | 'dim_pointToPoint'
  | 'dim_perpendicular'
  | 'dim_area'
  | 'dim_perimeter'
  | 'dim_chain'
  | 'dim_polylineLength';
