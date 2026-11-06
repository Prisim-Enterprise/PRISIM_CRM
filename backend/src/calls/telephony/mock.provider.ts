import { randomUUID } from 'node:crypto';
import { CallEvent, StartCallInput, TelephonyProvider } from './provider';

/**
 * Call simulator for development and demos. Pretends to ring, connect and end the
 * call a few seconds later, and produces a short audio "recording" so the whole
 * flow (status, duration, recording playback) can be tested without a provider.
 */
export class MockProvider implements TelephonyProvider {
  readonly name = 'mock';

  isConfigured() {
    return true;
  }

  async startCall(input: StartCallInput) {
    const providerCallId = `SIM-${randomUUID()}`;
    const answered = Math.random() > 0.25;
    const duration = answered ? 20 + Math.floor(Math.random() * 160) : 0;
    const startedAt = new Date();
    setTimeout(() => {
      void input.deliver?.({ providerCallId, eventId: `${providerCallId}:ringing`, status: 'RINGING', startedAt, raw: { simulated: true } });
    }, 1500);
    setTimeout(() => {
      void input.deliver?.({
        providerCallId,
        eventId: `${providerCallId}:terminal`,
        status: answered ? 'COMPLETED' : 'NO_ANSWER',
        startedAt,
        endedAt: new Date(startedAt.getTime() + duration * 1000),
        durationSeconds: duration,
        recordingBuffer: answered ? toneWav(Math.min(duration, 8)) : undefined,
        raw: { simulated: true },
      });
    }, 6000);
    return { providerCallId, fromNumber: '+910000000000' };
  }

  parseWebhook(): CallEvent[] {
    return [];
  }

  async fetchRecording(): Promise<{ buffer: Buffer; contentType: string }> {
    throw new Error('Simulator recordings are stored directly');
  }
}

/** Generates a quiet two-tone WAV so the recording player has something to play. */
function toneWav(seconds: number): Buffer {
  const rate = 8000;
  const n = Math.max(1, Math.floor(rate * seconds));
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const f = Math.floor(t * 2) % 2 ? 440 : 523;
    const env = Math.min(1, t * 4, (seconds - t) * 4);
    buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * f * t) * 3000 * env), 44 + i * 2);
  }
  return buf;
}
