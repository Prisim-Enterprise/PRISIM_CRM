import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createReadStream, existsSync, mkdirSync, promises as fs } from 'node:fs';
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

/**
 * Private file storage on local disk, outside the web root. Files are only served
 * through authorised API endpoints. Can be swapped for OCI/S3 object storage
 * behind the same interface.
 */
@Injectable()
export class StorageService {
  private root = resolve(process.env.STORAGE_DIR ? resolve(process.cwd(), '..', process.env.STORAGE_DIR) : join(process.cwd(), '../storage'));

  constructor() {
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true });
  }

  validate(kind: 'attachment' | 'recording', file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded');
    if (file.size > MAX_UPLOAD_BYTES) throw new BadRequestException('File is larger than 25 MB');
    if (!ALLOWED[kind].includes(file.mimetype)) throw new BadRequestException(`File type ${file.mimetype} is not allowed`);
  }

  async save(kind: string, buffer: Buffer, originalName: string): Promise<string> {
    const ext = extname(originalName).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
    const key = `${kind}/${new Date().toISOString().slice(0, 7)}/${randomUUID()}${ext}`;
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

  /** Streams a stored file with HTTP range support (needed for audio seeking). */
  async send(res: Response, key: string, mimeType: string, rangeHeader?: string, downloadName?: string) {
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
    await fs.rm(this.path(key), { force: true });
  }
}
