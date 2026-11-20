import React, { useRef, useState } from 'react';
import type { AudioCutRange } from '../types';
import { formatTime, formatTimePrecise } from '../lib/audioUtils';

interface WaveformCanvasProps {
  peaks: number[];
  durationSec: number;
  trimStart?: number;
  trimEnd?: number;
  cuts?: AudioCutRange[];
  selectedRange?: AudioCutRange | null;
  playheadSec?: number | null;
  height?: number;
  onSeek?: (seconds: number) => void;
  onTrimStartChange?: (seconds: number) => void;
  onTrimEndChange?: (seconds: number) => void;
  onSelectRange?: (range: AudioCutRange | null) => void;
  showTimeLabels?: boolean;
}

export const WaveformCanvas: React.FC<WaveformCanvasProps> = ({
  peaks,
  durationSec,
  trimStart = 0,
  trimEnd,
  cuts = [],
  selectedRange = null,
  playheadSec = null,
  height = 56,
  onSeek,
  onTrimStartChange,
  onTrimEndChange,
  onSelectRange,
  showTimeLabels = false,
}) => {
  const [hoverSec, setHoverSec] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const dragModeRef = useRef<
    | { type: 'start' }
    | { type: 'end' }
    | { type: 'select'; startX: number; anchorSec: number; moved: boolean }
    | null
  >(null);

  const safeDuration = Math.max(0.01, durationSec);
  const effectiveEnd = trimEnd ?? safeDuration;
  const bars = peaks.length > 0 ? peaks : new Array(60).fill(0.15);

  const getSecFromClientX = (clientX: number) => {
    const el = containerRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    return Number((ratio * safeDuration).toFixed(2));
  };

  const handleContainerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (!onSeek && !onSelectRange) return;

    const rawSec = getSecFromClientX(e.clientX);
    const clampedSec = Math.max(trimStart, Math.min(effectiveEnd, rawSec));
    dragModeRef.current = {
      type: 'select',
      startX: e.clientX,
      anchorSec: clampedSec,
      moved: false,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore synthetic event without active pointerId
    }
  };

  const handleHandlePointerDown = (
    type: 'start' | 'end',
    e: React.PointerEvent<HTMLDivElement>
  ) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    dragModeRef.current = { type };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rawSec = getSecFromClientX(e.clientX);
    if (onSeek || onSelectRange) {
      setHoverSec(rawSec);
    }

    const mode = dragModeRef.current;
    if (!mode) return;

    if (mode.type === 'start' && onTrimStartChange) {
      const next = Number(
        Math.max(0, Math.min(effectiveEnd - 0.15, rawSec)).toFixed(2)
      );
      onTrimStartChange(next);
      return;
    }

    if (mode.type === 'end' && onTrimEndChange) {
      const next = Number(
        Math.min(safeDuration, Math.max(trimStart + 0.15, rawSec)).toFixed(2)
      );
      onTrimEndChange(next);
      return;
    }

    if (mode.type === 'select' && onSelectRange) {
      if (Math.abs(e.clientX - mode.startX) >= 6) {
        mode.moved = true;
        const curr = Math.max(trimStart, Math.min(effectiveEnd, rawSec));
        const start = Number(Math.min(mode.anchorSec, curr).toFixed(2));
        const end = Number(Math.max(mode.anchorSec, curr).toFixed(2));
        onSelectRange({ start, end });
      }
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const mode = dragModeRef.current;
    dragModeRef.current = null;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore
    }

    if (!mode) return;

    if (mode.type === 'select') {
      if (mode.moved && onSelectRange) {
        const curr = Math.max(trimStart, Math.min(effectiveEnd, getSecFromClientX(e.clientX)));
        const start = Number(Math.min(mode.anchorSec, curr).toFixed(2));
        const end = Number(Math.max(mode.anchorSec, curr).toFixed(2));
        if (end - start < 0.08) {
          onSelectRange(null);
        } else {
          onSelectRange({ start, end });
        }
      } else if (onSeek) {
        onSeek(getSecFromClientX(e.clientX));
      }
    }
  };

  const startPct = Math.max(0, Math.min(100, (trimStart / safeDuration) * 100));
  const endPct = Math.max(0, Math.min(100, (effectiveEnd / safeDuration) * 100));
  const playPct =
    playheadSec !== null
      ? Math.max(0, Math.min(100, (playheadSec / safeDuration) * 100))
      : null;
  const hoverPct =
    hoverSec !== null
      ? Math.max(0, Math.min(100, (hoverSec / safeDuration) * 100))
      : null;

  const isInCut = (sec: number) =>
    cuts.some((c) => sec >= c.start && sec <= c.end);

  return (
    <div className={showTimeLabels ? 'space-y-1' : undefined}>
      <div
        ref={containerRef}
        onPointerDown={handleContainerPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => {
          dragModeRef.current = null;
        }}
        onMouseLeave={() => setHoverSec(null)}
        className={`relative w-full select-none touch-none rounded-xl bg-slate-100/80 border border-slate-200 px-2 py-1.5 overflow-hidden ${
          onSeek || onSelectRange
            ? 'cursor-crosshair hover:border-indigo-300 transition-colors'
            : ''
        }`}
        style={{ height }}
        title={
          onSelectRange
            ? 'Clic para saltar · Arrastra para seleccionar y cortar un silencio o parte intermedia'
            : onSeek
            ? 'Haz clic en cualquier punto de la onda para saltar ahí'
            : undefined
        }
      >
        {/* Dimmed trimmed edge regions */}
        {startPct > 0.2 && (
          <div
            className="absolute inset-y-0 left-0 bg-slate-300/60 pointer-events-none"
            style={{ width: `${startPct}%` }}
          />
        )}
        {endPct < 99.8 && (
          <div
            className="absolute inset-y-0 right-0 bg-slate-300/60 pointer-events-none"
            style={{ width: `${100 - endPct}%` }}
          />
        )}

        {/* Internal removed cut zones */}
        {cuts.map((cut, i) => {
          const leftPct = Math.max(0, Math.min(100, (cut.start / safeDuration) * 100));
          const rightPct = Math.max(0, Math.min(100, (cut.end / safeDuration) * 100));
          const widthPct = Math.max(0.4, rightPct - leftPct);
          return (
            <div
              key={`${cut.start}-${cut.end}-${i}`}
              className="absolute inset-y-0 bg-rose-200/55 border-x border-rose-400/70 pointer-events-none"
              style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
            />
          );
        })}

        {/* Active drag selection box */}
        {selectedRange && selectedRange.end > selectedRange.start && (
          <div
            className="absolute inset-y-0 bg-rose-500/20 border-x-2 border-rose-500 z-10 pointer-events-none"
            style={{
              left: `${Math.max(0, Math.min(100, (selectedRange.start / safeDuration) * 100))}%`,
              width: `${Math.max(
                0.5,
                Math.min(
                  100,
                  ((selectedRange.end - selectedRange.start) / safeDuration) * 100
                )
              )}%`,
            }}
          />
        )}

        {/* Bars */}
        <div className="relative z-10 flex items-center justify-between gap-[2px] h-full w-full pointer-events-none">
          {bars.map((peak, idx) => {
            const barRatio = (idx + 0.5) / bars.length;
            const barSec = barRatio * safeDuration;
            const isTrimmedOut =
              barSec < trimStart || barSec > effectiveEnd || isInCut(barSec);
            const isPlayed =
              playheadSec !== null && barSec <= playheadSec && !isTrimmedOut;

            let barColor = 'bg-indigo-300';
            if (isTrimmedOut) barColor = 'bg-slate-300';
            else if (isPlayed) barColor = 'bg-indigo-600';

            const barHeightPct = Math.max(10, Math.min(100, Math.round(peak * 100)));

            return (
              <div
                key={idx}
                className={`flex-1 rounded-full transition-colors duration-75 ${barColor}`}
                style={{ height: `${barHeightPct}%` }}
              />
            );
          })}
        </div>

        {/* Draggable Trim Start Handle */}
        {onTrimStartChange && (
          <div
            data-handle="trim-start"
            onPointerDown={(e) => handleHandlePointerDown('start', e)}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            className="absolute inset-y-0 z-30 w-3 -ml-1.5 cursor-ew-resize flex items-center justify-center group touch-none"
            style={{ left: `${startPct}%` }}
            title={`Arrastra para ajustar el inicio (${formatTimePrecise(trimStart)})`}
          >
            <div className="w-[3px] h-full bg-amber-500 group-hover:bg-amber-600 shadow-xs" />
            <div className="absolute w-2.5 h-4 rounded-sm bg-amber-500 group-hover:bg-amber-600 border border-white shadow" />
          </div>
        )}

        {/* Draggable Trim End Handle */}
        {onTrimEndChange && (
          <div
            data-handle="trim-end"
            onPointerDown={(e) => handleHandlePointerDown('end', e)}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            className="absolute inset-y-0 z-30 w-3 -ml-1.5 cursor-ew-resize flex items-center justify-center group touch-none"
            style={{ left: `${endPct}%` }}
            title={`Arrastra para ajustar el final (${formatTimePrecise(effectiveEnd)})`}
          >
            <div className="w-[3px] h-full bg-amber-500 group-hover:bg-amber-600 shadow-xs" />
            <div className="absolute w-2.5 h-4 rounded-sm bg-amber-500 group-hover:bg-amber-600 border border-white shadow" />
          </div>
        )}

        {/* Hover preview line */}
        {hoverPct !== null && (
          <div
            className="absolute inset-y-0 w-px bg-indigo-400/75 z-10 pointer-events-none"
            style={{ left: `${hoverPct}%` }}
          />
        )}

        {/* Animated Playhead line + circular dot */}
        {playPct !== null && (
          <div
            className="absolute inset-y-0 w-[2.5px] bg-rose-500 z-20 pointer-events-none shadow-sm"
            style={{ left: `${playPct}%` }}
          >
            <span className="absolute top-0.5 -left-[3.5px] w-2.5 h-2.5 rounded-full bg-rose-600 ring-2 ring-white shadow" />
          </div>
        )}
      </div>

      {showTimeLabels && (
        <div className="flex items-center justify-between text-[11px] font-mono text-slate-500 px-0.5">
          <span className={playheadSec !== null ? 'font-bold text-rose-600' : ''}>
            {formatTime(playheadSec ?? 0)}
          </span>
          {hoverSec !== null && (onSeek || onSelectRange) && (
            <span className="text-[10px] text-indigo-600 font-semibold">
              Cursor: {formatTimePrecise(hoverSec)}
            </span>
          )}
          <span>{formatTime(durationSec)}</span>
        </div>
      )}
    </div>
  );
};
