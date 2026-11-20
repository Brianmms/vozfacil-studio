import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  CheckCircle2,
  Copy,
  Download,
  FileAudio,
  GripVertical,
  Loader2,
  Mic,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Scissors,
  Sliders,
  Sparkles,
  Square,
  Trash2,
  Upload,
  Volume2,
  X,
  Zap,
} from 'lucide-react';
import type {
  AudioCutRange,
  EvaluationResult,
  Project,
  ScriptSegment,
  StitchedRender,
  StudioClip,
  Take,
  VoiceId,
} from '../types';
import { deleteAudioApi, evaluateAudioApi, uploadAudioBlob } from '../lib/api';
import { PcmAudioRecorder } from '../lib/audioRecorder';
import { encodeAudioBufferToMp3, renderStitchedAudio } from '../lib/audioStitcher';
import {
  convertBlobToCleanWav,
  convertToAsrWavChunks,
  detectInternalSilences,
  ensureAudioContextRunning,
  evictAudioBufferCache,
  extractPeaksFromFloat32,
  extractSamplesWithCuts,
  fetchAudioBuffer,
  formatTime,
  formatTimePrecise,
  getEffectiveClipDuration,
  getKeptRanges,
  mapOutputTimeToSourceTime,
  mergeCutRanges,
  mixToMono,
} from '../lib/audioUtils';
import { EvaluationCard } from './EvaluationCard';
import { WaveformCanvas } from './WaveformCanvas';
import { speakEnglishText, stopAllSpeech } from '../lib/ttsPlayer';

interface StudioViewProps {
  project: Project;
  voiceId: VoiceId;
  hasApiKey: boolean;
  onUpdateProject: (updated: Project) => Promise<void>;
  onGoToPractice: () => void;
  onOpenSettings?: () => void;
}

function segmentToClip(seg: ScriptSegment, take: Take): StudioClip {
  return {
    id: `clip-${seg.id}`,
    sourceSegmentId: seg.id,
    title: seg.title,
    text: seg.text,
    speaker: seg.speaker,
    cueAfter: seg.cueAfter,
    audioUrl: take.audioUrl,
    filename: take.filename,
    durationSec: take.durationSec,
    trimStart: 0,
    trimEnd: take.durationSec,
    cuts: [],
    pauseAfterSec: seg.pauseAfterSec ?? 0.45,
    gain: 1,
    peaks: take.peaks,
  };
}

