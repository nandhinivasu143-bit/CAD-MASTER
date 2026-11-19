import React, { useState } from 'react';
import { Check, ChevronDown, ChevronUp, Copy, Ruler, Trash2, X } from 'lucide-react';
import { CadUnit, DimensionStyleConfig, EntityMeasurement, ToolId } from '../cad/types';
import { formatAngle, formatArea, formatLength, getEffectiveUnit, UNIT_SHORT } from '../cad/units';

interface FloatingMeasurementPopupProps {
  measurement: EntityMeasurement | null;
  activeTool: ToolId;
  nativeUnit: CadUnit;
  dimStyle: DimensionStyleConfig;
  canDeleteSelected?: boolean;
  onChangeDisplayUnit: (unit: CadUnit | 'drawing') => void;
  onDeleteSelected?: () => void;
  onClose: () => void;
  onSelectSegment?: (segmentIndex: number) => void;
}

const DISPLAY_UNITS: Exclude<CadUnit, 'undefined'>[] = ['mm', 'cm', 'm', 'in', 'ft'];

export const FloatingMeasurementPopup: React.FC<FloatingMeasurementPopupProps> = ({
  measurement,
  activeTool,
  nativeUnit,
  dimStyle,
  canDeleteSelected = false,
  onChangeDisplayUnit,
  onDeleteSelected,
  onClose,
  onSelectSegment,
}) => {
  const [copiedVal, setCopiedVal] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  const effectiveUnit = getEffectiveUnit(nativeUnit, dimStyle);
  const activeUnitBadge = UNIT_SHORT[effectiveUnit];

  if (!measurement) {
    return (
      <section
        aria-label="Line measurement panel"
        data-testid="fixed-measurement-panel"
        className="shrink-0 bg-[#101521] border-t border-slate-800/95 px-3 py-2 z-20"
      >
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
          <div className="flex items-center gap-1.5 min-w-0">
            <Ruler className="w-3.5 h-3.5 text-sky-400 shrink-0" />
            <span className="text-xs font-semibold text-slate-200 whitespace-nowrap">
              Selected Line Length:
            </span>
            <span className="text-xs text-slate-400 truncate">
              {activeTool === 'measureInstant' || activeTool === 'select'
                ? 'Tap line or polyline'
                : 'Tap drawing'}
            </span>
          </div>

          <div className="flex items-center gap-1 shrink-0" role="group" aria-label="Measurement units">
            {DISPLAY_UNITS.map((u) => {
              const active = effectiveUnit === u;
              return (
                <button
                  key={u}
                  type="button"
                  onClick={() => onChangeDisplayUnit(u)}
                  className={`px-2 min-h-[28px] rounded-md text-[11px] font-mono-cad font-semibold cursor-pointer transition-colors ${
                    active
                      ? 'bg-sky-600 text-white'
                      : 'bg-[#171F2E] text-slate-400 border border-slate-800 hover:text-slate-200'
                  }`}
                >
                  {u}
                </button>
              );
            })}
          </div>
        </div>
      </section>
    );
  }

  const primaryFormatted = measurement.isArea
    ? formatArea(measurement.primaryValue, nativeUnit, dimStyle)
    : measurement.isAngle
      ? formatAngle(measurement.primaryValue, dimStyle.precision)
      : formatLength(measurement.primaryValue, nativeUnit, dimStyle);

  const headlineLabel =
    measurement.entityType === 'LINE'
      ? 'Selected Line Length'
      : measurement.entityType === 'LWPOLYLINE'
        ? 'Polyline Total Length'
        : measurement.primaryLabel;

  const activeSeg =
    measurement.segments && measurement.activeSegmentIndex !== undefined
      ? measurement.segments[measurement.activeSegmentIndex]
      : undefined;

  const copyPrimary = async () => {
    try {
      await navigator.clipboard.writeText(primaryFormatted);
      setCopiedVal(true);
      setTimeout(() => setCopiedVal(false), 1600);
    } catch {
      // ignore clipboard errors
    }
  };

  const copyFullSummary = async () => {
    const lines = [
      `${measurement.entityType} (Layer: ${measurement.layer})`,
      `${headlineLabel}: ${primaryFormatted}`,
    ];
    if (measurement.angleDeg !== undefined) {
      lines.push(`Angle = ${formatAngle(measurement.angleDeg, dimStyle.precision)}`);
    }
    if (measurement.dx !== undefined && measurement.dy !== undefined) {
      lines.push(
        `Horizontal = ${formatLength(measurement.dx, nativeUnit, dimStyle)} | Vertical = ${formatLength(measurement.dy, nativeUnit, dimStyle)}`
      );
    }
    if (measurement.start && measurement.end) {
      lines.push(
        `Start = (${measurement.start.x.toFixed(dimStyle.precision)}, ${measurement.start.y.toFixed(dimStyle.precision)})`
      );
      lines.push(
        `End = (${measurement.end.x.toFixed(dimStyle.precision)}, ${measurement.end.y.toFixed(dimStyle.precision)})`
      );
    }
    if (measurement.radius !== undefined) {
      lines.push(`Radius = ${formatLength(measurement.radius, nativeUnit, dimStyle)}`);
    }
    if (measurement.diameter !== undefined) {
      lines.push(`Diameter = ${formatLength(measurement.diameter, nativeUnit, dimStyle)}`);
    }
    if (measurement.area !== undefined) {
      lines.push(`Area = ${formatArea(measurement.area, nativeUnit, dimStyle)}`);
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopiedVal(true);
      setTimeout(() => setCopiedVal(false), 1600);
    } catch {
      // ignore
    }
  };

  return (
    <section
      aria-label="Selected line length information panel"
      data-testid="fixed-measurement-panel"
      className="shrink-0 bg-[#101624] border-t border-sky-500/55 text-slate-100 z-20 max-h-[34dvh] flex flex-col"
    >
      {/* Fixed Primary Measurement Row */}
      <div className="px-3 py-2 flex items-center justify-between gap-2 shrink-0">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11px] text-slate-400 truncate">
            <span className="font-semibold text-slate-300">{measurement.entityType}</span>
            <span className="text-slate-600">·</span>
            <span className="truncate">{measurement.layer}</span>
            {activeSeg && measurement.segments && measurement.segments.length > 1 && (
              <span className="text-amber-300 font-mono-cad shrink-0">
                · Seg #{activeSeg.index + 1}: {formatLength(activeSeg.length, nativeUnit, dimStyle)}
              </span>
            )}
          </div>
          <div
            data-testid="measurement-primary-readout"
            className="text-base sm:text-lg font-bold text-white font-mono-cad tracking-tight truncate"
          >
            {headlineLabel}: <span className="text-sky-300">{primaryFormatted}</span>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={copyPrimary}
            aria-label="Copy length"
            className="flex items-center gap-1 px-2.5 min-h-[36px] rounded-lg bg-sky-600 active:bg-sky-500 text-xs font-semibold text-white cursor-pointer"
          >
            {copiedVal ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copiedVal ? 'Copied' : 'Copy'}</span>
          </button>

          {canDeleteSelected && onDeleteSelected && (
            <button
              type="button"
              onClick={onDeleteSelected}
              aria-label="Delete selected object"
              title="Delete selected object"
              className="w-9 h-9 flex items-center justify-center rounded-lg bg-rose-950/70 border border-rose-500/40 text-rose-300 cursor-pointer"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}

          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            aria-label={showDetails ? 'Hide details' : 'Show details'}
            className="w-9 h-9 flex items-center justify-center rounded-lg bg-[#171F2E] border border-slate-700/80 text-slate-300 cursor-pointer"
          >
            {showDetails ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
          </button>

          <button
            type="button"
            onClick={onClose}
            aria-label="Clear measurement"
            className="w-9 h-9 flex items-center justify-center rounded-lg bg-[#171F2E] border border-slate-700/80 text-slate-300 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Quick Units & Key Telemetry Strip */}
      <div className="px-3 pb-2 flex items-center justify-between gap-2 border-b border-slate-800/80 shrink-0">
        <div className="flex items-center gap-2 text-[11px] font-mono-cad text-slate-300 min-w-0 truncate">
          {measurement.angleDeg !== undefined && (
            <span>∠ {formatAngle(measurement.angleDeg, dimStyle.precision)}</span>
          )}
          {measurement.dx !== undefined && (
            <span>ΔX {formatLength(measurement.dx, nativeUnit, dimStyle)}</span>
          )}
          {measurement.dy !== undefined && (
            <span>ΔY {formatLength(measurement.dy, nativeUnit, dimStyle)}</span>
          )}
          {measurement.radius !== undefined && (
            <span>R {formatLength(measurement.radius, nativeUnit, dimStyle)}</span>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0" role="group" aria-label="Unit converter">
          {DISPLAY_UNITS.map((u) => {
            const active = activeUnitBadge === u;
            return (
              <button
                key={u}
                type="button"
                onClick={() => onChangeDisplayUnit(u)}
                className={`px-2 min-h-[28px] rounded-md text-[11px] font-mono-cad font-semibold cursor-pointer ${
                  active
                    ? 'bg-sky-600 text-white'
                    : 'bg-[#171F2E] text-slate-400 border border-slate-800 hover:text-slate-200'
                }`}
              >
                {u}
              </button>
            );
          })}
        </div>
      </div>

      {/* Expandable Coordinates & Polyline Segments */}
      {showDetails && (
        <div className="px-3 py-2 space-y-2 overflow-y-auto text-xs bg-[#0C101B]">
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            {measurement.angleDeg !== undefined && (
              <div>
                <div className="text-[10px] text-slate-400">Angle</div>
                <div className="font-mono-cad text-slate-100 font-medium">
                  {formatAngle(measurement.angleDeg, dimStyle.precision)}
                </div>
              </div>
            )}
            {measurement.dx !== undefined && (
              <div>
                <div className="text-[10px] text-slate-400">Horizontal (ΔX)</div>
                <div className="font-mono-cad text-slate-100 font-medium">
                  {formatLength(measurement.dx, nativeUnit, dimStyle)}
                </div>
              </div>
            )}
            {measurement.dy !== undefined && (
              <div>
                <div className="text-[10px] text-slate-400">Vertical (ΔY)</div>
                <div className="font-mono-cad text-slate-100 font-medium">
                  {formatLength(measurement.dy, nativeUnit, dimStyle)}
                </div>
              </div>
            )}
            {measurement.area !== undefined && (
              <div>
                <div className="text-[10px] text-slate-400">Area</div>
                <div className="font-mono-cad text-slate-100 font-medium">
                  {formatArea(measurement.area, nativeUnit, dimStyle)}
                </div>
              </div>
            )}
          </div>

          {(measurement.start || measurement.center) && (
            <div className="pt-1.5 border-t border-slate-800/80 space-y-0.5 text-[11px] font-mono-cad">
              {measurement.start && (
                <div className="flex justify-between gap-2 text-slate-300">
                  <span className="text-slate-400 shrink-0">
                    {activeSeg ? `Seg #${activeSeg.index + 1} Start` : 'Start'}
                  </span>
                  <span className="truncate">
                    ({measurement.start.x.toFixed(dimStyle.precision)}, {measurement.start.y.toFixed(dimStyle.precision)})
                  </span>
                </div>
              )}
              {measurement.end && (
                <div className="flex justify-between gap-2 text-slate-300">
                  <span className="text-slate-400 shrink-0">
                    {activeSeg ? `Seg #${activeSeg.index + 1} End` : 'End'}
                  </span>
                  <span className="truncate">
                    ({measurement.end.x.toFixed(dimStyle.precision)}, {measurement.end.y.toFixed(dimStyle.precision)})
                  </span>
                </div>
              )}
              {measurement.center && (
                <div className="flex justify-between gap-2 text-slate-300">
                  <span className="text-slate-400 shrink-0">Center</span>
                  <span className="truncate">
                    ({measurement.center.x.toFixed(dimStyle.precision)}, {measurement.center.y.toFixed(dimStyle.precision)})
                  </span>
                </div>
              )}
            </div>
          )}

          {measurement.segments && measurement.segments.length > 0 && (
            <div className="pt-1.5 border-t border-slate-800/80">
              <div className="text-[11px] text-slate-400 mb-1">
                Polyline Segments ({measurement.segments.length} · {measurement.closed ? 'Closed' : 'Open'})
              </div>
              <div className="space-y-1">
                {measurement.segments.map((seg) => {
                  const isAct = seg.index === measurement.activeSegmentIndex;
                  return (
                    <button
                      key={seg.index}
                      type="button"
                      onClick={() => onSelectSegment?.(seg.index)}
                      className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-mono-cad cursor-pointer ${
                        isAct
                          ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                          : 'bg-slate-900/60 text-slate-300'
                      }`}
                    >
                      <span>
                        #{seg.index + 1} {seg.isArc ? 'Arc' : 'Line'}
                      </span>
                      <span>{formatLength(seg.length, nativeUnit, dimStyle)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={copyFullSummary}
            className="w-full py-2 rounded-lg bg-slate-900 text-xs text-slate-300 font-medium text-center cursor-pointer border border-slate-800"
          >
            Copy Full Summary
          </button>
        </div>
      )}
    </section>
  );
};
