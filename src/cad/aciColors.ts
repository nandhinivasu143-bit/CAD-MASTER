import { CanvasBgTheme } from './types';

// Standard AutoCAD Color Index (ACI) primary & extended palette
const ACI_CORE: Record<number, string> = {
  0: '#FFFFFF', // BYBLOCK
  1: '#FF3B30', // Red
  2: '#FFD60A', // Yellow
  3: '#34C759', // Green
  4: '#00E5FF', // Cyan
  5: '#3B82F6', // Blue
  6: '#E879F9', // Magenta
  7: '#F8FAFC', // White / Black adaptive
  8: '#64748B', // Dark Gray
  9: '#CBD5E1', // Light Gray
  10: '#EF4444',
  11: '#FCA5A5',
  12: '#B91C1C',
  14: '#991B1B',
  20: '#F97316',
  21: '#FDBA74',
  30: '#F59E0B',
  31: '#FCD34D',
  40: '#EAB308',
  50: '#84CC16',
  60: '#22C55E',
  70: '#10B981',
  80: '#14B8A6',
  90: '#06B6D4',
  100: '#0EA5E9',
  110: '#38BDF8',
  120: '#2563EB',
  130: '#60A5FA',
  140: '#6366F1',
  150: '#8B5CF6',
  160: '#A855F7',
  170: '#C084FC',
  180: '#D946EF',
  190: '#EC4899',
  200: '#F43F5E',
  210: '#FB7185',
  220: '#A3A3A3',
  230: '#737373',
  240: '#525252',
  250: '#475569',
  251: '#64748B',
  252: '#94A3B8',
  253: '#CBD5E1',
  254: '#E2E8F0',
  255: '#FFFFFF',
  256: '#F8FAFC', // BYLAYER
};

export function aciToHex(aci?: number): string {
  if (aci === undefined || aci === null) return '#F8FAFC';
  const abs = Math.abs(Math.round(aci));
  if (ACI_CORE[abs]) return ACI_CORE[abs];
  if (abs >= 10 && abs <= 249) {
    // Algorithmic ACI hue ring approximation
    const hueIndex = Math.floor((abs - 10) / 10);
    const shade = (abs - 10) % 10;
    const hue = Math.round((hueIndex / 24) * 360);
    const lightness = shade % 2 === 0 ? 58 - Math.floor(shade / 2) * 8 : 74 - Math.floor(shade / 2) * 8;
    return hslToHex(hue, 82, Math.max(22, Math.min(82, lightness)));
  }
  return '#F8FAFC';
}

export function int24ToHex(colorInt?: number): string | undefined {
  if (colorInt === undefined || colorInt === null || colorInt === 0) return undefined;
  const r = (colorInt >> 16) & 0xff;
  const g = (colorInt >> 8) & 0xff;
  const b = colorInt & 0xff;
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase()}`;
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x: number) =>
    Math.round(255 * x)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`.toUpperCase();
}

export function resolveEntityDisplayColor(
  entityColor: string,
  layerColor: string | undefined,
  bgTheme: CanvasBgTheme
): string {
  let color = entityColor;
  if (!color || color === 'BYLAYER' || color === 'BYBLOCK') {
    color = layerColor || '#F8FAFC';
  }
  const upper = color.toUpperCase();
  const isNeutralWhiteOrBlack =
    upper === '#FFFFFF' ||
    upper === '#F8FAFC' ||
    upper === '#000000' ||
    upper === '#0F172A' ||
    upper === '#111827';

  if (isNeutralWhiteOrBlack) {
    return bgTheme === 'white' ? '#0F172A' : '#F8FAFC';
  }
  // Ensure yellow/cyan remain legible on white background
  if (bgTheme === 'white') {
    if (upper === '#FFD60A' || upper === '#FFFF00') return '#B45309';
    if (upper === '#00E5FF' || upper === '#00FFFF') return '#0369A1';
    if (upper === '#34C759' || upper === '#00FF00') return '#15803D';
  }
  return color;
}

export const LAYER_PALETTE = [
  '#F8FAFC',
  '#38BDF8',
  '#34C759',
  '#FFD60A',
  '#FF3B30',
  '#E879F9',
  '#F97316',
  '#2DD4BF',
];
