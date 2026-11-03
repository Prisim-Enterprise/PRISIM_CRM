import { BadGatewayException, Logger } from '@nestjs/common';
import { CallStatus } from '@prisma/client';
import { CallEvent, StartCallInput, TelephonyProvider } from './provider';

/**
 * Exotel click-to-call adapter (popular in India). Exotel first rings the agent's
 * phone, then bridges to the customer, records the call, and posts a status
 * callback when the call ends.
 * Docs: https://developer.exotel.com/api/make-a-call-api
 */
export class ExotelProvider implements TelephonyProvider {
  readonly name = 'exotel';
  private log = new Logger('Exotel');
  private sid = process.env.EXOTEL_SID || '';
  private key = process.env.EXOTEL_API_KEY || '';
  private token = process.env.EXOTEL_API_TOKEN || '';
  private host = process.env.EXOTEL_SUBDOMAIN || 'api.exotel.com';
  private callerId = process.env.EXOTEL_CALLER_ID || '';
  // Exotel timestamps are in account local time without an offset.
  private tzOffset = process.env.EXOTEL_TZ_OFFSET || '+05:30';

  isConfigured() {
    return !!(this.sid && this.key && this.token && this.callerId);
  }

  private authHeader() {
    return 'Basic ' + Buffer.from(`${this.key}:${this.token}`).toString('base64');
  }

  async startCall(input: StartCallInput) {
    const body = new URLSearchParams({
      From: input.agentNumber,
      To: input.customerNumber,
      CallerId: this.callerId,
      Record: 'true',
      StatusCallback: input.statusCallbackUrl,
      'StatusCallbackEvents[0]': 'terminal',
      StatusCallbackContentType: 'application/json',
    });
    const res = await fetch(`https://${this.host}/v1/Accounts/${this.sid}/Calls/connect.json`, {
      method: 'POST',
      headers: { Authorization: this.authHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await res.text();
    if (!res.ok) {
      this.log.error(`Exotel connect failed (${res.status}): ${text.slice(0, 300)}`);
      throw new BadGatewayException('The telephony provider rejected the call. Check the numbers and provider settings.');
    }
    const json = JSON.parse(text) as { Call?: { Sid?: string } };
    if (!json.Call?.Sid) throw new BadGatewayException('Unexpected response from telephony provider');
    return { providerCallId: json.Call.Sid, fromNumber: this.callerId };
  }

  private parseTime(v: unknown): Date | undefined {
    if (!v || typeof v !== 'string') return undefined;
    const iso = v.includes('T') ? v : v.replace(' ', 'T') + this.tzOffset;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? undefined : d;
  }

  parseWebhook(body: Record<string, unknown>): CallEvent[] {
    const sid = String(body.CallSid ?? '');
    if (!sid) return [];
    const map: Record<string, CallStatus> = {
      completed: 'COMPLETED', busy: 'BUSY', 'no-answer': 'NO_ANSWER', failed: 'FAILED', canceled: 'CANCELED',
      'in-progress': 'IN_PROGRESS', ringing: 'RINGING', queued: 'INITIATED',
    };
    const rawStatus = String(body.Status ?? body.CallStatus ?? '').toLowerCase();
    const status = map[rawStatus] ?? 'FAILED';
    const duration = Number(body.ConversationDuration ?? body.DialCallDuration ?? NaN);
    return [{
      providerCallId: sid,
      eventId: `${sid}:${rawStatus}:${String(body.EventType ?? 'terminal')}`,
      status,
      startedAt: this.parseTime(body.StartTime),
      endedAt: this.parseTime(body.EndTime),
      durationSeconds: Number.isFinite(duration) ? duration : undefined,
      recordingUrl: typeof body.RecordingUrl === 'string' && body.RecordingUrl ? body.RecordingUrl : undefined,
      raw: body,
    }];
  }

  async fetchRecording(url: string) {
    const u = new URL(url);
    if (!u.hostname.endsWith('exotel.com') && !u.hostname.endsWith('exotel.in')) {
      throw new BadGatewayException('Recording URL is not an Exotel URL');
    }
    const res = await fetch(url, { headers: { Authorization: this.authHeader() } });
    if (!res.ok) throw new BadGatewayException(`Could not download recording (${res.status})`);
    return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || 'audio/mpeg' };
  }
}
