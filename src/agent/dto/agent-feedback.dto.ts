import { IsIn, IsOptional } from 'class-validator';

export const AGENT_FEEDBACK_CATEGORIES = ['incorrect', 'incomplete', 'unclear', 'wrong-analysis', 'other'] as const;
const ratings = ['helpful', 'needs-improvement'] as const;

export class AgentFeedbackDto {
  @IsIn(ratings)
  rating!: (typeof ratings)[number];

  @IsOptional()
  @IsIn(AGENT_FEEDBACK_CATEGORIES)
  category?: (typeof AGENT_FEEDBACK_CATEGORIES)[number];
}
