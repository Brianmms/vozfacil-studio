import React, { useEffect, useState } from 'react';

interface CelebrationOverlayProps {
  show: boolean;
  onDone?: () => void;
  message?: string;
  score?: number;
  triggerKey?: number;
  imageSrc?: string;
}

const SPARKLES = [
  { char: '✨', className: 'top-2 left-3 text-xl sm:text-2xl text-amber-400', delay: '0ms' },
  { char: '★', className: 'top-1 right-6 text-lg sm:text-xl text-red-500', delay: '180ms' },
  { char: '♪', className: 'top-14 left-0 text-xl sm:text-2xl text-rose-500', delay: '320ms' },
  { char: '♫', className: 'top-12 right-0 text-xl sm:text-2xl text-amber-500', delay: '480ms' },
  { char: '✨', className: 'bottom-20 left-2 text-lg sm:text-xl text-yellow-400', delay: '640ms' },
  { char: '●', className: 'bottom-16 right-4 text-xs text-red-500', delay: '240ms' },
  { char: '★', className: 'top-1/2 -left-1 text-base sm:text-lg text-amber-400', delay: '520ms' },
];

/**
 * Large, lively, non-blocking celebration in the bottom-right corner.
 * Uses `pointer-events-none` everywhere so underlying buttons remain clickable.
 */
export const CelebrationOverlay: React.FC<CelebrationOverlayProps> = ({
  show,
  onDone,
  message = '¡Súper bien! 🐞✨',
  score,
  triggerKey = 0,
  imageSrc = './celebration-ladybug.webp',
}) => {
  const [imageFailed, setImageFailed] = useState(false);
  const [isExiting, setIsExiting] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [imageSrc]);

  useEffect(() => {
    if (!show) {
      setIsExiting(false);
      return;
    }

    setIsExiting(false);
    const exitTimer = window.setTimeout(() => setIsExiting(true), 5000);
    const doneTimer = window.setTimeout(() => onDone?.(), 5500);

    return () => {
      window.clearTimeout(exitTimer);
      window.clearTimeout(doneTimer);
    };
  }, [show, triggerKey, onDone]);

  if (!show) return null;

  return (
    <div
      key={triggerKey}
      className={`pointer-events-none select-none fixed bottom-3 right-3 sm:bottom-5 sm:right-6 z-[75] flex flex-col items-end gap-1 ${
        isExiting ? 'animate-celebration-out' : 'animate-celebration-in'
      }`}
      aria-live="polite"
      data-testid="celebration-overlay"
    >
      {/* Speech bubble with score badge */}
      <div className="pointer-events-none animate-celebration-badge rounded-2xl bg-gradient-to-r from-red-600 via-rose-600 to-red-500 text-white border-2 border-white shadow-xl px-4 py-2 text-sm sm:text-base font-extrabold flex items-center gap-2">
        <span>{message}</span>
        {score !== undefined && (
          <span className="rounded-full bg-white text-red-700 px-2.5 py-0.5 text-xs sm:text-sm font-black shadow-xs">
            {Math.round(score)}%
          </span>
        )}
      </div>

      {/* Dancing character stage */}
      <div className="pointer-events-none relative flex items-end justify-center">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-4 rounded-full bg-gradient-to-tr from-red-500/25 via-rose-400/20 to-amber-300/25 blur-2xl"
        />

        {SPARKLES.map((item, idx) => (
          <span
            key={idx}
            aria-hidden="true"
            style={{ animationDelay: item.delay }}
            className={`pointer-events-none absolute font-black drop-shadow-xs animate-ladybug-sparkle ${item.className}`}
          >
            {item.char}
          </span>
        ))}

        {!imageFailed ? (
          <img
            src={imageSrc}
            alt="Ladybug celebrando tu puntaje"
            onError={() => setImageFailed(true)}
            draggable={false}
            className="pointer-events-none relative z-10 h-64 sm:h-80 md:h-[22rem] w-auto max-w-[55vw] object-contain drop-shadow-[0_14px_24px_rgba(220,38,38,0.35)] origin-bottom animate-ladybug-dance"
          />
        ) : (
          <div className="pointer-events-none relative z-10 flex items-end gap-2 px-4 py-6 text-6xl sm:text-7xl">
            <span className="animate-ladybug-dance">🐞</span>
            <span className="animate-bounce" style={{ animationDelay: '120ms' }}>
              💃
            </span>
            <span className="animate-bounce" style={{ animationDelay: '240ms' }}>
              🎉
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
