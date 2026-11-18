import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ObjectId } from 'mongodb';
import { MongoService } from '../database/mongo.service';
import { AuthPrincipal } from '../users/user.types';
import { CreateAgentSkillDto, UpdateAgentSkillDto } from './dto/agent-skill.dto';

export type AgentSkillDocument = {
  _id: ObjectId;
  name: string;
  description: string;
  triggerKeywords: string[];
  roles: Array<'admin' | 'pusat' | 'cabang'>;
  instructions: string;
  alwaysApply: boolean;
  enabled: boolean;
  version: number;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
};

export type AgentPromptSkill = { id: string; name: string; version: number; instructions: string };

@Injectable()
export class AgentSkillsService {
  private readonly logger = new Logger(AgentSkillsService.name);

  constructor(private readonly mongo: MongoService) {}

  async list() {
    const items = await this.mongo.db.collection<AgentSkillDocument>('agent_skills')
      .find({})
      .sort({ enabled: -1, updatedAt: -1, name: 1 })
      .limit(200)
      .toArray();
    return { items: items.map(item => this.toPublic(item)) };
  }

  async create(dto: CreateAgentSkillDto, principal: AuthPrincipal) {
    const now = new Date();
    const item: AgentSkillDocument = {
      _id: new ObjectId(),
      name: cleanText(dto.name),
      description: cleanText(dto.description),
      triggerKeywords: cleanKeywords(dto.triggerKeywords),
      roles: [...new Set(dto.roles)],
      instructions: cleanText(dto.instructions),
      alwaysApply: dto.alwaysApply,
      enabled: dto.enabled,
      version: 1,
      createdBy: principal.sub,
      updatedBy: principal.sub,
      createdAt: now,
      updatedAt: now,
    };
    if (!item.alwaysApply && !item.triggerKeywords.length) {
      throw new BadRequestException('Tambahkan kata pemicu atau aktifkan penerapan untuk semua pertanyaan.');
    }
    await this.mongo.db.collection<AgentSkillDocument>('agent_skills').insertOne(item);
    return this.toPublic(item);
  }

  async update(id: string, dto: UpdateAgentSkillDto, principal: AuthPrincipal) {
    const skillId = this.parseId(id);
    const collection = this.mongo.db.collection<AgentSkillDocument>('agent_skills');
    const current = await collection.findOne({ _id: skillId });
    if (!current) throw new NotFoundException('Skill Agent tidak ditemukan.');
    const next = {
      ...current,
      ...(dto.name !== undefined ? { name: cleanText(dto.name) } : {}),
      ...(dto.description !== undefined ? { description: cleanText(dto.description) } : {}),
      ...(dto.triggerKeywords !== undefined ? { triggerKeywords: cleanKeywords(dto.triggerKeywords) } : {}),
      ...(dto.roles !== undefined ? { roles: [...new Set(dto.roles)] } : {}),
      ...(dto.instructions !== undefined ? { instructions: cleanText(dto.instructions) } : {}),
      ...(dto.alwaysApply !== undefined ? { alwaysApply: dto.alwaysApply } : {}),
      ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
    };
    if (!next.alwaysApply && !next.triggerKeywords.length) {
      throw new BadRequestException('Tambahkan kata pemicu atau aktifkan penerapan untuk semua pertanyaan.');
    }
    const now = new Date();
    await collection.updateOne({ _id: skillId, version: current.version }, {
      $set: { ...next, updatedAt: now, updatedBy: principal.sub, version: current.version + 1 },
    });
    const updated = await collection.findOne({ _id: skillId });
    if (!updated) throw new NotFoundException('Skill Agent tidak ditemukan.');
    return this.toPublic(updated);
  }

  async remove(id: string): Promise<void> {
    const result = await this.mongo.db.collection<AgentSkillDocument>('agent_skills').deleteOne({ _id: this.parseId(id) });
    if (!result.deletedCount) throw new NotFoundException('Skill Agent tidak ditemukan.');
  }

  async match(question: string, role: AuthPrincipal['role']): Promise<AgentPromptSkill[]> {
    try {
      const skills = await this.mongo.db.collection<AgentSkillDocument>('agent_skills')
        .find({ enabled: true, roles: role })
        .sort({ alwaysApply: -1, updatedAt: -1 })
        .limit(100)
        .toArray();
      const normalizedQuestion = normalize(question);
      const paddedQuestion = ` ${normalizedQuestion} `;
      const matched = skills.filter(skill => skill.alwaysApply || skill.triggerKeywords.some(keyword => {
        const normalizedKeyword = normalize(keyword);
        return normalizedKeyword.length > 0 && paddedQuestion.includes(` ${normalizedKeyword} `);
      }));
      const selected: AgentPromptSkill[] = [];
      let characterCount = 0;
      for (const skill of matched) {
        const entry = { id: skill._id.toHexString(), name: skill.name, version: skill.version, instructions: skill.instructions };
        const size = entry.name.length + entry.instructions.length;
        if (selected.length >= 5 || characterCount + size > 10_000) break;
        selected.push(entry);
        characterCount += size;
      }
      return selected;
    } catch {
      this.logger.warn('Skill Admin tidak dapat dimuat; Agent melanjutkan dengan panduan bawaan.');
      return [];
    }
  }

  private parseId(value: string): ObjectId {
    if (!ObjectId.isValid(value)) throw new NotFoundException('Skill Agent tidak ditemukan.');
    return new ObjectId(value);
  }

  private toPublic(skill: AgentSkillDocument) {
    return {
      id: skill._id.toHexString(),
      name: skill.name,
      description: skill.description,
      triggerKeywords: skill.triggerKeywords,
      roles: skill.roles,
      instructions: skill.instructions,
      alwaysApply: skill.alwaysApply,
      enabled: skill.enabled,
      version: skill.version,
      createdAt: skill.createdAt,
      updatedAt: skill.updatedAt,
    };
  }
}

function cleanText(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

function cleanKeywords(values: string[]): string[] {
  return [...new Set(values.map(value => cleanText(value).slice(0, 64)).filter(value => value.length >= 2))].slice(0, 12);
}

function normalize(value: string): string {
  return value.toLocaleLowerCase('id-ID').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
