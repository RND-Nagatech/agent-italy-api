import { Injectable } from '@nestjs/common';
import { Collection } from 'mongodb';
import { MongoService } from '../database/mongo.service';

type PriorityReviewReminderDocument = {
  _id: string;
  userId: string;
  weekKey: string;
  dueAt: string;
  createdAt: Date;
  acknowledgedAt?: Date;
  supersededAt?: Date;
};

export type PriorityReviewReminderState = {
  due: boolean;
  weekKey?: string;
  dueAt?: string;
  nextReminderAt: string;
};

@Injectable()
export class PriorityReviewReminderService {
  constructor(private readonly mongo: MongoService) {}

  private get reminders(): Collection<PriorityReviewReminderDocument> {
    return this.mongo.db.collection<PriorityReviewReminderDocument>('agent_priority_review_reminders');
  }

  async getState(userId: string, now = new Date()): Promise<PriorityReviewReminderState> {
    const schedule = mondaySchedule(now);
    if (schedule.due) {
      const id = `${userId}:${schedule.weekKey}`;
      try {
        await this.reminders.updateOne(
          { _id: id },
          { $setOnInsert: { _id: id, userId, weekKey: schedule.weekKey, dueAt: schedule.dueAt, createdAt: now } },
          { upsert: true },
        );
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }
      await this.reminders.updateMany(
        { userId, weekKey: { $lt: schedule.weekKey }, acknowledgedAt: { $exists: false }, supersededAt: { $exists: false } },
        { $set: { supersededAt: now } },
      );
    }

    const pending = await this.reminders.findOne(
      { userId, acknowledgedAt: { $exists: false }, supersededAt: { $exists: false } },
      { sort: { weekKey: -1 } },
    );
    if (pending) return { due: true, weekKey: pending.weekKey, dueAt: pending.dueAt, nextReminderAt: schedule.nextReminderAt };
    return { due: false, nextReminderAt: schedule.nextReminderAt };
  }

  async acknowledge(userId: string, now = new Date()): Promise<PriorityReviewReminderState> {
    const state = await this.getState(userId, now);
    if (!state.due || !state.weekKey) return state;
    await this.reminders.updateOne(
      { _id: `${userId}:${state.weekKey}`, userId, acknowledgedAt: { $exists: false } },
      { $set: { acknowledgedAt: now } },
    );
    return this.getState(userId, now);
  }
}

function mondaySchedule(now: Date): { weekKey: string; due: boolean; dueAt: string; nextReminderAt: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  const localDate = Date.UTC(year, month - 1, day);
  const mondayOffset = (new Date(localDate).getUTCDay() + 6) % 7;
  const monday = localDate - mondayOffset * 86_400_000;
  const weekKey = new Date(monday).toISOString().slice(0, 10);
  const dueAt = `${weekKey}T10:00:00+07:00`;
  const minuteOfDay = Number(values.hour) * 60 + Number(values.minute);
  const due = mondayOffset > 0 || minuteOfDay >= 10 * 60;
  const nextMonday = monday + (due ? 7 : 0) * 86_400_000;
  const nextReminderAt = `${new Date(nextMonday).toISOString().slice(0, 10)}T10:00:00+07:00`;
  return { weekKey, due, dueAt, nextReminderAt };
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}
