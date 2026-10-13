import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { FluxTranscriber, fluxUrl } from '../src/core/stt/deepgram';
import type { TurnEvent } from '../src/core/engine';

let server: WebSocketServer | undefined;
afterEach(() => server?.close());

describe('Deepgram Flux client', () => {
  it('builds the streaming URL with turn detection and keyterms', () => {
    const url = new URL(fluxUrl({ apiKey: 'k', keyterms: ['LL.M.', 'qui tam'] }));
    expect(url.host).toBe('api.deepgram.com');
    expect(url.pathname).toBe('/v2/listen');
    expect(url.searchParams.get('model')).toBe('flux-general-en');
    expect(url.searchParams.get('encoding')).toBe('linear16');
    expect(url.searchParams.get('sample_rate')).toBe('16000');
    expect(url.searchParams.get('eager_eot_threshold')).toBe('0.5');
    expect(url.searchParams.getAll('keyterm')).toEqual(['LL.M.', 'qui tam']);
  });

  it('authenticates, streams audio, maps turn events and closes cleanly', async () => {
    const received: { auth?: string; audioBytes: number; closeStream: boolean } = { audioBytes: 0, closeStream: false };
    server = new WebSocketServer({ port: 0 });
    server.on('connection', (socket, req) => {
      received.auth = req.headers.authorization;
      socket.send(JSON.stringify({ type: 'Connected', request_id: 'r', sequence_id: 0 }));
      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          received.audioBytes += (data as Buffer).length;
          if (received.audioBytes === 3200) {
            for (const [event, transcript] of [
              ['StartOfTurn', 'Tell'],
              ['Update', 'Tell me about'],
              ['EagerEndOfTurn', 'Tell me about yourself'],
              ['EndOfTurn', 'Tell me about yourself.'],
            ]) {
              socket.send(JSON.stringify({ type: 'TurnInfo', event, turn_index: 0, transcript, words: [], end_of_turn_confidence: 0.9 }));
            }
          }
        } else if (JSON.parse(data.toString()).type === 'CloseStream') {
          received.closeStream = true;
        }
      });
    });
    const port = (server.address() as AddressInfo).port;
    const flux = new FluxTranscriber({ apiKey: 'secret', url: `ws://127.0.0.1:${port}/v2/listen` });
    const events: TurnEvent[] = [];
    const done = new Promise<void>((resolve) =>
      flux.on('turn', (e: TurnEvent) => {
        events.push(e);
        if (e.type === 'end') resolve();
      }),
    );
    flux.start();
    flux.send(Buffer.alloc(1600)); // queued until open
    flux.send(Buffer.alloc(1600));
    await done;
    expect(received.auth).toBe('Token secret');
    expect(events.map((e) => e.type)).toEqual(['start', 'update', 'eager-end', 'end']);
    expect(events[3]).toEqual({ type: 'end', turn: 0, text: 'Tell me about yourself.' });
    flux.stop();
    await new Promise((r) => setTimeout(r, 100));
    expect(received.closeStream).toBe(true);
  });
});
