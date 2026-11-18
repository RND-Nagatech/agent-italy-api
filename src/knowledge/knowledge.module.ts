import { MemoryLearningService } from './memory-learning.service';
import { Module } from '@nestjs/common';
import { KnowledgeService } from './knowledge.service';
import { SharedMemoryService } from './memory.service';
import { EmbeddingService } from './embedding.service';
import { KnowledgeVectorService } from './vector.service';
import { KnowledgeWorker } from './knowledge.worker';
import { KnowledgeController } from './knowledge.controller';
import { AgentGatewayAuditModule } from '../agent/agent-gateway-audit.module';
@Module({ imports: [AgentGatewayAuditModule], providers: [MemoryLearningService, KnowledgeService, SharedMemoryService, EmbeddingService, KnowledgeVectorService, KnowledgeWorker], controllers: [KnowledgeController], exports: [MemoryLearningService, KnowledgeService, SharedMemoryService, EmbeddingService] })
export class KnowledgeModule {}
