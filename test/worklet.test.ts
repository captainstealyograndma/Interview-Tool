import { describe, expect, it } from 'vitest';

describe('Audio worklet (call audio -> 16 kHz PCM)', () => {
  it('resamples 48 kHz stereo to 80 ms chunks of 16 kHz 16-bit audio', async () => {
    const messages: { pcm: ArrayBuffer; rms: number }[] = [];
    let Proc: new () => { process(inputs: Float32Array[][]): boolean } = undefined as never;
    const g = globalThis as Record<string, unknown>;
    g.sampleRate = 48000;
    g.AudioWorkletProcessor = class {
      port = { postMessage: (m: { pcm: ArrayBuffer; rms: number }) => messages.push(m) };
    };
    g.registerProcessor = (_name: string, ctor: typeof Proc) => (Proc = ctor);
    await import('../src/renderer/audio-worklet');

    const p = new Proc();
    const amp = 0.5;
    let t = 0;
    for (let block = 0; block < 375; block++) {
      // 375 blocks x 128 frames = 1 s at 48 kHz
      const left = new Float32Array(128);
      const right = new Float32Array(128);
      for (let i = 0; i < 128; i++, t++) left[i] = right[i] = amp * Math.sin((2 * Math.PI * 440 * t) / 48000);
      p.process([[left, right]]);
    }
    // 16,000 samples per second / 1,280 per chunk = 12.5 chunks
    expect(messages.length).toBe(12);
    expect(messages[0]!.pcm.byteLength).toBe(1280 * 2);
    const rms = messages[5]!.rms;
    expect(rms).toBeGreaterThan(0.33);
    expect(rms).toBeLessThan(0.37); // 0.5 / sqrt(2) ≈ 0.354, slightly reduced by averaging
    const samples = new Int16Array(messages[5]!.pcm);
    expect(Math.max(...samples)).toBeGreaterThan(15000);
  });
});
