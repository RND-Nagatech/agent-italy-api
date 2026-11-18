import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { UserSettingsService } from './user-settings.service';
import { CleaningPrioritySettingsService } from './cleaning-priority-settings.service';
import { NetworkRestockSettingsService } from './network-restock-settings.service';
import { AgentResponsePreferencesService } from './agent-response-preferences.service';

@Module({
  controllers: [SettingsController],
  providers: [UserSettingsService, CleaningPrioritySettingsService, NetworkRestockSettingsService, AgentResponsePreferencesService],
  exports: [CleaningPrioritySettingsService, NetworkRestockSettingsService, AgentResponsePreferencesService],
})
export class SettingsModule {}
