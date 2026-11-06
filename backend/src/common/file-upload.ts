import { applyDecorators, CallHandler, Controller, ExecutionContext, Injectable, NestInterceptor, Post, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { MAX_UPLOAD_BYTES, StorageService } from './storage.service';

/** Lets an upload endpoint take a file the browser already sent to storage: ?staged=key&name=…&type=… */
@Injectable()
class StagedFileInterceptor implements NestInterceptor {
  constructor(private storage: StorageService) {}

  async intercept(ctx: ExecutionContext, next: CallHandler) {
    const req = ctx.switchToHttp().getRequest<Request>();
    const { staged, name, type } = req.query;
    if (!req.file && typeof staged === 'string') {
      const buffer = await this.storage.takeStaged(staged);
      req.file = { buffer, size: buffer.length, originalname: String(name ?? 'file'), mimetype: String(type ?? '') } as Express.Multer.File;
    }
    return next.handle();
  }
}

/** Accepts a file sent directly, or one staged in storage. */
export const FileUpload = (maxBytes = MAX_UPLOAD_BYTES) =>
  applyDecorators(UseInterceptors(FileInterceptor('file', { limits: { fileSize: maxBytes } }), StagedFileInterceptor));

@Controller('uploads')
export class UploadsController {
  constructor(private storage: StorageService) {}

  @Post('sign')
  async sign() {
    return (await this.storage.stageUpload()) ?? { url: null };
  }
}
