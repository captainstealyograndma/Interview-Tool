// Streaming transcription with Deepgram Flux (built-in end-of-turn detection).
// Emits TurnEvents: start / update / eager-end / resumed / end.

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { TurnEvent, TurnEventType } from '../engine';

export interface FluxOptions {
  apiKey: string;
  keyterms?: string[];
  sampleRate?: number;
  /** End-of-turn confidence that finishes a turn (0.5–1.0). */
  eotThreshold?: number;
  /** Confidence that fires an early "probably finished" event (0.3–0.9). */
  eagerEotThreshold?: number;
  /** A turn ends after this much silence regardless of confidence (ms). */
  eotTimeoutMs?: number;
  url?: string;
}

const EVENT_MAP: Record<string, TurnEventType> = {
  StartOfTurn: 'start',
  Update: 'update',
  EagerEndOfTurn: 'eager-end',
  TurnResumed: 'resumed',
  EndOfTurn: 'end',
};

const MAX_QUEUE_BYTES = 16000 * 2 * 3; // ~3 s of 16 kHz 16-bit audio while (re)connecting

export function fluxUrl(o: FluxOptions): string {
  const params = new URLSearchParams({
    model: 'flux-general-en',
    encoding: 'linear16',
    sample_rate: String(o.sampleRate ?? 16000),
    eot_threshold: String(o.eotThreshold ?? 0.7),
    eager_eot_threshold: String(o.eagerEotThreshold ?? 0.5),
    eot_timeout_ms: String(o.eotTimeoutMs ?? 5000),
  });
  for (const k of (o.keyterms ?? []).slice(0, 40)) params.append('keyterm', k);
  return `${o.url ?? 'wss://api.deepgram.com/v2/listen'}?${params.toString()}`;
}

export class FluxTranscriber extends EventEmitter {
  private ws?: WebSocket;
  private stopped = false;
  private queue: Buffer[] = [];
  private queued = 0;
  private attempts = 0;
  private turnOffset = 0;
  private lastTurn = -1;

  constructor(private opts: FluxOptions) {
    super();
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  private connect() {
    const ws = new WebSocket(fluxUrl(this.opts), { headers: { Authorization: `Token ${this.opts.apiKey}` } });
    this.ws = ws;
    ws.on('open', () => {
      this.attempts = 0;
      this.emit('open');
      for (const b of this.queue) ws.send(b);
      this.queue = [];
      this.queued = 0;
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg: { type?: string; event?: string; turn_index?: number; transcript?: string; description?: string; code?: string };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === 'TurnInfo' && msg.event && EVENT_MAP[msg.event]) {
        const turn = this.turnOffset + (msg.turn_index ?? 0);
        this.lastTurn = Math.max(this.lastTurn, turn);
        const ev: TurnEvent = { type: EVENT_MAP[msg.event]!, turn, text: (msg.transcript ?? '').trim() };
        this.emit('turn', ev);
      } else if (msg.type === 'Error') {
        this.emit('error', new Error(`Deepgram: ${msg.description ?? msg.code ?? 'error'}`));
      }
    });
    ws.on('unexpected-response', (_req, res) => {
      this.emit('error', new Error(res.statusCode === 401 ? 'Deepgram rejected the API key.' : `Deepgram HTTP ${res.statusCode}`));
    });
    ws.on('error', (err) => this.emit('error', err));
    ws.on('close', () => {
      this.emit('close');
      if (this.stopped) return;
      // Turn numbers restart on a new connection; keep them increasing for the engine.
      this.turnOffset = this.lastTurn + 1;
      const delay = Math.min(8000, 500 * 2 ** this.attempts++);
      if (this.attempts <= 6) setTimeout(() => !this.stopped && this.connect(), delay);
      else this.emit('error', new Error('Lost the connection to Deepgram.'));
    });
  }

  /** 16-bit little-endian mono PCM at the configured sample rate. */
  send(pcm: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(pcm);
      return;
    }
    this.queue.push(pcm);
    this.queued += pcm.length;
    while (this.queued > MAX_QUEUE_BYTES && this.queue.length) this.queued -= this.queue.shift()!.length;
  }

  stop(): void {
    this.stopped = true;
    const ws = this.ws;
    if (!ws) return;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'CloseStream' }));
      setTimeout(() => ws.close(), 300);
    } else ws.terminate();
  }
}
