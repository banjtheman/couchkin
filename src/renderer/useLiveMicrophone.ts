import { useEffect, useRef, useState } from 'react';
import { pcmBytesToBase64 } from './liveAudio';

export type LiveMicrophoneStatus = 'off' | 'requesting' | 'listening' | 'error';
export interface LiveMicrophoneOptions {
  enabled: boolean;
  deviceId?: string;
  onChunk: (pcmBase64: string) => void;
  onError?: (message: string) => void;
}

/** Capture begins only while enabled. No recordings, transcript model, or persistent audio. */
export function useLiveMicrophone({ enabled, deviceId, onChunk, onError }: LiveMicrophoneOptions) {
  const [status, setStatus] = useState<LiveMicrophoneStatus>('off');
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [deviceLabel, setDeviceLabel] = useState<string | null>(null);
  const [defaultDeviceRevision, setDefaultDeviceRevision] = useState(0);
  const selectedDeviceId = deviceId && deviceId !== 'default' ? deviceId : undefined;
  const callbacks = useRef({ onChunk, onError });
  callbacks.current = { onChunk, onError };

  useEffect(() => {
    if (!enabled) {
      setStatus('off');
      setError(null);
      setLevel(0);
      setDeviceLabel(null);
      return;
    }
    let cancelled = false;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let node: AudioWorkletNode | null = null;
    let lastLevelUpdate = 0;
    let started = false;
    let startupStage: 'permission' | 'worklet' | 'resume' | 'capture' = 'permission';
    let startupTimer: ReturnType<typeof setTimeout> | null = null;
    let deviceChangeTimer: ReturnType<typeof setTimeout> | null = null;
    let defaultDeviceKey: string | null = null;
    let deviceCheck = 0;
    const mediaDevices = navigator.mediaDevices;
    const onDeviceChange = () => {
      if (deviceChangeTimer) clearTimeout(deviceChangeTimer);
      deviceChangeTimer = setTimeout(() => {
        deviceChangeTimer = null;
        void checkDefaultDevice();
      }, 150);
    };
    const release = () => {
      if (startupTimer) clearTimeout(startupTimer);
      startupTimer = null;
      if (deviceChangeTimer) clearTimeout(deviceChangeTimer);
      deviceChangeTimer = null;
      mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
      if (node) {
        node.port.onmessage = null;
        node.onprocessorerror = null;
        node.port.postMessage('stop');
        node.port.close();
        node.disconnect();
        node = null;
      }
      source?.disconnect();
      source = null;
      for (const track of stream?.getTracks() ?? []) {
        track.onended = null;
        track.stop();
      }
      stream = null;
      if (context && context.state !== 'closed') void context.close().catch(() => {});
      context = null;
    };
    const fail = (message: string) => {
      if (cancelled) return;
      cancelled = true;
      release();
      setLevel(0);
      setDeviceLabel(null);
      setError(message);
      setStatus('error');
      callbacks.current.onError?.(message);
    };
    const checkDefaultDevice = async () => {
      const check = ++deviceCheck;
      try {
        const devices = await mediaDevices.enumerateDevices();
        if (cancelled || check !== deviceCheck) return;
        // The default input is listed first. Compare only it: a camera or speaker change
        // must not interrupt capture. Establish the baseline after microphone permission.
        const input = devices.find((device) => device.kind === 'audioinput');
        const key = input ? JSON.stringify([input.deviceId, input.groupId, input.label]) : 'none';
        if (defaultDeviceKey !== null && key !== defaultDeviceKey) {
          cancelled = true;
          release();
          setLevel(0);
          setDeviceLabel(null);
          setStatus('requesting');
          setDefaultDeviceRevision((revision) => revision + 1);
        }
        defaultDeviceKey = key;
      } catch {
        // Device enumeration is optional; keep an already-working capture if it fails.
      }
    };
    setStatus('requesting');
    setError(null);
    setLevel(0);
    setDeviceLabel(null);
    startupTimer = setTimeout(() => {
      const messages = {
        permission:
          'Microphone access did not finish opening. Check the macOS microphone permission prompt or Privacy & Security settings, then try again.',
        worklet:
          'The microphone opened, but its audio processor did not load. Restart Couchkin and try again.',
        resume:
          'The microphone opened, but the audio device did not start. Check your Mac’s audio input and try again.',
        capture:
          'The microphone opened, but no audio frames arrived. Check your input device connection and try again.',
      };
      fail(messages[startupStage]);
    }, 20_000);
    void (async () => {
      try {
        const permission = await window.couchkin?.prepareMicrophone();
        if (cancelled) return;
        if (permission && !permission.allowed) {
          fail(
            `Microphone access is ${permission.status}. Allow Couchkin in macOS Privacy & Security → Microphone, restart Couchkin, and try again.`,
          );
          return;
        }
        const capture = await mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            ...(selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : {}),
          },
          video: false,
        });
        if (cancelled) {
          capture.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = capture;
        setDeviceLabel(capture.getAudioTracks()[0]?.label || null);
        if (
          !selectedDeviceId &&
          typeof mediaDevices.enumerateDevices === 'function' &&
          typeof mediaDevices.addEventListener === 'function'
        ) {
          mediaDevices.addEventListener('devicechange', onDeviceChange);
          void checkDefaultDevice();
        }
        const audio = new AudioContext({ latencyHint: 'interactive' });
        context = audio;
        startupStage = 'worklet';
        const workletUrl = new URL('./live-microphone-worklet.js', window.location.href);
        await audio.audioWorklet.addModule(workletUrl.href);
        if (cancelled) return;
        source = audio.createMediaStreamSource(capture);
        node = new AudioWorkletNode(audio, 'couchkin-live-microphone', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 1,
          channelCountMode: 'explicit',
        });
        node.onprocessorerror = () =>
          fail('The live microphone stopped. Disable and enable it to reconnect.');
        node.port.onmessage = (
          event: MessageEvent<{ pcm: ArrayBuffer; level: number; at: number }>,
        ) => {
          if (cancelled) return;
          const { pcm, level: volume, at } = event.data;
          if (!(pcm instanceof ArrayBuffer) || pcm.byteLength !== 1920 || !Number.isFinite(at))
            return;
          // Do not burst stale microphone audio after a stalled renderer.
          if (audio.currentTime - at > 0.75) {
            fail('The microphone fell behind. Disable and enable it to resume live audio.');
            return;
          }
          if (!started) {
            started = true;
            if (startupTimer) clearTimeout(startupTimer);
            startupTimer = null;
            setStatus('listening');
          }
          callbacks.current.onChunk(pcmBytesToBase64(new Uint8Array(pcm)));
          if (performance.now() - lastLevelUpdate > 100) {
            lastLevelUpdate = performance.now();
            setLevel(Math.min(1, Math.max(0, volume)));
          }
        };
        for (const track of capture.getAudioTracks())
          track.onended = () =>
            fail('Your microphone disconnected. Reconnect it, then enable live audio.');
        source.connect(node);
        node.connect(audio.destination);
        startupStage = 'resume';
        await audio.resume();
        if (!cancelled) startupStage = 'capture';
      } catch (cause) {
        const denied =
          cause instanceof DOMException &&
          ['NotAllowedError', 'SecurityError'].includes(cause.name);
        const missing =
          cause instanceof DOMException &&
          ['NotFoundError', 'OverconstrainedError'].includes(cause.name);
        fail(
          denied
            ? 'Allow Couchkin microphone access in macOS Privacy settings, then enable it again.'
            : missing
              ? selectedDeviceId
                ? 'The selected microphone is unavailable. Reconnect it or choose another input, then enable your mic again.'
                : 'No microphone is available. Connect an input device, then enable your mic again.'
              : startupStage === 'worklet'
                ? 'The microphone opened, but its audio processor could not load. Restart Couchkin and try again.'
                : startupStage === 'resume'
                  ? 'The audio device could not start. Check your Mac’s audio input and try again.'
                  : 'Could not start your live microphone. Check the input device and try again.',
        );
      }
    })();
    return () => {
      cancelled = true;
      release();
    };
  }, [enabled, selectedDeviceId, defaultDeviceRevision]);

  return { status, error, level, deviceLabel };
}
