import { Injectable } from '@nestjs/common';
import { Document } from 'mongodb';
import { MongoService } from '../database/mongo.service';

export const AGENT_DETAIL_LEVELS = ['low', 'medium', 'high'] as const;
export const AGENT_LANGUAGE_STYLES = ['professional', 'formal', 'friendly', 'casual'] as const;

export type AgentDetailLevel = (typeof AGENT_DETAIL_LEVELS)[number];
export type AgentLanguageStyle = (typeof AGENT_LANGUAGE_STYLES)[number];

export interface AgentResponsePreferences {
  detailLevel: AgentDetailLevel;
  languageStyle: AgentLanguageStyle;
  updatedAt: Date | null;
}

interface AgentResponsePreferencesDocument extends Document {
  _id: 'agent-response-preferences';
  detailLevel: AgentDetailLevel;
  languageStyle: AgentLanguageStyle;
  updatedAt: Date;
  updatedBy: string;
}

const DEFAULT_PREFERENCES: AgentResponsePreferences = {
  detailLevel: 'medium',
  languageStyle: 'professional',
  updatedAt: null,
};

@Injectable()
export class AgentResponsePreferencesService {
  constructor(private readonly mongo: MongoService) {}

  async get(): Promise<AgentResponsePreferences> {
    const saved = await this.collection.findOne(
      { _id: 'agent-response-preferences' },
      { projection: { detailLevel: 1, languageStyle: 1, updatedAt: 1 } },
    );

    return {
      detailLevel: isDetailLevel(saved?.detailLevel) ? saved.detailLevel : DEFAULT_PREFERENCES.detailLevel,
      languageStyle: isLanguageStyle(saved?.languageStyle) ? saved.languageStyle : DEFAULT_PREFERENCES.languageStyle,
      updatedAt: saved?.updatedAt ?? null,
    };
  }

  async update(detailLevel: AgentDetailLevel, languageStyle: AgentLanguageStyle, updatedBy: string): Promise<AgentResponsePreferences> {
    const updatedAt = new Date();
    await this.collection.updateOne(
      { _id: 'agent-response-preferences' },
      { $set: { detailLevel, languageStyle, updatedAt, updatedBy } },
      { upsert: true },
    );
    return { detailLevel, languageStyle, updatedAt };
  }

  private get collection() {
    return this.mongo.db.collection<AgentResponsePreferencesDocument>('app_settings');
  }
}

function isDetailLevel(value: unknown): value is AgentDetailLevel {
  return typeof value === 'string' && (AGENT_DETAIL_LEVELS as readonly string[]).includes(value);
}

function isLanguageStyle(value: unknown): value is AgentLanguageStyle {
  return typeof value === 'string' && (AGENT_LANGUAGE_STYLES as readonly string[]).includes(value);
}
