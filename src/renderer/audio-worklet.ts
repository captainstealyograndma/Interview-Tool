// Runs on the audio thread: turns the call audio (resampled to 16 kHz by the
// AudioContext) into 80 ms chunks of 16-bit PCM for Deepgram.

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const CHUNK = 1280; // 80 ms at 16 kHz

class PcmCapture extends AudioWorkletProcessor {
  private buf = new Float32Array(CHUNK);
  private n = 0;

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channels = input.length;
    const frames = input[0]!.length;
    for (let i = 0; i < frames; i++) {
      let v = 0;
      for (let c = 0; c < channels; c++) v += input[c]![i]!;
      this.buf[this.n++] = v / channels;
      if (this.n === CHUNK) this.flush();
    }
    return true;
  }

  private flush() {
    const pcm = new Int16Array(CHUNK);
    let sum = 0;
    for (let i = 0; i < CHUNK; i++) {
      const s = Math.max(-1, Math.min(1, this.buf[i]!));
      sum += s * s;
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.port.postMessage({ pcm: pcm.buffer, rms: Math.sqrt(sum / CHUNK), sampleRate }, [pcm.buffer]);
    this.n = 0;
  }
}

registerProcessor('pcm-capture', PcmCapture);
