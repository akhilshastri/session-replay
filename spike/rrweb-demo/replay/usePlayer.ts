/**
 * React hook wrapping rrweb's Replayer: lifecycle, play/pause/seek/speed, current-time polling and
 * scale-to-fit. Used by ./main.tsx. Replayer builds its own sandboxed iframe inside `rootRef`.
 */
import { Replayer } from '@rrweb/replay';
import '@rrweb/replay/dist/style.css';
import type { eventWithTime } from '@rrweb/types';
import { useCallback, useEffect, useRef, useState } from 'react';

export const SPEEDS = [0.5, 1, 1.5, 2, 4, 5];

export const usePlayer = (events: eventWithTime[] | null) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const replayer = useRef<Replayer | null>(null);
  const size = useRef({ width: 1024, height: 768 });
  const [current, setCurrent] = useState(0);
  const [total, setTotal] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [finished, setFinished] = useState(false);
  const [speed, setSpeedState] = useState(1);
  const speedRef = useRef(1);

  const fit = useCallback(() => {
    const r = replayer.current;
    const root = rootRef.current;
    if (!r || !root) return;
    const { width, height } = size.current;
    const scale = Math.min(root.clientWidth / width, root.clientHeight / height, 1);
    r.wrapper.style.transformOrigin = 'top left';
    r.wrapper.style.transform = `scale(${scale})`;
    root.style.setProperty('--fit-h', `${height * scale}px`);
  }, []);

  // Create/destroy the Replayer when the session changes.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !events || events.length < 2) return;
    root.innerHTML = '';
    const r = new Replayer(events, { root, speed: speedRef.current });
    replayer.current = r;
    setTotal(r.getMetaData().totalTime);
    // The recorder boots before React, so the first FullSnapshot is an empty #root; the first frame with
    // content is the first Mutation (IncrementalSnapshot, source 0) after it. Fall back to the snapshot.
    const snapIdx = events.findIndex((e) => e.type === 2); // EventType.FullSnapshot
    const mutation = snapIdx < 0 ? undefined : events.slice(snapIdx + 1).find((e) => e.type === 3 && (e.data as { source: number }).source === 0);
    const first = mutation ?? events[snapIdx];
    // +1 ms: Replayer applies only events with timestamp strictly < the pause offset, so pausing at the
    // mutation's own time would leave it out.
    const firstFrame = first ? first.timestamp - r.getMetaData().startTime + 1 : 0;
    setCurrent(firstFrame);
    setPlaying(false);
    setFinished(false);
    // 'resize' fires with the recorded viewport size (from Meta events) whenever it changes.
    r.on('resize', (dim: unknown) => {
      size.current = dim as { width: number; height: number };
      fit();
    });
    r.on('finish', () => {
      setPlaying(false);
      setFinished(true);
    });
    r.pause(firstFrame); // render the first frame without playing
    const ro = new ResizeObserver(fit);
    ro.observe(root);
    return () => {
      ro.disconnect();
      r.destroy();
      replayer.current = null;
      root.innerHTML = '';
    };
  }, [events, fit]);

  // Poll the clock while playing.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      if (replayer.current) setCurrent(replayer.current.getCurrentTime());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const seek = useCallback(
    (ms: number, keepPlaying = playing) => {
      const r = replayer.current;
      if (!r) return;
      const t = Math.min(Math.max(0, ms), total);
      if (keepPlaying) r.play(t);
      else r.pause(t);
      setPlaying(keepPlaying);
      setFinished(false);
      setCurrent(t);
    },
    [playing, total],
  );

  const toggle = useCallback(() => {
    const r = replayer.current;
    if (!r) return;
    if (playing) {
      r.pause();
      setCurrent(r.getCurrentTime());
      setPlaying(false);
    } else seek(finished || current >= total ? 0 : current, true);
  }, [playing, finished, current, total, seek]);

  const setSpeed = useCallback((s: number) => {
    speedRef.current = s;
    replayer.current?.setConfig({ speed: s });
    setSpeedState(s);
  }, []);

  return { rootRef, current, total, playing, speed, seek, toggle, setSpeed };
};
