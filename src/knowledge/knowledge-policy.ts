import { ForbiddenException } from '@nestjs/common';
import { Document } from 'mongodb';
import { AuthPrincipal } from '../users/user.types';
import { Role } from '../users/roles';
export function canManageKnowledge(principal: AuthPrincipal) { return principal.role === Role.Admin || principal.role === Role.Central; }
export function requireKnowledgeManager(principal: AuthPrincipal) { if (!canManageKnowledge(principal)) throw new ForbiddenException('Knowledge hanya dapat dikelola Admin dan Pusat.'); }
export function readableKnowledge(principal: AuthPrincipal): Document {
  const base: Document = { deleted: false, active: true, status: 'ready' };
  if (canManageKnowledge(principal)) return base;
  return { ...base, $or: [{ visibility: 'global' }, { visibility: 'branches', branchIds: principal.branchId || '__no_branch__' }] };
}
export function visibleKnowledge(principal: AuthPrincipal): Document { return canManageKnowledge(principal) ? { deleted: false } : readableKnowledge(principal); }
