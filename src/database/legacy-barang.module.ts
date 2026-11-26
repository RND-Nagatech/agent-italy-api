import { Module } from '@nestjs/common';
import { LegacyBarangService } from './legacy-barang.service';

@Module({ providers: [{ provide: LegacyBarangService, useFactory: () => new LegacyBarangService() }], exports: [LegacyBarangService] })
export class LegacyBarangModule { }
