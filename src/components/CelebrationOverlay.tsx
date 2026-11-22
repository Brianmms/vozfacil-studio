import React, { useEffect, useState } from 'react';

interface CelebrationOverlayProps {
  show: boolean;
  onDone?: () => void;
  message?: string;
  imageSrc?: string;
}

/**
 * Small, non-blocking celebration in the bottom-right corner.
 * It uses `pointer-events-none`, so it never blocks the UI, and auto-dismisses.
 * Drop your own image/GIF at public/celebration.gif (or pass imageSrc).
 */
export const CelebrationOverlay: React.FC<CelebrationOverlayProps> = ({
  show,
  onDone,
  message = '¡Muy bien!',
  imageSrc = './celebration.gif',
}) => {
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    if (!show) return;
    const timer = window.setTimeout(() => onDone?.(), 5000);
    return () => window.clearTimeout(timer);
  }, [show, onDone]);

  if (!show) return null;

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[75] flex flex-col items-end gap-2"
      aria-live="polite"
    >
      <div className="rounded-2xl bg-white/95 backdrop-blur border border-emerald-200 shadow-lg px-3.5 py-2 text-sm font-extrabold text-emerald-800 animate-bounce">
        {message}
      </div>

      {!imageFailed ? (
        <img
          src={imageSrc}
          alt="Celebración"
          onError={() => setImageFailed(true)}
          className="h-36 w-36 sm:h-44 sm:w-44 object-contain drop-shadow-2xl animate-bounce"
        />
      ) : (
        <div className="flex items-end gap-1 text-5xl">
          <span className="animate-bounce" style={{ animationDelay: '0ms' }}>
            💃
          </span>
          <span className="animate-bounce" style={{ animationDelay: '120ms' }}>
            🎉
          </span>
          <span className="animate-bounce" style={{ animationDelay: '240ms' }}>
            🕺
          </span>
        </div>
      )}
    </div>
  );
};
