import { Global, Module } from '@nestjs/common';
import { AccessService } from './access.service';
import { AuditService } from './audit.service';
import { StorageService } from './storage.service';

@Global()
@Module({ providers: [AccessService, AuditService, StorageService], exports: [AccessService, AuditService, StorageService] })
export class CommonModule {}
