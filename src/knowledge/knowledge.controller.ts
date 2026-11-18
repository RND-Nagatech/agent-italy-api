import { MemoryLearningService } from './memory-learning.service';
import { BadRequestException, Body, Controller, Delete, Get, Header, HttpCode, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FastifyReply, FastifyRequest } from 'fastify';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/current-user.decorator';
import { AuthPrincipal } from '../users/user.types';
import { Roles } from '../common/roles.decorator';
import { Role } from '../users/roles';
import { KnowledgeService } from './knowledge.service';
import { SharedMemoryService } from './memory.service';
import { KnowledgeMetadataDto, KnowledgePatchDto, KnowledgeSearchDto, MemoryProposalDto } from './knowledge.dto';
import { env } from '../config/env';
@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService, private readonly memory: SharedMemoryService, private readonly learning: MemoryLearningService) {}
  @Get() @Header('Cache-Control', 'no-store')
  list(@CurrentUser() principal: AuthPrincipal, @Query('page') value?: string, @Query('search') search?: string, @Query('sortBy') sortBy?: string, @Query('sortDirection') direction?: string) {
    const page = Number(value || 1); if (!Number.isInteger(page) || page < 1 || page > 100000 || (search?.length || 0) > 100) throw new BadRequestException('Filter halaman tidak valid.');
    if (sortBy && !['size', 'createdAt', 'title'].includes(sortBy) || direction && !['asc', 'desc'].includes(direction)) throw new BadRequestException('Urutan tabel tidak valid.');
    return this.knowledge.list(principal, page, search?.trim(), sortBy as 'size' | 'createdAt' | 'title' | undefined, direction as 'asc' | 'desc' | undefined);
  }
  @Post() @Roles(Role.Admin, Role.Central) @Throttle({ default: { limit: 10, ttl: 60000 } })
  async upload(@Req() request: FastifyRequest, @CurrentUser() principal: AuthPrincipal) {
    const parts = request.parts({ limits: { fileSize: env.knowledgeMaxFileMb * 1024 * 1024, files: 1, fields: 1, fieldSize: 10000, parts: 2 } });
    let file: Buffer | undefined, filename = '', raw: unknown;
    for await (const part of parts) {
      if (part.type === 'file') { if (part.fieldname !== 'file') throw new BadRequestException('Field file tidak valid.'); file = await part.toBuffer(); filename = part.filename; }
      else { if (part.fieldname !== 'metadata') throw new BadRequestException('Field upload tidak valid.'); try { raw = JSON.parse(String(part.value)); } catch { throw new BadRequestException('Metadata tidak valid.'); } }
    }
    if (!file || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('File dan metadata wajib disertakan.');
    const metadata = plainToInstance(KnowledgeMetadataDto, raw);
    if ((await validate(metadata, { whitelist: true, forbidNonWhitelisted: true })).length) throw new BadRequestException('Judul, akses dokumen, atau metadata tidak valid.');
    return this.knowledge.upload(file, filename, metadata, principal);
  }
  @Post('search') @Header('Cache-Control', 'no-store')
  search(@Body() dto: KnowledgeSearchDto, @CurrentUser() principal: AuthPrincipal) { return this.knowledge.search(dto.query, principal); }
  @Get('branches') @Roles(Role.Admin, Role.Central)
  branches(@CurrentUser() principal: AuthPrincipal) { return this.knowledge.branches(principal); }
  @Get('processing') @Roles(Role.Admin, Role.Central)
  processing(@CurrentUser() principal: AuthPrincipal) { return this.knowledge.processing(principal); }
  @Post('processing/:id/retry') @Roles(Role.Admin, Role.Central)
  retry(@Param('id') id: string, @CurrentUser() principal: AuthPrincipal) { return this.knowledge.retryJob(id, principal); }
  @Get('memories') @Header('Cache-Control', 'no-store')
  memories(@CurrentUser() principal: AuthPrincipal, @Query('page') value?: string) { const page = Number(value || 1); if (!Number.isInteger(page) || page < 1 || page > 100000) throw new BadRequestException('Halaman tidak valid.'); return this.memory.list(principal, page); }
  @Post('memories')
  proposal(@Body() dto: MemoryProposalDto, @CurrentUser() principal: AuthPrincipal) { return this.memory.propose(dto.title, dto.text, principal); }
  @Post('memories/:id/approve') @Roles(Role.Admin, Role.Central)
  approve(@Param('id') id: string, @CurrentUser() principal: AuthPrincipal) { return this.memory.approve(id, principal); }
  @Patch('memories/:id') @Roles(Role.Admin, Role.Central)
  correct(@Param('id') id: string, @Body() dto: MemoryProposalDto, @CurrentUser() principal: AuthPrincipal) { return this.memory.correct(id, dto.title, dto.text, principal); }
  @Delete('memories/:id') @Roles(Role.Admin, Role.Central) @HttpCode(204)
  forget(@Param('id') id: string, @CurrentUser() principal: AuthPrincipal) { return this.memory.remove(id, principal); }
  @Get('learning') @Roles(Role.Admin, Role.Central)
  learningStatus() { return this.learning.status(); }
  @Post('learning/retry') @Roles(Role.Admin, Role.Central)
  retryLearning() { return this.learning.retryFailed(); }
  @Get(':id') @Header('Cache-Control', 'no-store')
  detail(@Param('id') id: string, @CurrentUser() principal: AuthPrincipal) { return this.knowledge.detail(id, principal); }
  @Get(':id/file') @Header('Cache-Control', 'no-store')
  async file(@Param('id') id: string, @CurrentUser() principal: AuthPrincipal, @Res() reply: FastifyReply) {
    const result = await this.knowledge.download(id, principal);
    reply.type(result.mime).header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`).header('X-Content-Type-Options', 'nosniff');
    return reply.send(result.stream);
  }
  @Patch(':id') @Roles(Role.Admin, Role.Central)
  publish(@Param('id') id: string, @Body() dto: KnowledgePatchDto, @CurrentUser() principal: AuthPrincipal) {
    if (!Object.values(dto).some(value => value !== undefined)) throw new BadRequestException('Tidak ada perubahan metadata.');
    return this.knowledge.patch(id, dto, principal);
  }
  @Post(':id/reindex') @Roles(Role.Admin, Role.Central)
  reindex(@Param('id') id: string, @CurrentUser() principal: AuthPrincipal) { return this.knowledge.reindex(id, principal); }
  @Delete(':id') @Roles(Role.Admin, Role.Central) @HttpCode(204)
  remove(@Param('id') id: string, @CurrentUser() principal: AuthPrincipal) { return this.knowledge.remove(id, principal); }
}
