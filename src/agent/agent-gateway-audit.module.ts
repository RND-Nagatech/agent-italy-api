import { Module } from '@nestjs/common';
import { AgentGatewayAuditService } from './agent-gateway-audit.service';

@Module({ providers: [AgentGatewayAuditService], exports: [AgentGatewayAuditService] })
export class AgentGatewayAuditModule {}
