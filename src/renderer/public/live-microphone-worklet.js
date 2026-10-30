// AudioWorklet runs at the device's actual sample rate, independently of UI rendering.
// Average each output sample's input interval; preserve phase across render quanta.
class CouchkinMicrophoneProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.running = true;
    this.ratio = sampleRate / 24000;
    this.remaining = this.ratio;
    this.sum = 0;
    this.bytes = new ArrayBuffer(960 * 2);
    this.view = new DataView(this.bytes);
    this.length = 0;
    this.energy = 0;
    this.port.onmessage = (event) => {
      if (event.data === 'stop') this.running = false;
    };
  }
  process(inputs, outputs) {
    if (!this.running) return false;
    const channels = inputs[0];
    const frames = channels?.[0]?.length ?? outputs[0]?.[0]?.length ?? 128;
    for (let frame = 0; frame < frames; frame++) {
      let value = 0;
      for (const channel of channels ?? []) value += channel[frame] || 0;
      if (channels?.length) value /= channels.length;
      let available = 1;
      while (available > 1e-9) {
        const weight = Math.min(available, this.remaining);
        this.sum += value * weight;
        this.remaining -= weight;
        available -= weight;
        if (this.remaining <= 1e-9) {
          const sample = Math.max(-1, Math.min(1, this.sum / this.ratio));
          this.view.setInt16(
            this.length * 2,
            Math.round(sample * (sample < 0 ? 32768 : 32767)),
            true,
          );
          this.energy += sample * sample;
          this.length++;
          this.remaining = this.ratio;
          this.sum = 0;
          if (this.length === 960) {
            this.port.postMessage(
              { pcm: this.bytes, level: Math.sqrt(this.energy / 960), at: currentTime },
              [this.bytes],
            );
            this.bytes = new ArrayBuffer(960 * 2);
            this.view = new DataView(this.bytes);
            this.length = 0;
            this.energy = 0;
          }
        }
      }
    }
    // Outputs remain silent: the microphone is sent to the model, never monitored locally.
    return true;
  }
}
registerProcessor('couchkin-live-microphone', CouchkinMicrophoneProcessor);
