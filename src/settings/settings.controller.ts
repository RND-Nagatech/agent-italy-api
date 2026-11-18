import { Body, Controller, Get, Header, Patch } from '@nestjs/common';
import { CurrentUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import { Role } from '../users/roles';
import { AuthPrincipal } from '../users/user.types';
import { UpdateCleaningPrioritySettingsDto } from './dto/update-cleaning-priority-settings.dto';
import { UpdateNetworkRestockSettingsDto } from './dto/update-network-restock-settings.dto';
import { UpdateUserSettingsDto } from './dto/update-user-settings.dto';
import { UpdateAgentResponsePreferencesDto } from './dto/update-agent-response-preferences.dto';
import { AgentResponsePreferencesService } from './agent-response-preferences.service';
import { CleaningPrioritySettingsService } from './cleaning-priority-settings.service';
import { NetworkRestockSettingsService } from './network-restock-settings.service';
import { UserSettingsService } from './user-settings.service';

@Controller('settings')
@Roles(Role.Admin, Role.Central, Role.Branch)
export class SettingsController {
  constructor(
    private readonly settings: UserSettingsService,
    private readonly cleaningSettings: CleaningPrioritySettingsService,
    private readonly networkRestockSettings: NetworkRestockSettingsService,
    private readonly agentResponsePreferences: AgentResponsePreferencesService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  get(@CurrentUser() principal: AuthPrincipal) {
    return this.settings.get(principal.sub);
  }

  @Patch()
  @Header('Cache-Control', 'no-store')
  update(@CurrentUser() principal: AuthPrincipal, @Body() dto: UpdateUserSettingsDto) {
    return this.settings.update(principal.sub, dto.shipmentDefaultPeriod);
  }

  @Get('agent-response')
  @Roles(Role.Admin)
  @Header('Cache-Control', 'no-store')
  getAgentResponsePreferences() {
    return this.agentResponsePreferences.get();
  }

  @Patch('agent-response')
  @Roles(Role.Admin)
  @Header('Cache-Control', 'no-store')
  updateAgentResponsePreferences(@CurrentUser() principal: AuthPrincipal, @Body() dto: UpdateAgentResponsePreferencesDto) {
    return this.agentResponsePreferences.update(dto.detailLevel, dto.languageStyle, principal.sub);
  }

  @Get('cleaning-minimum-stocks')
  @Roles(Role.Admin, Role.Central)
  @Header('Cache-Control', 'no-store')
  getCleaningMinimumStocks() {
    return this.cleaningSettings.get();
  }

  @Patch('cleaning-minimum-stocks')
  @Roles(Role.Admin, Role.Central)
  @Header('Cache-Control', 'no-store')
  updateCleaningMinimumStocks(@Body() dto: UpdateCleaningPrioritySettingsDto) {
    return this.cleaningSettings.update(dto.items);
  }

  @Get('network-restock')
  @Roles(Role.Admin, Role.Central)
  @Header('Cache-Control', 'no-store')
  getNetworkRestockSettings() {
    return this.networkRestockSettings.get();
  }

  @Patch('network-restock')
  @Roles(Role.Admin, Role.Central)
  @Header('Cache-Control', 'no-store')
  updateNetworkRestockSettings(@Body() dto: UpdateNetworkRestockSettingsDto) {
    return this.networkRestockSettings.update(dto.safeStockDays, dto.fulfillmentMethod);
  }
}
