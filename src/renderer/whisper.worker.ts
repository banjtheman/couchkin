import { pipeline, env } from '@huggingface/transformers';
env.allowLocalModels = false;
if (env.backends.onnx.wasm) env.backends.onnx.wasm.numThreads = 1;
let model: Promise<any> | null = null;
const load = () =>
  (model ??= (pipeline as any)('automatic-speech-recognition', 'onnx-community/whisper-tiny.en', {
    device: 'wasm',
    dtype: 'q8',
  }));
self.onmessage = async (event) => {
  try {
    const transcribe = await load();
    if (event.data.type === 'load') {
      self.postMessage({ type: 'ready' });
      return;
    }
    if (event.data.type === 'transcribe') {
      const result = await transcribe(event.data.audio, { chunk_length_s: 30, stride_length_s: 5 });
      self.postMessage({ type: 'result', text: result.text || '' });
    }
  } catch {
    model = null;
    self.postMessage({
      type: 'error',
      message:
        'The local Whisper model could not load. Check your connection for the first download, then retry.',
    });
  }
};
