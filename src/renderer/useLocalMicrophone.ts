import { useCallback, useEffect, useRef, useState } from 'react';

export type MicrophoneStatus = 'off' | 'loading' | 'ready' | 'recording' | 'transcribing' | 'error';

export function useLocalMicrophone(onText: (text: string) => void, onInterrupt: () => void) {
  const [status, setStatus] = useState<MicrophoneStatus>('off');
  const [error, setError] = useState<string | null>(null);
  const worker = useRef<Worker | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const opening = useRef(false);
  const current = useRef({ onText, onInterrupt });
  current.current = { onText, onInterrupt };

  // Invalidate async permission, decode and model work before releasing resources.
  const release = useCallback(() => {
    generation.current++;
    opening.current = false;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    worker.current?.terminate();
    worker.current = null;
    const recording = recorder.current;
    recorder.current = null;
    if (recording?.state === 'recording') recording.stop();
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  }, []);
  const disable = useCallback(() => {
    release();
    setStatus('off');
    setError(null);
  }, [release]);
  const enable = useCallback(async () => {
    if (worker.current) return;
    setStatus('loading');
    setError(null);
    let w: Worker;
    try {
      w = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      release();
      setError('Local speech could not start. You can still type to your companion.');
      setStatus('error');
      return;
    }
    worker.current = w;
    w.onmessage = (event) => {
      if (worker.current !== w) return;
      const result = event.data;
      if (result.type === 'ready') setStatus('ready');
      if (result.type === 'result') {
        setStatus('ready');
        if (result.text?.trim()) current.current.onText(result.text.trim());
      }
      if (result.type === 'error') {
        release();
        setError(result.message);
        setStatus('error');
      }
    };
    w.onerror = () => {
      if (worker.current !== w) return;
      release();
      setError('Local speech could not load. You can still type to your companion.');
      setStatus('error');
    };
    w.postMessage({ type: 'load' });
  }, [release]);
  const stop = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (recorder.current?.state === 'recording') recorder.current.stop();
  }, []);
  const start = useCallback(async () => {
    if (status !== 'ready' || !worker.current || opening.current || recorder.current) return;
    const activeGeneration = generation.current;
    opening.current = true;
    setError(null);
    try {
      current.current.onInterrupt();
      const capture = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      if (generation.current !== activeGeneration || !worker.current) {
        capture.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = capture;
      const recording = new MediaRecorder(capture);
      recorder.current = recording;
      const parts: Blob[] = [];
      recording.ondataavailable = (event) => {
        if (event.data.size) parts.push(event.data);
      };
      recording.onstop = async () => {
        capture.getTracks().forEach((track) => track.stop());
        if (stream.current === capture) stream.current = null;
        if (recorder.current === recording) recorder.current = null;
        if (generation.current !== activeGeneration || !worker.current) return;
        setStatus('transcribing');
        try {
          const context = new AudioContext();
          let decoded: AudioBuffer;
          try {
            decoded = await context.decodeAudioData(
              await new Blob(parts, { type: recording.mimeType }).arrayBuffer(),
            );
          } finally {
            await context.close();
          }
          if (generation.current !== activeGeneration || !worker.current) return;
          const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
          const source = offline.createBufferSource();
          source.buffer = decoded;
          source.connect(offline.destination);
          source.start();
          const resampled = await offline.startRendering();
          if (generation.current !== activeGeneration || !worker.current) return;
          const audio = resampled.getChannelData(0);
          worker.current.postMessage({ type: 'transcribe', audio }, [audio.buffer]);
        } catch {
          if (generation.current !== activeGeneration) return;
          setError('Could not read the microphone recording. Please try again.');
          setStatus('ready');
        }
      };
      recording.start();
      setStatus('recording');
      timer.current = setTimeout(() => {
        void stop();
      }, 30000);
    } catch {
      if (generation.current !== activeGeneration) return;
      stream.current?.getTracks().forEach((track) => track.stop());
      stream.current = null;
      recorder.current = null;
      setError(
        'Microphone access was not granted. Enable it in macOS Privacy settings, or type instead.',
      );
      setStatus('ready');
    } finally {
      if (generation.current === activeGeneration) opening.current = false;
    }
  }, [status, stop]);
  useEffect(() => release, [release]);
  return { status, error, enable, start, stop, disable };
}
