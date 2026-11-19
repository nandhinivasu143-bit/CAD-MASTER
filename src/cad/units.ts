import { CadUnit, DimensionStyleConfig, UnitFormat } from './types';

export const UNIT_LABELS: Record<CadUnit, string> = {
  mm: 'Millimeters (mm)',
  cm: 'Centimeters (cm)',
  m: 'Meters (m)',
  in: 'Inches (in)',
  ft: 'Feet (ft)',
  undefined: 'Undefined',
};

export const UNIT_SHORT: Record<CadUnit, string> = {
  mm: 'mm',
  cm: 'cm',
  m: 'm',
  in: 'in',
  ft: 'ft',
  undefined: 'units',
};

// Conversion factor from unit -> millimeters
const TO_MM: Record<Exclude<CadUnit, 'undefined'>, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  ft: 304.8,
};

/**
 * Maps DXF/DWG $INSUNITS integer code to CadUnit.
 * Never silently assumes millimeters when 0 or absent!
 */
export function insunitsToCadUnit(insunits?: number | null): {
  unit: CadUnit;
  detected: boolean;
} {
  switch (insunits) {
    case 1:
      return { unit: 'in', detected: true };
    case 2:
      return { unit: 'ft', detected: true };
    case 4:
      return { unit: 'mm', detected: true };
    case 5:
      return { unit: 'cm', detected: true };
    case 6:
      return { unit: 'm', detected: true };
    default:
      return { unit: 'undefined', detected: false };
  }
}

export function cadUnitToInsunits(unit: CadUnit): number {
  switch (unit) {
    case 'in':
      return 1;
    case 'ft':
      return 2;
    case 'mm':
      return 4;
    case 'cm':
      return 5;
    case 'm':
      return 6;
    default:
      return 0;
  }
}

export function convertLength(value: number, from: CadUnit, to: CadUnit): number {
  if (from === to || from === 'undefined' || to === 'undefined') {
    return value;
  }
  const mm = value * TO_MM[from];
  return mm / TO_MM[to];
}

export function convertArea(area: number, from: CadUnit, to: CadUnit): number {
  if (from === to || from === 'undefined' || to === 'undefined') {
    return area;
  }
  const linearFactor = TO_MM[from] / TO_MM[to];
  return area * linearFactor * linearFactor;
}

export function getEffectiveUnit(nativeUnit: CadUnit, dimStyle: DimensionStyleConfig): CadUnit {
  if (dimStyle.displayUnit === 'drawing') return nativeUnit;
  if (nativeUnit === 'undefined') return nativeUnit;
  return dimStyle.displayUnit;
}

export function formatLength(
  rawDrawingLength: number,
  nativeUnit: CadUnit,
  style: Pick<DimensionStyleConfig, 'precision' | 'unitFormat' | 'measurementScale' | 'displayUnit'>,
  includeUnit = true
): string {
  const targetUnit = getEffectiveUnit(nativeUnit, style as DimensionStyleConfig);
  const converted = convertLength(rawDrawingLength, nativeUnit, targetUnit) * (style.measurementScale || 1);
  const precision = Math.max(0, Math.min(6, style.precision ?? 2));
  const unitSuffix = includeUnit ? ` ${UNIT_SHORT[targetUnit]}` : '';

  if (style.unitFormat === 'architectural' && (targetUnit === 'in' || targetUnit === 'ft')) {
    const totalInches = targetUnit === 'ft' ? converted * 12 : converted;
    return formatArchitecturalInches(totalInches);
  }

  if (style.unitFormat === 'engineering' && (targetUnit === 'in' || targetUnit === 'ft')) {
    const totalInches = targetUnit === 'ft' ? converted * 12 : converted;
    const feet = Math.floor(Math.abs(totalInches) / 12);
    const inches = Math.abs(totalInches) % 12;
    const sign = totalInches < 0 ? '-' : '';
    return `${sign}${feet}'-${inches.toFixed(precision)}"`;
  }

  if (style.unitFormat === 'fractional') {
    return `${formatFractional(converted)}${unitSuffix}`;
  }

  // Clean decimal avoiding -0.00
  const cleaned = Math.abs(converted) < 1e-10 ? 0 : converted;
  return `${cleaned.toFixed(precision)}${unitSuffix}`;
}

export function formatArea(
  rawDrawingArea: number,
  nativeUnit: CadUnit,
  style: Pick<DimensionStyleConfig, 'precision' | 'measurementScale' | 'displayUnit'>,
  includeUnit = true
): string {
  const targetUnit = getEffectiveUnit(nativeUnit, style as DimensionStyleConfig);
  const scale = style.measurementScale || 1;
  const converted = convertArea(rawDrawingArea, nativeUnit, targetUnit) * scale * scale;
  const precision = Math.max(0, Math.min(6, style.precision ?? 2));
  const suffix = includeUnit ? ` ${UNIT_SHORT[targetUnit]}²` : '';
  return `${converted.toFixed(precision)}${suffix}`;
}

function formatArchitecturalInches(totalInches: number): string {
  const sign = totalInches < 0 ? '-' : '';
  const abs = Math.abs(totalInches);
  const feet = Math.floor(abs / 12);
  const remInches = abs - feet * 12;
  const wholeInches = Math.floor(remInches);
  const frac = remInches - wholeInches;
  const denom = 16;
  const num = Math.round(frac * denom);

  let finalFeet = feet;
  let finalInches = wholeInches;
  let fracStr = '';

  if (num === denom) {
    finalInches += 1;
    if (finalInches === 12) {
      finalFeet += 1;
      finalInches = 0;
    }
  } else if (num > 0) {
    const g = gcd(num, denom);
    fracStr = ` ${num / g}/${denom / g}`;
  }

  return `${sign}${finalFeet}'-${finalInches}${fracStr}"`;
}

function formatFractional(value: number): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const whole = Math.floor(abs);
  const frac = abs - whole;
  const denom = 16;
  const num = Math.round(frac * denom);
  if (num === 0) return `${sign}${whole}`;
  if (num === denom) return `${sign}${whole + 1}`;
  const g = gcd(num, denom);
  return whole > 0 ? `${sign}${whole} ${num / g}/${denom / g}` : `${sign}${num / g}/${denom / g}`;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

export function formatAngle(deg: number, precision = 2): string {
  const normalized = ((deg % 360) + 360) % 360;
  return `${normalized.toFixed(Math.min(4, Math.max(0, precision)))}°`;
}

export const UNIT_FORMAT_LABELS: Record<UnitFormat, string> = {
  decimal: 'Decimal',
  architectural: 'Architectural (ft-in)',
  engineering: 'Engineering',
  fractional: 'Fractional',
};
