import { CallStatus } from '@prisma/client';

/** Provider-neutral call event. Provider payloads never leak past the adapter. */
export interface CallEvent {
  providerCallId: string;
  /** Unique per event, for idempotent processing */
  eventId: string;
  status: CallStatus;
  startedAt?: Date;
  endedAt?: Date;
  durationSeconds?: number;
  recordingUrl?: string;
  /** Simulator only: in-memory recording */
  recordingBuffer?: Buffer;
  raw: unknown;
}

export interface StartCallInput {
  agentNumber: string;
  customerNumber: string;
  statusCallbackUrl: string;
  /** Used by the simulator to deliver events without a public URL */
  deliver?: (e: CallEvent) => Promise<void>;
}

export interface TelephonyProvider {
  readonly name: string;
  isConfigured(): boolean;
  /** Bridges the agent's phone to the customer; returns the provider's call id. */
  startCall(input: StartCallInput): Promise<{ providerCallId: string; fromNumber: string }>;
  parseWebhook(body: Record<string, unknown>): CallEvent[];
  /** Downloads a provider recording (with provider auth). */
  fetchRecording(url: string): Promise<{ buffer: Buffer; contentType: string }>;
}

export const TELEPHONY_PROVIDER = Symbol('TELEPHONY_PROVIDER');
