import { BadGatewayException, BadRequestException, Body, Controller, Get, Header, Headers, HttpException, Injectable, Module, Param, Post, Query, ServiceUnavailableException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { Roles } from '../common/roles.decorator';
import { env } from '../config/env';
import { Role } from '../users/roles';

class UsageQuery {
  @IsOptional() @IsISO8601({ strict: true }) from?: string;
  @IsOptional() @IsISO8601({ strict: true }) to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @IsString() @MaxLength(2048) cursor?: string;
}

const BANKS = ['BCA', 'BNI', 'BRI', 'MANDIRI', 'PERMATA', 'MAYBANK', 'CIMB', 'BSI', 'MUAMALAT', 'BNC', 'OCBC', 'DANAMON'];
class CreateTopUpDto {
  @IsIn(['qris', 'va']) method!: 'qris' | 'va';
  @IsInt() @Min(1) @Max(1_000_000_000) amountIdr!: number;
  @ValidateIf((dto: CreateTopUpDto) => dto.method === 'va' || dto.bankCode !== undefined)
  @IsIn(BANKS) bankCode?: string;
}

@Injectable()
export class AgentUsageService {
  async read(path: 'balance' | 'usage/summary' | 'usage', query: UsageQuery = {}) {
    if (!env.deepSeekIntegrationApiKey) throw new ServiceUnavailableException('Kunci integrasi gateway belum dikonfigurasi di backend/.env untuk saldo, penggunaan, dan top-up.');
    if (query.from && query.to && Date.parse(query.from) >= Date.parse(query.to)) {
      throw new BadRequestException('Tanggal awal harus sebelum tanggal akhir.');
    }
    const url = new URL(`/api/v1/me/${path}`, env.deepSeekGatewayUrl || env.deepSeekBaseUrl);
    for (const key of ['from', 'to', ...(path === 'usage' ? ['limit', 'cursor'] : [])] as const) {
      const value = query[key as keyof UsageQuery];
      if (value !== undefined && path !== 'balance') url.searchParams.set(key, String(value));
    }
    return this.call(url);
  }

  async call(url: URL, method = 'GET', body?: unknown, idempotencyKey?: string, allowMissing = false): Promise<any> {
    if (!env.deepSeekIntegrationApiKey) throw new ServiceUnavailableException('Kunci integrasi gateway belum dikonfigurasi di backend/.env untuk saldo, penggunaan, dan top-up.');
    let response: Response;
    try {
      response = await fetch(url, {
        method, body: body === undefined ? undefined : JSON.stringify(body),
        headers: { Authorization: `Bearer ${env.deepSeekIntegrationApiKey}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
        signal: AbortSignal.timeout(15_000), redirect: 'error',
      });
    } catch {
      throw new BadGatewayException('Gateway tidak dapat dihubungi. Coba perbarui kembali.');
    }
    if (response.status === 404 && allowMissing) return null;
    if (!response.ok) {
      const message = response.status === 401 || response.status === 403
        ? 'Gateway menolak integration API key. Periksa credential integrasi di backend/.env.'
        : response.status === 404 ? 'Endpoint penggunaan gateway tidak ditemukan. Periksa URL gateway di backend/.env.'
          : response.status === 429 ? 'Batas permintaan gateway tercapai. Coba beberapa saat lagi.'
            : 'Gateway gagal mengambil data penggunaan. Coba perbarui kembali.';
      if (response.status === 409 || response.status === 400) {
        const conflictMessage = url.pathname.endsWith('/release')
          ? 'QRIS tidak dapat dilepas karena statusnya berubah atau pembayaran masih perlu diperiksa. Perbarui status terlebih dahulu.'
          : 'Pembayaran belum dapat diproses. Periksa status pembayaran sebelumnya; untuk QRIS gagal tanpa kode QR, gunakan Lepaskan QRIS macet.';
        throw new HttpException(conflictMessage, response.status);
      }
      throw new BadGatewayException(message);
    }
    try { return await response.json(); }
    catch { throw new BadGatewayException('Respons gateway tidak valid.'); }
  }
  payment(path = '', method = 'GET', body?: unknown, key?: string, allowMissing = false) {
    return this.call(new URL(`/api/v1/me/topups${path}`, env.deepSeekGatewayUrl || env.deepSeekBaseUrl), method, body, key, allowMissing);
  }
  validateKey(key: string | undefined) {
    if (!key || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new BadRequestException('Idempotency-Key wajib, 8–128 karakter aman.');
    return key;
  }
  reference(ref: string) {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(ref)) throw new BadRequestException('Referensi pembayaran tidak valid.');
    return encodeURIComponent(ref);
  }
  requireMethod(method: string) {
    if (!env.topupPaymentMethods.includes(method as 'qris' | 'va')) throw new BadRequestException('Metode pembayaran ini dinonaktifkan. Pilih metode lain yang tersedia.');
  }
  async retryPayment(ref: string, key: string | undefined) {
    const safeKey = this.validateKey(key);
    const reference = this.reference(ref);
    const previous = await this.payment(`/${reference}`);
    this.requireMethod(previous.method);
    return this.payment(`/${reference}/retry`, 'POST', undefined, safeKey);
  }
  async createPayment(dto: CreateTopUpDto, key: string | undefined) {
    const safeKey = this.validateKey(key);
    this.requireMethod(dto.method);
    if (dto.method === 'va' && dto.amountIdr < 10000) throw new BadRequestException('Minimum top-up VA Rp10.000.');
    const active = await this.payment('/active', 'GET', undefined, undefined, true);
    if (active) return active;
    return this.payment(dto.method === 'va' ? '/va' : '', 'POST', { amountIdr: dto.amountIdr, ...(dto.method === 'va' ? { bankCode: dto.bankCode } : {}) }, safeKey);
  }

}

@Controller('agent-usage')
@Roles(Role.Admin)
export class AgentUsageController {
  constructor(private readonly service: AgentUsageService) {}
  @Get('topups/config') @Header('Cache-Control', 'no-store') config() { return { methods: env.topupPaymentMethods }; }
  @Get('topups/active') @Header('Cache-Control', 'no-store') active() { return this.service.payment('/active', 'GET', undefined, undefined, true); }
  @Get('topups') @Header('Cache-Control', 'no-store') topups() { return this.service.payment('?limit=20'); }
  @Post('topups') @Header('Cache-Control', 'no-store') create(@Body() dto: CreateTopUpDto, @Headers('idempotency-key') key?: string) { return this.service.createPayment(dto, key); }
  @Get('topups/:ref') @Header('Cache-Control', 'no-store') detail(@Param('ref') ref: string) { return this.service.payment(`/${this.service.reference(ref)}`); }
  @Post('topups/:ref/reconcile') @Header('Cache-Control', 'no-store') reconcile(@Param('ref') ref: string) { return this.service.payment(`/${this.service.reference(ref)}/reconcile`, 'POST'); }
  @Post('topups/:ref/retry') @Header('Cache-Control', 'no-store') retry(@Param('ref') ref: string, @Headers('idempotency-key') key?: string) { return this.service.retryPayment(ref, key); }
  @Post('topups/:ref/release') @Header('Cache-Control', 'no-store') release(@Param('ref') ref: string) { return this.service.payment(`/${this.service.reference(ref)}/release`, 'POST'); }
  @Get('balance') @Header('Cache-Control', 'no-store') balance() { return this.service.read('balance'); }
  @Get('summary') @Header('Cache-Control', 'no-store') summary(@Query() query: UsageQuery) { return this.service.read('usage/summary', query); }
  @Get('requests') @Header('Cache-Control', 'no-store') requests(@Query() query: UsageQuery) { return this.service.read('usage', query); }
}

@Module({ controllers: [AgentUsageController], providers: [AgentUsageService] })
export class AgentUsageModule {}
