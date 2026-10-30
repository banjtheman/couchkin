import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'couchkin.live-microphone.v1';
type MicrophoneInput = { deviceId: string; label: string };

function readSelection(): MicrophoneInput {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw || raw.length > 2048) return { deviceId: '', label: '' };
    const saved: unknown = JSON.parse(raw);
    if (
      saved &&
      typeof saved === 'object' &&
      'deviceId' in saved &&
      typeof saved.deviceId === 'string' &&
      saved.deviceId.length <= 1024
    ) {
      return {
        deviceId: saved.deviceId === 'default' ? '' : saved.deviceId,
        label: 'label' in saved && typeof saved.label === 'string' ? saved.label.slice(0, 200) : '',
      };
    }
  } catch {
    // Storage may be blocked or contain an older value; input discovery still works.
  }
  return { deviceId: '', label: '' };
}

/** Lists inputs without requesting permission or opening an audio stream. */
export function useMicrophoneInputs() {
  const [selection, setSelection] = useState(readSelection);
  const [inputs, setInputs] = useState<MicrophoneInput[]>([]);
  const [loading, setLoading] = useState(false);
  const [enumerated, setEnumerated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedLocally, setSavedLocally] = useState(true);
  const mounted = useRef(false);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    if (!mounted.current) return;
    const attempt = ++generation.current;
    const current = () => mounted.current && generation.current === attempt;
    setLoading(true);
    setError(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!navigator.mediaDevices?.enumerateDevices)
        throw new Error('Microphone discovery is unavailable. Open the Couchkin desktop app.');
      const devices = await Promise.race([
        navigator.mediaDevices.enumerateDevices(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error('Microphone discovery took too long. Try Refresh inputs again.')),
            8000,
          );
        }),
      ]);
      if (!current()) return;
      const discovered = new Map<string, MicrophoneInput>();
      for (const device of devices) {
        if (
          device.kind === 'audioinput' &&
          device.deviceId &&
          device.deviceId !== 'default' &&
          device.deviceId !== 'communications'
        ) {
          discovered.set(device.deviceId, {
            deviceId: device.deviceId,
            label: device.label.trim(),
          });
        }
      }
      const next = [...discovered.values()];
      setInputs(next);
      setEnumerated(true);
      setSelection((previous) => {
        const label = discovered.get(previous.deviceId)?.label;
        return label && label !== previous.label ? { ...previous, label } : previous;
      });
    } catch (cause) {
      if (current())
        setError(
          cause instanceof Error && cause.message.startsWith('Microphone discovery')
            ? cause.message
            : 'Could not list microphones. Check Mac microphone permission, then refresh inputs.',
        );
    } finally {
      if (timer) clearTimeout(timer);
      if (current()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const mediaDevices = navigator.mediaDevices;
    const onDeviceChange = () => void refresh();
    mediaDevices?.addEventListener('devicechange', onDeviceChange);
    return () => {
      mounted.current = false;
      generation.current++;
      mediaDevices?.removeEventListener('devicechange', onDeviceChange);
    };
  }, [refresh]);

  useEffect(() => {
    try {
      if (selection.deviceId) localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
      else localStorage.removeItem(STORAGE_KEY);
      setSavedLocally(true);
    } catch {
      setSavedLocally(false);
    }
  }, [selection]);

  const select = (deviceId: string) => {
    setSelection({
      deviceId,
      label: inputs.find((input) => input.deviceId === deviceId)?.label ?? '',
    });
  };
  const selectedMissing =
    !!selection.deviceId && !inputs.some((input) => input.deviceId === selection.deviceId);

  return {
    inputs,
    selectedId: selection.deviceId,
    selectedLabel: selection.label,
    selectedMissing,
    enumerated,
    loading,
    error,
    savedLocally,
    refresh,
    select,
  };
}