export const StudioView: React.FC<StudioViewProps> = ({
  project,
  voiceId,
  hasApiKey,
  onUpdateProject,
  onGoToPractice,
  onOpenSettings,
}) => {
  const [clips, setClips] = useState<StudioClip[]>([]);
  const [normalizeVolume, setNormalizeVolume] = useState(true);
  const [smoothFades, setSmoothFades] = useState(true);
  const [stitched, setStitched] = useState<StitchedRender | null>(null);
  const [isStitching, setIsStitching] = useState(false);
  const [isExportingMp3, setIsExportingMp3] = useState(false);
  const [studioError, setStudioError] = useState<string | null>(null);
  const [trimmingAll, setTrimmingAll] = useState(false);

  // Clip single playback
  const [playingClipId, setPlayingClipId] = useState<string | null>(null);
  const [clipPlayhead, setClipPlayhead] = useState<number | null>(null);
  const clipSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const clipRafRef = useRef<number | null>(null);

  // Master playback
  const [isPlayingMaster, setIsPlayingMaster] = useState(false);
  const [masterPlayhead, setMasterPlayhead] = useState(0);
  const masterSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const masterRafRef = useRef<number | null>(null);
  const masterStartOffsetRef = useRef(0);

  // Recording inside Studio (free clip or for a missing segment)
  const [recordingTargetSegId, setRecordingTargetSegId] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [recElapsed, setRecElapsed] = useState(0);
  const [savingClip, setSavingClip] = useState(false);
  const recorderRef = useRef<PcmAudioRecorder | null>(null);

  // Drag reorder & clip range selection
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [selectionByClip, setSelectionByClip] = useState<
    Record<string, AudioCutRange | null>
  >({});
  const [lastCursorByClip, setLastCursorByClip] = useState<Record<string, number>>(
    {}
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Full evaluation
  const [isEvaluatingMaster, setIsEvaluatingMaster] = useState(false);
  const [masterEvaluation, setMasterEvaluation] = useState<EvaluationResult | null>(null);

  const missingSegments = useMemo(
    () => project.segments.filter((s) => !s.selectedTakeId || !s.takes.some((t) => t.id === s.selectedTakeId)),
    [project.segments]
  );

  // Studio teleprompter (so the script is always visible when recording in Studio)
  const [showTeleprompter, setShowTeleprompter] = useState(false);
  const [teleprompterSegmentId, setTeleprompterSegmentId] = useState<string>(
    () => missingSegments[0]?.id || project.segments[0]?.id || ''
  );
  const [isPlayingGuide, setIsPlayingGuide] = useState(false);

  const activeTeleprompterSeg = useMemo(() => {
    const id = recordingTargetSegId || teleprompterSegmentId;
    if (!id || id === 'none') return null;
    return project.segments.find((s) => s.id === id) || null;
  }, [recordingTargetSegId, teleprompterSegmentId, project.segments]);

  useEffect(() => {
    if (!project.segments.some((s) => s.id === teleprompterSegmentId) && teleprompterSegmentId !== 'none') {
      setTeleprompterSegmentId(missingSegments[0]?.id || project.segments[0]?.id || '');
    }
  }, [project.id, project.segments, missingSegments, teleprompterSegmentId]);

  // Sync from project selected takes when project changes or first loads
  useEffect(() => {
    syncFromProjectTakes(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  // Also keep clips refreshed cleanly when project takes change while preserving manual clips & custom edits
  useEffect(() => {
    setClips((prev) => {
      if (prev.length === 0) {
        const seeded: StudioClip[] = [];
        for (const seg of project.segments) {
          const take = seg.takes.find((t) => t.id === seg.selectedTakeId);
          if (take) seeded.push(segmentToClip(seg, take));
        }
        return seeded;
      }

      const prevBySeg = new Map(
        prev.filter((c) => c.sourceSegmentId).map((c) => [c.sourceSegmentId!, c])
      );
      const freeClips = prev.filter((c) => !c.sourceSegmentId);

      const syncedFromScript: StudioClip[] = [];
      for (const seg of project.segments) {
        const take = seg.takes.find((t) => t.id === seg.selectedTakeId);
        if (!take) continue;
        const existing = prevBySeg.get(seg.id);
        if (existing && existing.filename === take.filename) {
          syncedFromScript.push(existing);
        } else {
          syncedFromScript.push(segmentToClip(seg, take));
        }
      }

      // Preserve user-reordered non-script clips at the end
      return [...syncedFromScript, ...freeClips];
    });
  }, [project.segments]);

  useEffect(() => {
    // Invalidate master render whenever clips or mix options change
    stopMasterPlayback();
    setStitched(null);
    setMasterEvaluation(null);
  }, [clips, normalizeVolume, smoothFades]);

  useEffect(() => {
    return () => {
      stopAllSpeech();
      stopClipPlayback();
      stopMasterPlayback();
      recorderRef.current?.cancel();
    };
  }, []);

  async function handlePlayTeleprompterGuide(seg: ScriptSegment) {
    if (isPlayingGuide) {
      stopAllSpeech();
      setIsPlayingGuide(false);
      return;
    }
    stopClipPlayback();
    stopMasterPlayback();
    setIsPlayingGuide(true);
    try {
      await speakEnglishText(seg.text, { voiceId, rate: 0.85 });
    } finally {
      setIsPlayingGuide(false);
    }
  }

  function syncFromProjectTakes(replaceAll = false) {
    const fromScript: StudioClip[] = [];
    for (const seg of project.segments) {
      const take = seg.takes.find((t) => t.id === seg.selectedTakeId);
      if (take) {
        fromScript.push(segmentToClip(seg, take));
      }
    }
    if (replaceAll) {
      setClips(fromScript);
    } else {
      setClips((prev) => {
        const free = prev.filter((c) => !c.sourceSegmentId);
        return [...fromScript, ...free];
      });
    }
  }

  function stopClipPlayback() {
    if (clipRafRef.current !== null) {
      cancelAnimationFrame(clipRafRef.current);
      clipRafRef.current = null;
    }
    try {
      clipSourceRef.current?.stop();
      clipSourceRef.current?.disconnect();
    } catch {
      // Ignore
    }
    clipSourceRef.current = null;
    setPlayingClipId(null);
    setClipPlayhead(null);
  }

  function stopMasterPlayback() {
    if (masterRafRef.current !== null) {
      cancelAnimationFrame(masterRafRef.current);
      masterRafRef.current = null;
    }
    try {
      masterSourceRef.current?.stop();
      masterSourceRef.current?.disconnect();
    } catch {
      // Ignore
    }
    masterSourceRef.current = null;
    setIsPlayingMaster(false);
  }

  async function handlePlaySingleClip(
    clip: StudioClip,
    seekSec?: number,
    rangeOverride?: AudioCutRange
  ) {
    if (playingClipId === clip.id && seekSec === undefined && !rangeOverride) {
      stopClipPlayback();
      return;
    }

    stopClipPlayback();
    stopMasterPlayback();
    setStudioError(null);

    try {
      const [buffer, ctx] = await Promise.all([
        fetchAudioBuffer(clip.audioUrl),
        ensureAudioContextRunning(),
      ]);

      const mono = mixToMono(buffer);
      const sr = buffer.sampleRate;

      let rangesToPlay: AudioCutRange[];
      if (rangeOverride) {
        const s = Math.max(0, Math.min(buffer.duration - 0.05, rangeOverride.start));
        const e = Math.min(buffer.duration, Math.max(s + 0.05, rangeOverride.end));
        rangesToPlay = [{ start: s, end: e }];
      } else {
        const keptRanges = getKeptRanges(
          clip.trimStart,
          Math.min(buffer.duration, clip.trimEnd),
          clip.cuts || []
        );
        if (seekSec !== undefined) {
          const filtered = keptRanges
            .filter((r) => r.end > seekSec + 0.02)
            .map((r) => ({ start: Math.max(r.start, seekSec), end: r.end }));
          rangesToPlay = filtered.length > 0 ? filtered : keptRanges;
        } else {
          rangesToPlay = keptRanges;
        }
      }

      const { samples, segmentMap } = extractSamplesWithCuts(
        mono,
        sr,
        rangesToPlay,
        rangeOverride ? 0 : 12
      );
      if (samples.length === 0) {
        throw new Error('No quedó audio activo para reproducir en este clip.');
      }

      const playBuffer = ctx.createBuffer(1, samples.length, sr);
      playBuffer.getChannelData(0).set(samples);

      const source = ctx.createBufferSource();
      source.buffer = playBuffer;

      const gainNode = ctx.createGain();
      gainNode.gain.value = clip.gain;
      source.connect(gainNode);
      gainNode.connect(ctx.destination);

      const playDur = playBuffer.duration;
      const startedCtxTime = ctx.currentTime;
      const initialSrcSec = segmentMap[0]?.srcStart ?? clip.trimStart;

      clipSourceRef.current = source;
      setPlayingClipId(clip.id);
      setClipPlayhead(initialSrcSec);
      setLastCursorByClip((prev) => ({ ...prev, [clip.id]: initialSrcSec }));

      source.onended = () => {
        if (clipSourceRef.current === source) {
          stopClipPlayback();
        }
      };

      const tick = () => {
        if (clipSourceRef.current !== source) return;
        const elapsed = ctx.currentTime - startedCtxTime;
        const srcPos = mapOutputTimeToSourceTime(elapsed, segmentMap);
        setClipPlayhead(srcPos);
        setLastCursorByClip((prev) => ({ ...prev, [clip.id]: srcPos }));
        if (elapsed < playDur) {
          clipRafRef.current = requestAnimationFrame(tick);
        }
      };
      clipRafRef.current = requestAnimationFrame(tick);

      source.start(0);
    } catch (err) {
      setStudioError(
        err instanceof Error ? err.message : 'No se pudo reproducir este clip.'
      );
      stopClipPlayback();
    }
  }

  function updateClip(clipId: string, patch: Partial<StudioClip>) {
    setClips((prev) => prev.map((c) => (c.id === clipId ? { ...c, ...patch } : c)));
  }

  function moveClip(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= clips.length) return;
    setClips((prev) => {
      const next = [...prev];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return next;
    });
  }

  function duplicateClip(index: number) {
    const orig = clips[index];
    if (!orig) return;
    const copy: StudioClip = {
      ...orig,
      id: `clip-${crypto.randomUUID().slice(0, 8)}`,
      sourceSegmentId: undefined,
      title: `${orig.title} (copia)`,
      cuts: orig.cuts ? orig.cuts.map((c) => ({ ...c })) : [],
    };
    setClips((prev) => {
      const next = [...prev];
      next.splice(index + 1, 0, copy);
      return next;
    });
  }

  async function removeClip(clip: StudioClip) {
    if (playingClipId === clip.id) stopClipPlayback();

    const remainingClips = clips.filter((c) => c.id !== clip.id);
    setClips(remainingClips);
    setSelectionByClip((prev) => {
      const next = { ...prev };
      delete next[clip.id];
      return next;
    });

    const filename = clip.filename;
    const stillUsedInStudio =
      Boolean(filename) && remainingClips.some((c) => c.filename === filename);

    if (!stillUsedInStudio) {
      evictAudioBufferCache(clip.audioUrl);
      if (filename) {
        try {
          await deleteAudioApi(filename);
        } catch {
          // File may already be deleted from disk
        }
      }

      if (filename || clip.sourceSegmentId) {
        let changed = false;
        const updatedSegments = project.segments.map((seg) => {
          const matchesTake = seg.takes.some(
            (t) => (filename && t.filename === filename) || (clip.sourceSegmentId === seg.id && t.id === seg.selectedTakeId)
          );
          if (!matchesTake) return seg;
          changed = true;
          const remainingTakes = seg.takes.filter(
            (t) => !(filename ? t.filename === filename : t.id === seg.selectedTakeId)
          );
          const nextSelected = remainingTakes.some((t) => t.id === seg.selectedTakeId)
            ? seg.selectedTakeId
            : remainingTakes[0]?.id || null;
          return {
            ...seg,
            takes: remainingTakes,
            selectedTakeId: nextSelected,
          };
        });

        if (changed) {
          await onUpdateProject({
            ...project,
            segments: updatedSegments,
          });
        }
      }
    }
  }

  function handleCutSelectedRange(clip: StudioClip) {
    const sel = selectionByClip[clip.id];
    if (!sel || sel.end - sel.start < 0.05) return;
    if (playingClipId === clip.id) stopClipPlayback();
    const nextCuts = mergeCutRanges(
      [...(clip.cuts || []), sel],
      clip.trimStart,
      clip.trimEnd
    );
    updateClip(clip.id, { cuts: nextCuts });
    setSelectionByClip((prev) => ({ ...prev, [clip.id]: null }));
  }

  function handleRemoveSingleCut(clip: StudioClip, cutIdx: number) {
    if (playingClipId === clip.id) stopClipPlayback();
    const nextCuts = (clip.cuts || []).filter((_, i) => i !== cutIdx);
    updateClip(clip.id, { cuts: nextCuts });
  }

  function handleSplitClip(clip: StudioClip, index: number) {
    if (clip.trimEnd - clip.trimStart < 0.6) return;
    if (playingClipId === clip.id) stopClipPlayback();

    const fallbackMid = Number(((clip.trimStart + clip.trimEnd) / 2).toFixed(2));
    const candidate =
      playingClipId === clip.id && clipPlayhead !== null
        ? clipPlayhead
        : lastCursorByClip[clip.id] ?? fallbackMid;
    const splitSec = Number(
      Math.max(clip.trimStart + 0.25, Math.min(clip.trimEnd - 0.25, candidate)).toFixed(
        2
      )
    );

    const leftClip: StudioClip = {
      ...clip,
      title: `${clip.title} (1)`,
      trimEnd: splitSec,
      cuts: mergeCutRanges(clip.cuts || [], clip.trimStart, splitSec),
      pauseAfterSec: 0.15,
    };
    const rightClip: StudioClip = {
      ...clip,
      id: `clip-${crypto.randomUUID().slice(0, 8)}`,
      sourceSegmentId: undefined,
      title: `${clip.title} (2)`,
      trimStart: splitSec,
      cuts: mergeCutRanges(clip.cuts || [], splitSec, clip.trimEnd),
    };

    setClips((prev) => {
      const next = [...prev];
      next.splice(index, 1, leftClip, rightClip);
      return next;
    });
    setSelectionByClip((prev) => ({ ...prev, [clip.id]: null }));
  }

  async function autoTrimClip(clip: StudioClip) {
    if (playingClipId === clip.id) stopClipPlayback();
    try {
      const buf = await fetchAudioBuffer(clip.audioUrl);
      const { trimStart, trimEnd, cuts } = detectInternalSilences(buf);
      const crispPeaks = extractPeaksFromFloat32(mixToMono(buf), 120);
      updateClip(clip.id, { trimStart, trimEnd, cuts, peaks: crispPeaks });
      setSelectionByClip((prev) => ({ ...prev, [clip.id]: null }));
    } catch {
      // Ignore single trim failures
    }
  }

  async function autoTrimAllClips() {
    if (clips.length === 0) return;
    stopClipPlayback();
    setTrimmingAll(true);
    try {
      const updated = await Promise.all(
        clips.map(async (clip) => {
          try {
            const buf = await fetchAudioBuffer(clip.audioUrl);
            const { trimStart, trimEnd, cuts } = detectInternalSilences(buf);
            const crispPeaks = extractPeaksFromFloat32(mixToMono(buf), 120);
            return { ...clip, trimStart, trimEnd, cuts, peaks: crispPeaks };
          } catch {
            return clip;
          }
        })
      );
      setClips(updated);
      setSelectionByClip({});
    } finally {
      setTrimmingAll(false);
    }
  }

  async function handleStartStudioRecording(targetSegmentId: string | null = null) {
    if (isRecording || savingClip) return;
    stopClipPlayback();
    stopMasterPlayback();
    setStudioError(null);

    try {
      const rec = new PcmAudioRecorder();
      recorderRef.current = rec;
      setRecordingTargetSegId(targetSegmentId);
      await rec.start((lvl, elapsed) => {
        setMicLevel(lvl);
        setRecElapsed(elapsed);
      });
      setIsRecording(true);
    } catch (err) {
      setRecordingTargetSegId(null);
      setStudioError(
        err instanceof Error ? err.message : 'No se pudo iniciar el micrófono.'
      );
    }
  }

  async function handleStopStudioRecording() {
    if (!recorderRef.current) return;
    setIsRecording(false);
    setSavingClip(true);
    setStudioError(null);

    try {
      const result = await recorderRef.current.stop();
      recorderRef.current = null;
      const uploaded = await uploadAudioBlob(result.blob, 'studio-clip.wav');

      if (recordingTargetSegId) {
        const seg = project.segments.find((s) => s.id === recordingTargetSegId);
        if (seg) {
          const newTake: Take = {
            id: `take-${crypto.randomUUID().slice(0, 8)}`,
            createdAt: new Date().toISOString(),
            label: `Toma ${seg.takes.length + 1}`,
            filename: uploaded.filename,
            audioUrl: uploaded.url,
            durationSec: result.durationSec,
            peaks: result.peaks,
          };
          const updatedProject: Project = {
            ...project,
            segments: project.segments.map((s) =>
              s.id === seg.id
                ? { ...s, takes: [...s.takes, newTake], selectedTakeId: newTake.id }
                : s
            ),
          };
          await onUpdateProject(updatedProject);
        }
      } else {
        const freeClip: StudioClip = {
          id: `clip-${crypto.randomUUID().slice(0, 8)}`,
          title: `Clip libre #${clips.length + 1}`,
          audioUrl: uploaded.url,
          filename: uploaded.filename,
          durationSec: result.durationSec,
          trimStart: 0,
          trimEnd: result.durationSec,
          pauseAfterSec: 0.45,
          gain: 1,
          peaks: result.peaks,
        };
        setClips((prev) => [...prev, freeClip]);
      }
    } catch (err) {
      setStudioError(
        err instanceof Error ? err.message : 'No se pudo guardar el clip grabado.'
      );
    } finally {
      setSavingClip(false);
      setRecordingTargetSegId(null);
      setMicLevel(0);
      setRecElapsed(0);
    }
  }

  async function handleCancelStudioRecording() {
    await recorderRef.current?.cancel();
    recorderRef.current = null;
    setIsRecording(false);
    setRecordingTargetSegId(null);
    setMicLevel(0);
    setRecElapsed(0);
  }

  async function handleUploadExtraFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const fileList = Array.from(e.target.files || []);
    e.target.value = '';
    if (fileList.length === 0) return;

    setSavingClip(true);
    setStudioError(null);
    try {
      const added: StudioClip[] = [];
      for (const file of fileList) {
        const cleaned = await convertBlobToCleanWav(file);
        const uploaded = await uploadAudioBlob(cleaned.wavBlob, `${file.name}.wav`);
        const baseTitle = file.name.replace(/\.[^.]+$/, '');
        added.push({
          id: `clip-${crypto.randomUUID().slice(0, 8)}`,
          title: baseTitle,
          audioUrl: uploaded.url,
          filename: uploaded.filename,
          durationSec: cleaned.durationSec,
          trimStart: 0,
          trimEnd: cleaned.durationSec,
          pauseAfterSec: 0.45,
          gain: 1,
          peaks: cleaned.peaks,
        });
      }
      setClips((prev) => [...prev, ...added]);
    } catch (err) {
      setStudioError(
        err instanceof Error
          ? err.message
          : 'No se pudo importar alguno de los archivos de audio.'
      );
    } finally {
      setSavingClip(false);
    }
  }

  async function ensureStitched(): Promise<StitchedRender> {
    if (stitched) return stitched;
    setIsStitching(true);
    setStudioError(null);
    try {
      const rendered = await renderStitchedAudio(clips, {
        normalize: normalizeVolume,
        fadeMs: smoothFades ? 15 : 0,
        targetSampleRate: 44100,
      });
      setStitched(rendered);
      return rendered;
    } finally {
      setIsStitching(false);
    }
  }

  async function handlePlayOrPauseMaster(seekSec?: number) {
    if (isPlayingMaster && seekSec === undefined) {
      stopMasterPlayback();
      return;
    }

    stopClipPlayback();
    stopMasterPlayback();

    try {
      const [rendered, ctx] = await Promise.all([
        ensureStitched(),
        ensureAudioContextRunning(),
      ]);
      const source = ctx.createBufferSource();
      source.buffer = rendered.audioBuffer;
      source.connect(ctx.destination);

      const startAt =
        seekSec !== undefined
          ? Math.max(0, Math.min(rendered.durationSec - 0.05, seekSec))
          : masterPlayhead >= rendered.durationSec - 0.05
          ? 0
          : masterPlayhead;

      masterStartOffsetRef.current = startAt;
      const startedCtxTime = ctx.currentTime;

      masterSourceRef.current = source;
      setIsPlayingMaster(true);

      source.onended = () => {
        if (masterSourceRef.current === source) {
          stopMasterPlayback();
          setMasterPlayhead(0);
        }
      };

      const tick = () => {
        if (masterSourceRef.current !== source) return;
        const pos = masterStartOffsetRef.current + (ctx.currentTime - startedCtxTime);
        setMasterPlayhead(Math.min(rendered.durationSec, pos));
        if (pos < rendered.durationSec) {
          masterRafRef.current = requestAnimationFrame(tick);
        }
      };
      masterRafRef.current = requestAnimationFrame(tick);

      source.start(0, startAt);
    } catch (err) {
      setStudioError(
        err instanceof Error ? err.message : 'No se pudo generar la vista previa.'
      );
      stopMasterPlayback();
    }
  }

  function triggerDownload(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function handleDownloadWav() {
    try {
      const rendered = await ensureStitched();
      const slug = project.title.toLowerCase().replace(/[^a-z0-9]+/gi, '-');
      triggerDownload(rendered.wavBlob, `${slug || 'audio-unido'}.wav`);
    } catch (err) {
      setStudioError(
        err instanceof Error ? err.message : 'Error al exportar el archivo WAV.'
      );
    }
  }

  async function handleDownloadMp3() {
    setIsExportingMp3(true);
    setStudioError(null);
    try {
      const rendered = await ensureStitched();
      const mp3Blob = encodeAudioBufferToMp3(rendered.audioBuffer, 128);
      const slug = project.title.toLowerCase().replace(/[^a-z0-9]+/gi, '-');
      triggerDownload(mp3Blob, `${slug || 'audio-unido'}.mp3`);
    } catch (err) {
      setStudioError(
        err instanceof Error ? err.message : 'Error al exportar el archivo MP3.'
      );
    } finally {
      setIsExportingMp3(false);
    }
  }

  async function handleEvaluateMaster() {
    setIsEvaluatingMaster(true);
    setStudioError(null);
    try {
      const rendered = await ensureStitched();
      // Build expected text from the script segments represented in the studio
      const expectedParts = clips
        .map((c) => {
          if (!c.sourceSegmentId) return '';
          return project.segments.find((s) => s.id === c.sourceSegmentId)?.text || '';
        })
        .filter(Boolean);

      const expectedText =
        expectedParts.length > 0
          ? expectedParts.join(' ')
          : project.segments.map((s) => s.text).join(' ');

      const wavChunks = await convertToAsrWavChunks(rendered.wavBlob, 110);
      const res = await evaluateAudioApi({
        wavChunks,
        expectedText,
        ignoreParentheses: true,
        saveHistory: true,
      });
      setMasterEvaluation(res);
    } catch (err) {
      setStudioError(
        err instanceof Error ? err.message : 'No se pudo evaluar el audio unido.'
      );
    } finally {
      setIsEvaluatingMaster(false);
    }
  }

  const estimatedTotalSec = useMemo(() => {
    return clips.reduce((acc, c, idx) => {
      const dur = getEffectiveClipDuration(c.trimStart, c.trimEnd, c.cuts);
      const pause = idx < clips.length - 1 ? c.pauseAfterSec : 0;
      return acc + dur + pause;
    }, 0);
  }, [clips]);

  const activeMasterClipTitle = useMemo(() => {
    if (!stitched || !isPlayingMaster) return null;
    const hit = stitched.timelineOffsets.find(
      (t) => masterPlayhead >= t.startSec && masterPlayhead <= t.endSec
    );
    return hit?.title || 'Pausa entre partes...';
  }, [stitched, isPlayingMaster, masterPlayhead]);

  const activeMasterOffsetIdx = useMemo(() => {
    if (!stitched) return -1;
    return stitched.timelineOffsets.findIndex(
      (t) => masterPlayhead >= t.startSec && masterPlayhead <= t.endSec
    );
  }, [stitched, masterPlayhead]);

  return (
    <div className="space-y-6">
      {/* Studio Top Toolbar */}
      <div className="rounded-2xl bg-white border border-slate-200 shadow-xs p-5 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-extrabold text-slate-900 flex items-center gap-2">
              <Sliders className="w-5 h-5 text-indigo-600" />
              Estudio de Grabación y Unión de Audios
            </h2>
            <p className="text-xs sm:text-sm text-slate-500 mt-0.5">
              Recorta silencios, ajusta las pausas entre cada parte, mezcla clips propios y une todo en un solo MP3 o WAV.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setShowTeleprompter((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-xl border px-3.5 py-2 text-xs font-bold transition cursor-pointer ${
                showTeleprompter
                  ? 'bg-indigo-600 border-indigo-600 text-white'
                  : 'bg-indigo-50 border-indigo-200 text-indigo-800 hover:bg-indigo-100'
              }`}
            >
              <BookOpen className="w-3.5 h-3.5" />
              {showTeleprompter ? 'Ocultar guion' : 'Ver guion para leer'}
            </button>

            <button
              onClick={() => syncFromProjectTakes(false)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-100 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Sincronizar guion ({project.segments.length - missingSegments.length}/
              {project.segments.length})
            </button>

            <button
              onClick={() => handleStartStudioRecording(null)}
              disabled={isRecording || savingClip}
              className="inline-flex items-center gap-1.5 rounded-xl bg-rose-600 px-3.5 py-2 text-xs font-bold text-white hover:bg-rose-700 disabled:opacity-50 cursor-pointer"
            >
              <Mic className="w-3.5 h-3.5" />
              Grabar nuevo clip libre
            </button>

            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={savingClip}
              className="inline-flex items-center gap-1.5 rounded-xl bg-slate-100 border border-slate-200 px-3.5 py-2 text-xs font-bold text-slate-800 hover:bg-slate-200 cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              Subir audios (.mp3, .wav...)
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              multiple
              className="hidden"
              onChange={handleUploadExtraFiles}
            />

            <button
              onClick={autoTrimAllClips}
              disabled={trimmingAll || clips.length === 0}
              className="inline-flex items-center gap-1.5 rounded-xl bg-amber-50 border border-amber-200 px-3.5 py-2 text-xs font-bold text-amber-900 hover:bg-amber-100 disabled:opacity-50 cursor-pointer"
            >
              {trimmingAll ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Scissors className="w-3.5 h-3.5" />
              )}
              Auto-recortar silencios en todos
            </button>
          </div>
        </div>

        {/* Studio Teleprompter Card (when toggled on before recording) */}
        {showTeleprompter && !isRecording && (
          <div className="rounded-2xl bg-indigo-50/70 border border-indigo-200 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-extrabold uppercase tracking-wider text-indigo-700 flex items-center gap-1.5">
                  <BookOpen className="w-3.5 h-3.5" />
                  Guion para leer:
                </span>
                <select
                  value={teleprompterSegmentId}
                  onChange={(e) => setTeleprompterSegmentId(e.target.value)}
                  className="rounded-xl border border-indigo-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-800 focus:outline-none max-w-xs sm:max-w-md"
                >
                  {project.segments.map((seg) => (
                    <option key={seg.id} value={seg.id}>
                      Parte {seg.order}: {seg.title}
                    </option>
                  ))}
                  <option value="none">Sin guion (texto libre)</option>
                </select>
              </div>

              {activeTeleprompterSeg && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => handlePlayTeleprompterGuide(activeTeleprompterSeg)}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-white border border-indigo-200 px-3 py-1.5 text-xs font-bold text-indigo-800 hover:bg-indigo-100 cursor-pointer"
                  >
                    {isPlayingGuide ? (
                      <>
                        <Square className="w-3.5 h-3.5 fill-current" /> Detener voz
                      </>
                    ) : (
                      <>
                        <Volume2 className="w-3.5 h-3.5" /> Escuchar frase
                      </>
                    )}
                  </button>
                  <button
                    onClick={() => handleStartStudioRecording(activeTeleprompterSeg.id)}
                    disabled={savingClip}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-rose-600 px-3.5 py-1.5 text-xs font-bold text-white hover:bg-rose-700 disabled:opacity-50 cursor-pointer"
                  >
                    <Mic className="w-3.5 h-3.5" /> Grabar esta parte ahora
                  </button>
                </div>
              )}
            </div>

            {activeTeleprompterSeg ? (
              <div className="rounded-xl bg-white border border-indigo-100 p-3.5 space-y-2">
                {(activeTeleprompterSeg.cueBefore || activeTeleprompterSeg.cueAfter) && (
                  <div className="flex flex-wrap gap-1.5">
                    {activeTeleprompterSeg.cueBefore && (
                      <span className="rounded-lg bg-amber-50 border border-amber-200 px-2 py-0.5 text-[11px] font-bold text-amber-900">
                        🎭 {activeTeleprompterSeg.cueBefore}
                      </span>
                    )}
                    {activeTeleprompterSeg.cueAfter && (
                      <span className="rounded-lg bg-sky-50 border border-sky-200 px-2 py-0.5 text-[11px] font-bold text-sky-900">
                        ⏸️ Al terminar: {activeTeleprompterSeg.cueAfter}
                      </span>
                    )}
                  </div>
                )}
                <p className="text-lg font-extrabold text-slate-900 leading-relaxed">
                  {activeTeleprompterSeg.text}
                </p>
                {activeTeleprompterSeg.phoneticEs && (
                  <p className="text-base sm:text-lg font-bold text-indigo-900 leading-relaxed">
                    <span className="text-xs font-extrabold uppercase tracking-wider text-indigo-600 mr-1.5">
                      Léelo corrido:
                    </span>
                    {activeTeleprompterSeg.phoneticEs}
                  </p>
                )}
                {activeTeleprompterSeg.translationEs && (
                  <p className="text-xs text-slate-600">
                    Significado: {activeTeleprompterSeg.translationEs}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-xs text-indigo-900">
                Modo libre seleccionado. Puedes grabar cualquier frase o elegir una parte arriba para ver el texto.
              </p>
            )}
          </div>
        )}

        {/* Live Studio Recording Bar with Automatic Teleprompter */}
        {isRecording && (
          <div className="rounded-2xl bg-rose-50 border-2 border-rose-300 p-4 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-center gap-3 flex-1">
                <span className="w-3.5 h-3.5 rounded-full bg-rose-600 animate-ping shrink-0" />
                <div className="flex-1">
                  <div className="flex items-center justify-between text-xs font-bold text-rose-800 mb-1">
                    <span>
                      {recordingTargetSegId && activeTeleprompterSeg
                        ? `Grabando ${activeTeleprompterSeg.title}... lee el texto de abajo`
                        : 'Grabando clip para el estudio...'}
                    </span>
                    <span className="font-mono">{formatTime(recElapsed)}</span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-rose-200 overflow-hidden">
                    <div
                      className="h-full bg-rose-600 transition-all duration-75"
                      style={{ width: `${Math.max(8, Math.round(micLevel * 100))}%` }}
                    />
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={handleCancelStudioRecording}
                  className="rounded-xl border border-rose-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleStopStudioRecording}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-rose-600 px-4 py-1.5 text-xs font-bold text-white hover:bg-rose-700 cursor-pointer"
                >
                  <Square className="w-3.5 h-3.5 fill-current" /> Detener y agregar
                </button>
              </div>
            </div>

            {/* Teleprompter box while recording */}
            <div className="rounded-xl bg-white border border-rose-200 p-3.5 space-y-2">
              {!recordingTargetSegId && (
                <div className="flex flex-wrap items-center gap-2 pb-1 border-b border-slate-100">
                  <span className="text-[11px] font-bold text-slate-500">
                    Texto de referencia:
                  </span>
                  <select
                    value={teleprompterSegmentId}
                    onChange={(e) => setTeleprompterSegmentId(e.target.value)}
                    className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-bold text-slate-800 focus:outline-none"
                  >
                    {project.segments.map((seg) => (
                      <option key={seg.id} value={seg.id}>
                        Parte {seg.order}: {seg.title}
                      </option>
                    ))}
                    <option value="none">Sin guion / texto libre</option>
                  </select>
                </div>
              )}

              {activeTeleprompterSeg ? (
                <div className="space-y-1.5">
                  {(activeTeleprompterSeg.cueBefore || activeTeleprompterSeg.cueAfter) && (
                    <div className="flex flex-wrap gap-1.5">
                      {activeTeleprompterSeg.cueBefore && (
                        <span className="rounded-lg bg-amber-50 border border-amber-200 px-2 py-0.5 text-[11px] font-bold text-amber-900">
                          🎭 {activeTeleprompterSeg.cueBefore}
                        </span>
                      )}
                      {activeTeleprompterSeg.cueAfter && (
                        <span className="rounded-lg bg-sky-50 border border-sky-200 px-2 py-0.5 text-[11px] font-bold text-sky-900">
                          ⏸️ Al terminar: {activeTeleprompterSeg.cueAfter}
                        </span>
                      )}
                    </div>
                  )}
                  <p className="text-lg sm:text-xl font-extrabold text-slate-900 leading-relaxed">
                    {activeTeleprompterSeg.text}
                  </p>
                  {activeTeleprompterSeg.phoneticEs && (
                    <p className="text-base sm:text-lg font-bold text-indigo-900 leading-relaxed">
                      <span className="text-xs font-extrabold uppercase tracking-wider text-indigo-600 mr-1.5">
                        Léelo corrido:
                      </span>
                      {activeTeleprompterSeg.phoneticEs}
                    </p>
                  )}
                  {activeTeleprompterSeg.translationEs && (
                    <p className="text-xs text-slate-500">
                      Significado: {activeTeleprompterSeg.translationEs}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-slate-500">
                  Grabación libre (sin texto guía). Habla con claridad y pulsa «Detener y agregar» al terminar.
                </p>
              )}
            </div>
          </div>
        )}

        {/* Missing segments helper — show ALL missing segments */}
        {missingSegments.length > 0 && (
          <div className="rounded-xl bg-amber-50/75 border border-amber-200 p-3.5 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-bold text-amber-900">
                Faltan {missingSegments.length} partes del guion "{project.title}" por grabar o elegir toma:
              </span>
              <button
                onClick={onGoToPractice}
                className="text-xs font-bold text-indigo-700 hover:underline cursor-pointer"
              >
                Ir a Practicar por Partes →
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {missingSegments.map((seg) => (
                <button
                  key={seg.id}
                  onClick={() => handleStartStudioRecording(seg.id)}
                  disabled={isRecording || savingClip}
                  className="inline-flex items-center gap-1 rounded-lg bg-white border border-amber-300 px-2.5 py-1 text-[11px] font-bold text-amber-900 hover:bg-amber-100 cursor-pointer"
                  title={seg.text}
                >
                  <Mic className="w-3 h-3 text-rose-500" />
                  Grabar Parte {seg.order}
                </button>
              ))}
            </div>
          </div>
        )}

        {studioError && (
          <div className="rounded-xl bg-rose-50 border border-rose-200 px-4 py-2.5 text-xs text-rose-800 flex flex-wrap items-center justify-between gap-2">
            <span>{studioError}</span>
            {!hasApiKey && onOpenSettings && (
              <button
                type="button"
                onClick={onOpenSettings}
                className="rounded-lg bg-rose-600 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-rose-700 cursor-pointer shrink-0"
              >
                Configurar API Key
              </button>
            )}
          </div>
        )}
      </div>

      {/* MASTER MIX & EXPORT DOCK */}
      <div className="rounded-2xl bg-gradient-to-br from-indigo-950 via-slate-900 to-slate-900 text-white shadow-lg p-5 sm:p-6 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-indigo-500/25 border border-indigo-400/30 px-2.5 py-0.5 text-[11px] font-bold text-indigo-200">
                Mezcla Final ({clips.length} clips)
              </span>
              <span className="text-xs font-mono text-slate-300">
                Duración total aprox: {formatTime(estimatedTotalSec)}
              </span>
            </div>
            <h3 className="text-lg font-extrabold mt-1">
              {activeMasterClipTitle
                ? `Sonando: ${activeMasterClipTitle}`
                : 'Audio completo listo para previsualizar y descargar'}
            </h3>
          </div>

          <div className="flex flex-wrap items-center gap-4 text-xs">
            <label className="inline-flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={normalizeVolume}
                onChange={(e) => setNormalizeVolume(e.target.checked)}
                className="rounded text-indigo-500"
              />
              <span>Normalizar volumen</span>
            </label>
            <label className="inline-flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={smoothFades}
                onChange={(e) => setSmoothFades(e.target.checked)}
                className="rounded text-indigo-500"
              />
              <span>Transición suave anti-clics</span>
            </label>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
        {/* Master waveform if rendered */}
        {stitched && (
          <div className="space-y-1.5">
            <WaveformCanvas
              peaks={stitched.peaks}
              durationSec={stitched.durationSec}
              playheadSec={masterPlayhead}
              height={54}
              onSeek={(sec) => handlePlayOrPauseMaster(sec)}
            />
            <div className="flex justify-between text-[11px] font-mono text-slate-300">
              <span>{formatTime(masterPlayhead)}</span>
              <span>{formatTime(stitched.durationSec)}</span>
            </div>
          </div>
        )}

        {/* Master Buttons */}
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            onClick={() => handlePlayOrPauseMaster()}
            disabled={clips.length === 0 || isStitching}
            className="inline-flex items-center gap-2 rounded-xl bg-white text-slate-900 px-4 py-2.5 text-sm font-extrabold hover:bg-indigo-50 disabled:opacity-50 cursor-pointer"
          >
            {isStitching ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" /> Procesando...
              </>
            ) : isPlayingMaster ? (
              <>
                <Pause className="w-4 h-4" /> Pausar mezcla
              </>
            ) : (
              <>
                <Play className="w-4 h-4" /> Escuchar todo unido
              </>
            )}
          </button>

          <button
            onClick={handleDownloadMp3}
            disabled={clips.length === 0 || isStitching || isExportingMp3}
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 text-white px-4 py-2.5 text-sm font-extrabold hover:bg-emerald-600 disabled:opacity-50 cursor-pointer"
          >
            {isExportingMp3 ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" /> Creando MP3...
              </>
            ) : (
              <>
                <Download className="w-4 h-4" /> Unir y Descargar MP3
              </>
            )}
          </button>

          <button
            onClick={handleDownloadWav}
            disabled={clips.length === 0 || isStitching}
            className="inline-flex items-center gap-2 rounded-xl bg-slate-800 border border-slate-700 text-white px-4 py-2.5 text-sm font-bold hover:bg-slate-700 disabled:opacity-50 cursor-pointer"
          >
            <FileAudio className="w-4 h-4" /> Descargar WAV
          </button>

          <button
            onClick={handleEvaluateMaster}
            disabled={clips.length === 0 || isEvaluatingMaster}
            className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 text-white px-4 py-2.5 text-sm font-bold hover:bg-indigo-500 disabled:opacity-50 cursor-pointer ml-auto"
          >
            {isEvaluatingMaster ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" /> Evaluando historia completa...
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" /> Evaluar audio unido con IA
              </>
            )}
          </button>
        </div>
        </div>
        {stitched && (
          <div className="lg:col-span-1 rounded-xl bg-white/5 border border-white/10 p-3 space-y-2 max-h-72 overflow-y-auto">
            <div className="text-[11px] font-bold uppercase tracking-wider text-indigo-200">
              Texto sincronizado
            </div>
            {stitched.timelineOffsets.map((off, idx) => {
              const clip = clips.find((c) => c.id === off.clipId);
              const active = idx === activeMasterOffsetIdx;
              return (
                <button
                  key={off.clipId}
                  onClick={() => handlePlayOrPauseMaster(off.startSec)}
                  className={`block w-full text-left rounded-lg px-2.5 py-1.5 text-xs transition cursor-pointer ${
                    active ? 'bg-indigo-500/30 text-white' : 'text-slate-300 hover:bg-white/5'
                  }`}
                >
                  <span className="font-bold">{off.title}</span>
                  {clip?.speaker ? (
                    <span className="ml-1 text-indigo-300">· {clip.speaker}</span>
                  ) : null}
                  <span className="block mt-0.5 opacity-90 leading-snug">{clip?.text || ''}</span>
                </button>
              );
            })}
          </div>
        )}
        </div>
      </div>

      {masterEvaluation && (
        <EvaluationCard result={masterEvaluation} voiceId={voiceId} />
      )}

      {/* TIMELINE CLIPS LIST */}
      {clips.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-slate-300 bg-white p-10 text-center space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center mx-auto">
            <FileAudio className="w-6 h-6" />
          </div>
          <h3 className="text-base font-extrabold text-slate-900">
            Tu mesa de estudio está vacía todavía
          </h3>
          <p className="text-sm text-slate-500 max-w-md mx-auto">
            Graba partes en la pestaña "Practicar por Partes", graba un clip libre arriba o sube varios audios desde tu computadora para unirlos aquí.
          </p>
          <div className="flex flex-wrap justify-center gap-2 pt-2">
            <button
              onClick={onGoToPractice}
              className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-700 cursor-pointer"
            >
              Ir a Practicar por Partes
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50 cursor-pointer"
            >
              Subir archivos de audio
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {clips.map((clip, idx) => {
            const isPlayingThis = playingClipId === clip.id;
            const trimmedDur = getEffectiveClipDuration(
              clip.trimStart,
              clip.trimEnd,
              clip.cuts
            );
            const selection = selectionByClip[clip.id] || null;
            const clipCuts = clip.cuts || [];

            return (
              <React.Fragment key={clip.id}>
                <div
                  onDragOver={(e) => {
                    if (dragIndex !== null) e.preventDefault();
                  }}
                  onDrop={() => {
                    if (dragIndex !== null && dragIndex !== idx) {
                      setClips((prev) => {
                        const next = [...prev];
                        const [moved] = next.splice(dragIndex, 1);
                        next.splice(idx, 0, moved);
                        return next;
                      });
                    }
                    setDragIndex(null);
                  }}
                  className="rounded-2xl bg-white border border-slate-200 shadow-xs p-4 space-y-3 hover:border-indigo-200 transition"
                >
                  {/* Clip header */}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 flex-1 min-w-[200px]">
                      <button
                        type="button"
                        draggable
                        onDragStart={() => setDragIndex(idx)}
                        onDragEnd={() => setDragIndex(null)}
                        title="Arrastra desde aquí para cambiar el orden del clip"
                        className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 cursor-grab active:cursor-grabbing shrink-0"
                      >
                        <GripVertical className="w-4 h-4" />
                      </button>

                      <span className="w-7 h-7 rounded-lg bg-slate-100 text-slate-700 text-xs font-extrabold flex items-center justify-center shrink-0">
                        {idx + 1}
                      </span>

                      <button
                        onClick={() => handlePlaySingleClip(clip)}
                        className="w-8 h-8 rounded-full bg-indigo-600 text-white flex items-center justify-center hover:bg-indigo-700 cursor-pointer shrink-0"
                        title="Escuchar este clip recortado"
                      >
                        {isPlayingThis ? (
                          <Pause className="w-3.5 h-3.5" />
                        ) : (
                          <Play className="w-3.5 h-3.5 ml-0.5" />
                        )}
                      </button>

                      <input
                        type="text"
                        value={clip.title}
                        onChange={(e) => updateClip(clip.id, { title: e.target.value })}
                        className="flex-1 min-w-0 rounded-lg border border-transparent hover:border-slate-200 focus:border-indigo-400 focus:bg-slate-50 px-2 py-1 text-sm font-bold text-slate-900 focus:outline-none"
                      />

                      <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-xs font-mono font-semibold text-slate-700 shrink-0">
                        {formatTimePrecise(trimmedDur)}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-1">
                      <button
                        onClick={() => autoTrimClip(clip)}
                        className="inline-flex items-center gap-1 rounded-lg bg-amber-50 border border-amber-200 px-2.5 py-1 text-xs font-bold text-amber-900 hover:bg-amber-100 cursor-pointer"
                        title="Recortar silencios de bordes y pausas largas en el medio"
                      >
                        <Zap className="w-3.5 h-3.5 text-amber-600" />
                        Quitar silencios
                      </button>
                      <button
                        onClick={() => handleSplitClip(clip, idx)}
                        disabled={clip.trimEnd - clip.trimStart < 0.6}
                        className="inline-flex items-center gap-1 rounded-lg bg-indigo-50 border border-indigo-200 px-2.5 py-1 text-xs font-bold text-indigo-800 hover:bg-indigo-100 disabled:opacity-40 cursor-pointer"
                        title="Dividir este clip en 2 partes donde está la guía (o en la mitad)"
                      >
                        <Scissors className="w-3.5 h-3.5" />
                        Dividir
                      </button>
                      <button
                        onClick={() =>
                          updateClip(clip.id, {
                            trimStart: 0,
                            trimEnd: clip.durationSec,
                            cuts: [],
                          })
                        }
                        className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 cursor-pointer"
                        title="Restaurar recorte y cortes originales"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => moveClip(idx, -1)}
                        disabled={idx === 0}
                        className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-30 cursor-pointer"
                        title="Subir"
                      >
                        <ArrowUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => moveClip(idx, 1)}
                        disabled={idx === clips.length - 1}
                        className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-30 cursor-pointer"
                        title="Bajar"
                      >
                        <ArrowDown className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => duplicateClip(idx)}
                        className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 cursor-pointer"
                        title="Duplicar clip"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => removeClip(clip)}
                        className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 cursor-pointer"
                        title="Eliminar grabación definitivamente"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Waveform instruction */}
                  <div className="text-[11px] text-slate-500">
                    Arrastra las barras naranjas para recortar bordes, haz clic para escuchar desde un punto, o arrastra sobre la onda para seleccionar y cortar silencios intermedios.
                  </div>

                  {/* Interactive Waveform */}
                  <WaveformCanvas
                    peaks={clip.peaks}
                    durationSec={clip.durationSec}
                    trimStart={clip.trimStart}
                    trimEnd={clip.trimEnd}
                    cuts={clipCuts}
                    selectedRange={selection}
                    playheadSec={isPlayingThis ? clipPlayhead : null}
                    onSeek={(sec) => {
                      setLastCursorByClip((prev) => ({ ...prev, [clip.id]: sec }));
                      handlePlaySingleClip(clip, sec);
                    }}
                    onTrimStartChange={(sec) =>
                      updateClip(clip.id, {
                        trimStart: sec,
                        cuts: mergeCutRanges(clipCuts, sec, clip.trimEnd),
                      })
                    }
                    onTrimEndChange={(sec) =>
                      updateClip(clip.id, {
                        trimEnd: sec,
                        cuts: mergeCutRanges(clipCuts, clip.trimStart, sec),
                      })
                    }
                    onSelectRange={(range) =>
                      setSelectionByClip((prev) => ({ ...prev, [clip.id]: range }))
                    }
                    showTimeLabels
                    height={56}
                  />

                  {/* Selection toolbar when user drags across a middle zone */}
                  {selection && selection.end - selection.start >= 0.08 && (
                    <div className="rounded-xl bg-rose-50 border border-rose-200 px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="font-bold text-rose-900">
                        Selección: {formatTimePrecise(selection.start)} →{' '}
                        {formatTimePrecise(selection.end)} (
                        {formatTimePrecise(selection.end - selection.start)})
                      </span>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handlePlaySingleClip(clip, undefined, selection)}
                          className="inline-flex items-center gap-1 rounded-lg bg-white border border-rose-200 px-2.5 py-1 font-bold text-rose-900 hover:bg-rose-100 cursor-pointer"
                        >
                          <Play className="w-3 h-3 fill-current" />
                          Oír selección
                        </button>
                        <button
                          type="button"
                          onClick={() => handleCutSelectedRange(clip)}
                          className="inline-flex items-center gap-1 rounded-lg bg-rose-600 px-3 py-1 font-bold text-white hover:bg-rose-700 cursor-pointer"
                        >
                          <Scissors className="w-3 h-3" />
                          Cortar y quitar esta parte
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setSelectionByClip((prev) => ({ ...prev, [clip.id]: null }))
                          }
                          className="rounded-lg p-1 text-rose-700 hover:bg-rose-100 cursor-pointer"
                          title="Cancelar selección"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Internal cut chips */}
                  {clipCuts.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                      <span className="font-bold text-slate-500">
                        Partes eliminadas en medio:
                      </span>
                      {clipCuts.map((c, cIdx) => (
                        <span
                          key={`${c.start}-${c.end}-${cIdx}`}
                          className="inline-flex items-center gap-1 rounded-full bg-rose-50 border border-rose-200 px-2 py-0.5 font-mono font-semibold text-rose-800"
                        >
                          ✂️ {formatTimePrecise(c.start)}–{formatTimePrecise(c.end)}
                          <button
                            type="button"
                            onClick={() => handleRemoveSingleCut(clip, cIdx)}
                            className="hover:text-rose-950 cursor-pointer"
                            title="Deshacer este corte"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      ))}
                      <button
                        type="button"
                        onClick={() => updateClip(clip.id, { cuts: [] })}
                        className="text-[11px] font-bold text-indigo-600 hover:underline ml-1 cursor-pointer"
                      >
                        Deshacer todos los cortes
                      </button>
                    </div>
                  )}

                  {/* Fine Trim & Gain sliders */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs pt-1">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-slate-500 font-semibold">
                        <span>Inicio del recorte</span>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() =>
                              updateClip(clip.id, {
                                trimStart: Number(Math.max(0, clip.trimStart - 0.05).toFixed(2)),
                              })
                            }
                            className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold hover:bg-slate-200 cursor-pointer"
                          >
                            -0.05
                          </button>
                          <span className="font-mono text-slate-700">
                            {formatTimePrecise(clip.trimStart)}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              updateClip(clip.id, {
                                trimStart: Number(
                                  Math.min(clip.trimEnd - 0.15, clip.trimStart + 0.05).toFixed(2)
                                ),
                              })
                            }
                            className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold hover:bg-slate-200 cursor-pointer"
                          >
                            +0.05
                          </button>
                        </div>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={Math.max(0.05, clip.trimEnd - 0.15)}
                        step={0.01}
                        value={clip.trimStart}
                        onChange={(e) =>
                          updateClip(clip.id, { trimStart: Number(e.target.value) })
                        }
                        className="w-full accent-amber-500 cursor-pointer"
                      />
                    </div>

                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-slate-500 font-semibold">
                        <span>Fin del recorte</span>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() =>
                              updateClip(clip.id, {
                                trimEnd: Number(
                                  Math.max(clip.trimStart + 0.15, clip.trimEnd - 0.05).toFixed(2)
                                ),
                              })
                            }
                            className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold hover:bg-slate-200 cursor-pointer"
                          >
                            -0.05
                          </button>
                          <span className="font-mono text-slate-700">
                            {formatTimePrecise(clip.trimEnd)}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              updateClip(clip.id, {
                                trimEnd: Number(
                                  Math.min(clip.durationSec, clip.trimEnd + 0.05).toFixed(2)
                                ),
                              })
                            }
                            className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold hover:bg-slate-200 cursor-pointer"
                          >
                            +0.05
                          </button>
                        </div>
                      </div>
                      <input
                        type="range"
                        min={Math.min(clip.durationSec, clip.trimStart + 0.15)}
                        max={clip.durationSec}
                        step={0.01}
                        value={clip.trimEnd}
                        onChange={(e) =>
                          updateClip(clip.id, { trimEnd: Number(e.target.value) })
                        }
                        className="w-full accent-amber-500 cursor-pointer"
                      />
                    </div>

                    <div className="space-y-1">
                      <div className="flex justify-between text-slate-500 font-semibold">
                        <span className="flex items-center gap-1">
                          <Volume2 className="w-3.5 h-3.5" /> Volumen
                        </span>
                        <span className="font-mono text-slate-700">
                          {Math.round(clip.gain * 100)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0.5}
                        max={2.0}
                        step={0.05}
                        value={clip.gain}
                        onChange={(e) =>
                          updateClip(clip.id, { gain: Number(e.target.value) })
                        }
                        className="w-full accent-indigo-600 cursor-pointer"
                      />
                    </div>
                  </div>
                </div>

                {/* Pause connector between clips */}
                {idx < clips.length - 1 && (
                  <div className="flex items-center justify-center py-0.5">
                    <div className="inline-flex flex-wrap items-center gap-3 rounded-full bg-slate-100 border border-slate-200 px-4 py-1.5 text-xs">
                      <span className="font-bold text-slate-600">
                        ⏸️ Pausa después de esta parte:
                      </span>
                      {clip.cueAfter && (
                        <span className="rounded-full bg-sky-100 text-sky-800 px-2 py-0.5 font-bold">
                          {clip.cueAfter}
                        </span>
                      )}
                      <input
                        type="range"
                        min={0}
                        max={3}
                        step={0.05}
                        value={clip.pauseAfterSec}
                        onChange={(e) =>
                          updateClip(clip.id, { pauseAfterSec: Number(e.target.value) })
                        }
                        className="w-24 accent-indigo-600"
                      />
                      <span className="font-mono font-bold text-indigo-700 w-10 text-right">
                        {clip.pauseAfterSec.toFixed(1)}s
                      </span>
                    </div>
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      )}

      {clips.length > 0 && missingSegments.length === 0 && (
        <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-3 flex items-center gap-2 text-xs font-bold text-emerald-900">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          ¡Todas las {project.segments.length} partes de "{project.title}" están incluidas en el estudio!
        </div>
      )}
    </div>
  );
};
