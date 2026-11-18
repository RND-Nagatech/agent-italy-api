import { StockBaselineModule } from '../stock-baselines/stock-baseline.module';
import { BranchSalesService } from './branch-sales.service';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { AtomicDataService } from './atomic-data.service';
import { Module } from '@nestjs/common';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { NetworkRestockRecommendationService } from './network-restock-recommendation.service';
import { RestockRecommendationService } from './restock-recommendation.service';
import { SalesModule } from '../sales/sales.module';
import { SettingsModule } from '../settings/settings.module';
import { CleaningPriorityService } from './cleaning-priority.service';
import { StockoutRiskService } from './stockout-risk.service';
import { InventorySummaryService } from './inventory-summary.service';
import { AgentSessionsService } from './agent-sessions.service';
import { PriorityReviewReminderService } from './priority-review-reminder.service';
import { SourcesModule } from '../sources/sources.module';
import { AgentSkillsService } from './agent-skills.service';
import { AgentRunTracesService } from './agent-run-traces.service';
import { AgentHistoryService } from './agent-history.service';
import { AgentGatewayAuditModule } from './agent-gateway-audit.module';
import { TransactionReportService } from './transaction-report.service';
import { BankingService } from './banking.service';
import { BankStatementService } from './bank-statement.service';

@Module({
  imports: [SalesModule, SettingsModule, KnowledgeModule, StockBaselineModule, SourcesModule, AgentGatewayAuditModule],
  controllers: [AgentController],
  providers: [BranchSalesService, AtomicDataService, TransactionReportService, BankingService, BankStatementService, AgentService, AgentSessionsService, AgentRunTracesService, AgentHistoryService, AgentSkillsService, PriorityReviewReminderService, RestockRecommendationService, NetworkRestockRecommendationService, CleaningPriorityService, StockoutRiskService, InventorySummaryService],
})
export class AgentModule {}
