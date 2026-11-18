import { IsIn } from 'class-validator';
import { AGENT_DETAIL_LEVELS, AGENT_LANGUAGE_STYLES } from '../agent-response-preferences.service';

export class UpdateAgentResponsePreferencesDto {
  @IsIn(AGENT_DETAIL_LEVELS)
  detailLevel!: (typeof AGENT_DETAIL_LEVELS)[number];

  @IsIn(AGENT_LANGUAGE_STYLES)
  languageStyle!: (typeof AGENT_LANGUAGE_STYLES)[number];
}
