// Runs on the audio thread: turns the call audio into 16 kHz mono,
// 80 ms chunks of 16-bit PCM for Deepgram. Resamples itself (box-filtered
// decimation), so it works at whatever rate macOS delivers.

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const TARGET_RATE = 16000;
const CHUNK = 1280; // 80 ms at 16 kHz

class PcmCapture extends AudioWorkletProcessor {
  private buf = new Float32Array(CHUNK);
  private n = 0;
  private ratio = sampleRate / TARGET_RATE;
  private acc = 0;
  private accN = 0;
  private pos = 0;

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channels = input.length;
    const frames = input[0]!.length;
    for (let i = 0; i < frames; i++) {
      let v = 0;
      for (let c = 0; c < channels; c++) v += input[c]![i]!;
      this.acc += v / channels;
      this.accN++;
      this.pos += 1;
      while (this.pos >= this.ratio) {
        this.buf[this.n++] = this.accN ? this.acc / this.accN : 0;
        if (this.n === CHUNK) this.flush();
        this.pos -= this.ratio;
        this.acc = 0;
        this.accN = 0;
      }
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
    this.port.postMessage({ pcm: pcm.buffer, rms: Math.sqrt(sum / CHUNK) }, [pcm.buffer]);
    this.n = 0;
  }
}

registerProcessor('pcm-capture', PcmCapture);
