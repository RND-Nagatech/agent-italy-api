import { BranchSalesDto } from './dto/branch-sales.dto';
import { AtomicReadDto } from './dto/atomic-read.dto';
import type { AtomicKind } from './atomic-data.service';
import { Body, Controller, Delete, Get, Header, HttpCode, Param, Patch, Post, Query, ForbiddenException, BadRequestException, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import { AuthPrincipal } from '../users/user.types';
import { Role } from '../users/roles';
import { AgentChatDto } from './dto/agent-chat.dto';
import { NetworkRestockDto } from './dto/network-restock.dto';
import { StockoutRiskDto } from './dto/stockout-risk.dto';
import { AgentService } from './agent.service';
import { AgentSessionsService } from './agent-sessions.service';
import { PriorityReviewReminderService } from './priority-review-reminder.service';
import { AgentSkillsService } from './agent-skills.service';
import { AgentRunTracesService } from './agent-run-traces.service';
import { CreateAgentSkillDto, UpdateAgentSkillDto } from './dto/agent-skill.dto';
import { AgentFeedbackDto } from './dto/agent-feedback.dto';
import { AgentHistoryService } from './agent-history.service';
import { AgentGatewayAuditService } from './agent-gateway-audit.service';
import { env } from '../config/env';
import { BankingScopeDto } from './dto/banking.dto';

@Controller('agent')
@Roles(Role.Admin, Role.Central, Role.Branch)
export class AgentController {
  constructor(
    private readonly agent: AgentService,
    private readonly sessions: AgentSessionsService,
    private readonly priorityReviewReminder: PriorityReviewReminderService,
    private readonly skills: AgentSkillsService,
    private readonly traces: AgentRunTracesService,
    private readonly history: AgentHistoryService,
    private readonly gatewayAudit: AgentGatewayAuditService,
  ) {}

  @Get('gateway-audit')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 60, ttl: 60_000, getTracker: agentUserTracker } })
  gatewayAuditList(
    @CurrentUser() principal: AuthPrincipal,
    @Query('limit') limitValue?: string,
    @Query('cursor') cursor?: string,
    @Query('requestId') requestId?: string,
    @Query('sessionId') sessionId?: string,
  ) {
    const limit = limitValue === undefined ? 25 : Number(limitValue);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('Jumlah audit per halaman harus 1–100.');
    if (requestId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
      throw new BadRequestException('ID request audit tidak valid.');
    }
    if (sessionId && !/^[0-9a-f]{24}$/i.test(sessionId)) throw new BadRequestException('ID room audit tidak valid.');
    return this.gatewayAudit.list(principal.sub, { limit, cursor, requestId, sessionId });
  }

  @Get('gateway-audit/:id')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 30, ttl: 60_000, getTracker: agentUserTracker } })
  gatewayAuditDetail(@Param('id') id: string, @CurrentUser() principal: AuthPrincipal) {
    return this.gatewayAudit.get(principal.sub, id);
  }

  @Get('priority-review-reminder')
  @Roles(Role.Admin)
  @Header('Cache-Control', 'no-store')
  priorityReviewReminderState(@CurrentUser() principal: AuthPrincipal) {
    return this.priorityReviewReminder.getState(principal.sub);
  }

  @Post('priority-review-reminder/acknowledge')
  @Roles(Role.Admin)
  @Header('Cache-Control', 'no-store')
  acknowledgePriorityReviewReminder(@CurrentUser() principal: AuthPrincipal) {
    return this.priorityReviewReminder.acknowledge(principal.sub);
  }

  @Post('sales/branches') @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 10, ttl: 60_000, getTracker: agentUserTracker } })
  branchSales(@Body() dto: BranchSalesDto, @CurrentUser() principal: AuthPrincipal) { return this.agent.branchSales(false, dto, principal); }

  @Post('sales/salespeople') @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 10, ttl: 60_000, getTracker: agentUserTracker } })
  salespeople(@Body() dto: BranchSalesDto, @CurrentUser() principal: AuthPrincipal) { return this.agent.branchSales(true, dto, principal); }

  @Post('data/:kind')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 10, ttl: 60_000, getTracker: agentUserTracker } })
  atomicData(@Param('kind') kind: AtomicKind, @Body() dto: AtomicReadDto, @CurrentUser() principal: AuthPrincipal) {
    return this.agent.atomicRead(kind, dto, principal);
  }

  @Get('status')
  @Header('Cache-Control', 'no-store')
  status(@CurrentUser() principal: AuthPrincipal) {
    return this.agent.status(principal);
  }

  @Post('banking/scope')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 12, ttl: 60_000, getTracker: agentUserTracker } })
  bankingScope(@Body() dto: BankingScopeDto, @CurrentUser() principal: AuthPrincipal) {
    return this.agent.bankingScope(dto, principal);
  }

  @Get('skills')
  @Roles(Role.Admin)
  @Header('Cache-Control', 'no-store')
  listSkills() {
    return this.skills.list();
  }

  @Post('skills')
  @Roles(Role.Admin)
  @Header('Cache-Control', 'no-store')
  createSkill(@Body() dto: CreateAgentSkillDto, @CurrentUser() principal: AuthPrincipal) {
    return this.skills.create(dto, principal);
  }

  @Patch('skills/:id')
  @Roles(Role.Admin)
  @Header('Cache-Control', 'no-store')
  updateSkill(@Param('id') id: string, @Body() dto: UpdateAgentSkillDto, @CurrentUser() principal: AuthPrincipal) {
    return this.skills.update(id, dto, principal);
  }

  @Delete('skills/:id')
  @Roles(Role.Admin)
  @HttpCode(204)
  removeSkill(@Param('id') id: string) {
    return this.skills.remove(id);
  }

  @Get('traces')
  @Roles(Role.Admin)
  @Header('Cache-Control', 'no-store')
  listTraces(@Query('days') daysValue?: string, @Query('page') pageValue?: string, @Query('pageSize') pageSizeValue?: string, @Query('rating') rating?: string) {
    const days = Number(daysValue ?? 30);
    const page = Number(pageValue ?? 1);
    const pageSize = Number(pageSizeValue ?? 25);
    const selectedRating = rating ?? 'all';
    if (![7, 30, 90].includes(days) || !Number.isInteger(page) || page < 1 || page > 100000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 || !['all', 'helpful', 'needs-improvement', 'unrated'].includes(selectedRating)) {
      throw new BadRequestException('Filter jejak Agent tidak valid.');
    }
    return this.traces.list(days, page, pageSize, selectedRating);
  }

  @Post('chat/:requestId/feedback')
  @Header('Cache-Control', 'no-store')
  feedback(@Param('requestId') requestId: string, @Body() dto: AgentFeedbackDto, @CurrentUser() principal: AuthPrincipal) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new BadRequestException('ID jawaban Agent tidak valid.');
    return this.traces.feedback(requestId, principal, dto);
  }

  @Get('sessions')
  @Header('Cache-Control', 'no-store')
  listSessions(@CurrentUser() principal: AuthPrincipal) {
    return this.sessions.list(principal.sub);
  }

  @Get('history/search')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 30, ttl: 60_000, getTracker: agentUserTracker } })
  searchHistory(@Query('q') query: string, @Query('limit') limitValue: string | undefined, @CurrentUser() principal: AuthPrincipal) {
    const limit = limitValue === undefined ? 10 : Number(limitValue);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new BadRequestException('Jumlah hasil pencarian harus 1–20.');
    return this.history.search(principal.sub, query ?? '', limit);
  }

  @Post('sessions')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 20, ttl: 60_000, getTracker: agentUserTracker } })
  createSession(@CurrentUser() principal: AuthPrincipal) {
    return this.sessions.create(principal.sub);
  }

  @Delete('sessions/:sessionId')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 20, ttl: 60_000, getTracker: agentUserTracker } })
  deleteSession(@Param('sessionId') sessionId: string, @CurrentUser() principal: AuthPrincipal, @Query('forgetMemories') forget?: string) {
    if (forget !== undefined && forget !== '1') throw new BadRequestException('Opsi memory tidak valid.');
    if (forget === '1' && principal.role !== Role.Admin && principal.role !== Role.Central) throw new ForbiddenException('Penghapusan memory bersama hanya untuk Admin/Pusat.');
    return this.sessions.delete(sessionId, principal.sub, forget === '1');
  }

  @Get('sessions/:sessionId')
  @Header('Cache-Control', 'no-store')
  getSession(@Param('sessionId') sessionId: string, @CurrentUser() principal: AuthPrincipal) {
    return this.sessions.get(sessionId, principal.sub);
  }

  @Post('sessions/:sessionId/attachments')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 12, ttl: 60_000, getTracker: agentUserTracker } })
  async uploadAttachment(@Param('sessionId') sessionId: string, @Req() request: FastifyRequest, @CurrentUser() principal: AuthPrincipal) {
    let part: MultipartFile | undefined;
    try { part = await request.file({ limits: { fileSize: Math.min(20, env.knowledgeMaxFileMb) * 1024 * 1024 } }); }
    catch { throw new BadRequestException('File terlalu besar atau tidak dapat dibaca.'); }
    if (!part || part.fieldname !== 'file') throw new BadRequestException('Pilih satu file untuk diunggah.');
    let buffer: Buffer;
    try { buffer = await part.toBuffer(); }
    catch { throw new BadRequestException(`Ukuran file maksimal ${Math.floor(Math.min(20, env.knowledgeMaxFileMb))} MB.`); }
    return this.sessions.uploadAttachment(sessionId, principal.sub, buffer, part.filename);
  }

  @Delete('sessions/:sessionId/attachments/:attachmentId')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  deleteAttachment(@Param('sessionId') sessionId: string, @Param('attachmentId') attachmentId: string, @CurrentUser() principal: AuthPrincipal) {
    return this.sessions.deleteAttachment(sessionId, principal.sub, attachmentId);
  }

  @Get('sessions/:sessionId/attachments/:attachmentId')
  @Header('Cache-Control', 'no-store')
  async attachmentFile(@Param('sessionId') sessionId: string, @Param('attachmentId') attachmentId: string, @CurrentUser() principal: AuthPrincipal, @Res() reply: FastifyReply) {
    const result = await this.sessions.attachmentFile(sessionId, principal.sub, attachmentId);
    reply.type(result.mime)
      .header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(result.filename)}`)
      .header('X-Content-Type-Options', 'nosniff');
    return reply.send(result.stream);
  }

  @Post('chat')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 10, ttl: 60_000, getTracker: agentUserTracker } })
  chat(@Body() dto: AgentChatDto, @CurrentUser() principal: AuthPrincipal) {
    return this.agent.chat(dto, principal);
  }

  @Post('network-restock')
  @Roles(Role.Admin, Role.Central)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 4, ttl: 60_000, getTracker: agentUserTracker } })
  networkRestock(@Body() dto: NetworkRestockDto, @CurrentUser() principal: AuthPrincipal) {
    return this.agent.networkRestock(dto, principal);
  }

  @Post('stockout-risk')
  @Roles(Role.Admin, Role.Central)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 4, ttl: 60_000, getTracker: agentUserTracker } })
  stockoutRisk(@Body() dto: StockoutRiskDto, @CurrentUser() principal: AuthPrincipal) {
    return this.agent.stockoutRisk(dto, principal);
  }

  @Get('inventory-summary')
  @Roles(Role.Admin, Role.Central)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 6, ttl: 60_000, getTracker: agentUserTracker } })
  inventorySummary(@CurrentUser() principal: AuthPrincipal) {
    return this.agent.inventorySummary(principal);
  }

  @Get('chat/:requestId/progress')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 120, ttl: 60_000, getTracker: agentUserTracker } })
  progress(@Param('requestId') requestId: string, @CurrentUser() principal: AuthPrincipal) {
    return this.agent.getChatProgress(requestId, principal);
  }
}

function agentUserTracker(request: Record<string, unknown>): string {
  const user = request.user;
  if (typeof user === 'object' && user !== null && 'sub' in user && typeof user.sub === 'string') {
    return `user:${user.sub}`;
  }
  return typeof request.ip === 'string' ? request.ip : 'unknown';
}
