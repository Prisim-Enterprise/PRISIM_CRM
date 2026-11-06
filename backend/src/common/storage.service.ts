import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createReadStream, promises as fs } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const ALLOWED: Record<'attachment' | 'recording', string[]> = {
  attachment: [
    'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', 'text/plain', 'text/csv',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ],
  recording: [
    'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/ogg', 'audio/webm',
    'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/amr',
  ],
};

const BUCKET = 'crm-files';
const STAGED_KEY = /^staged\/[0-9a-f-]{36}$/;

/**
 * Private file storage: a private Supabase Storage bucket when SUPABASE_URL and
 * SUPABASE_SECRET_KEY are set, otherwise local disk (development). Files are only
 * reachable through authorised API endpoints.
 */
@Injectable()
export class StorageService {
  private root = resolve(process.env.STORAGE_DIR ? resolve(process.cwd(), '..', process.env.STORAGE_DIR) : join(process.cwd(), '../storage'));
  private base = process.env.SUPABASE_URL?.replace(/\/$/, '');
  private secret = process.env.SUPABASE_SECRET_KEY;
  private get remote() { return !!(this.base && this.secret); }

  private call(path: string, init: RequestInit = {}) {
    return fetch(`${this.base}/storage/v1${path}`, {
      ...init,
      headers: { apikey: this.secret!, Authorization: `Bearer ${this.secret}`, ...init.headers },
    });
  }

  validate(kind: 'attachment' | 'recording', file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded');
    if (file.size > MAX_UPLOAD_BYTES) throw new BadRequestException('File is larger than 25 MB');
    if (!ALLOWED[kind].includes(file.mimetype)) throw new BadRequestException(`File type ${file.mimetype} is not allowed`);
  }

  async save(kind: string, buffer: Buffer, originalName: string, mimeType = 'application/octet-stream'): Promise<string> {
    const ext = extname(originalName).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
    const key = `${kind}/${new Date().toISOString().slice(0, 7)}/${randomUUID()}${ext}`;
    if (this.remote) {
      const res = await this.call(`/object/${BUCKET}/${key}`, { method: 'POST', headers: { 'Content-Type': mimeType }, body: new Uint8Array(buffer) });
      if (!res.ok) throw new BadGatewayException('The file could not be stored');
      return key;
    }
    const full = this.path(key);
    await fs.mkdir(resolve(full, '..'), { recursive: true });
    await fs.writeFile(full, buffer);
    return key;
  }

  path(key: string): string {
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new BadRequestException('Invalid file key');
    return full;
  }

  /**
   * A one-time address the browser uploads a large file to, because hosted API requests
   * are limited to about 4.5 MB. Returns null on local disk, where the normal upload works.
   */
  async stageUpload(): Promise<{ url: string; key: string } | null> {
    if (!this.remote) return null;
    const key = `staged/${randomUUID()}`;
    const res = await this.call(`/object/upload/sign/${BUCKET}/${key}`, { method: 'POST' });
    if (!res.ok) throw new BadGatewayException('The upload could not be started');
    const { url } = (await res.json()) as { url: string };
    return { url: `${this.base}/storage/v1${url}`, key };
  }

  /** Reads a file uploaded through stageUpload, then deletes the staged copy. */
  async takeStaged(key: string): Promise<Buffer> {
    if (!this.remote || !STAGED_KEY.test(key)) throw new BadRequestException('Invalid upload');
    const res = await this.call(`/object/${BUCKET}/${key}`);
    if (!res.ok) throw new BadRequestException('The uploaded file was not found');
    const buffer = Buffer.from(await res.arrayBuffer());
    await this.remove(key);
    return buffer;
  }

  /** Streams a stored file with HTTP range support (needed for audio seeking). */
  async send(res: Response, key: string, mimeType: string, rangeHeader?: string, downloadName?: string) {
    if (this.remote) {
      // Hosted API replies are limited to about 4.5 MB, so the browser fetches the file from a short-lived link.
      const signed = await this.call(`/object/sign/${BUCKET}/${key}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 300 }),
      });
      if (!signed.ok) throw new NotFoundException('File not found');
      const { signedURL } = (await signed.json()) as { signedURL: string };
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-File-Location', `${this.base}/storage/v1${signedURL}`);
      res.status(204).end();
      return;
    }
    let size: number;
    try {
      size = (await fs.stat(this.path(key))).size;
    } catch {
      throw new NotFoundException('File not found');
    }
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, no-store');
    if (downloadName) res.setHeader('Content-Disposition', `attachment; filename="${downloadName.replace(/"/g, '')}"`);
    const m = rangeHeader?.match(/bytes=(\d*)-(\d*)/);
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', end - start + 1);
      createReadStream(this.path(key), { start, end }).pipe(res);
    } else {
      res.setHeader('Content-Length', size);
      createReadStream(this.path(key)).pipe(res);
    }
  }

  async remove(key: string) {
    if (this.remote) {
      await this.call(`/object/${BUCKET}/${key}`, { method: 'DELETE' });
      return;
    }
    await fs.rm(this.path(key), { force: true });
  }
}
