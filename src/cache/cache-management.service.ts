import { Injectable, OnModuleInit } from '@nestjs/common';
import { Document } from 'mongodb';
import { MongoService } from '../database/mongo.service';

type CacheEntry = { value: unknown; expiresAt: number; bytes: number };
type CacheSettingsDocument = Document & { _id: 'shipment-cache'; ttlSeconds: number };
export type CacheFetchStatus = 'hit' | 'miss' | 'coalesced';

@Injectable()
export class CacheManagementService implements OnModuleInit {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private ttlSeconds = 60;
  private maxEntries = 250;
  private readonly maxBytes = 64 * 1024 * 1024;
  private currentBytes = 0;
  private hits = 0;
  private misses = 0;
  private coalesced = 0;
  private generation = 0;
  private readonly prefixGenerations = new Map<string, number>();
  private clearedAt: Date | null = null;

  constructor(private readonly mongo: MongoService) {}

  async onModuleInit(): Promise<void> {
    const settings = await this.settings.findOne(
      { _id: 'shipment-cache' },
      { projection: { ttlSeconds: 1 } },
    );
    if (settings && Number.isInteger(settings.ttlSeconds) && settings.ttlSeconds >= 5 && settings.ttlSeconds <= 3600) {
      this.ttlSeconds = settings.ttlSeconds;
    }
  }

  async getOrLoad<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const { value } = await this.getOrLoadWithStatus(key, loader);
    return value;
  }

  async getOrLoadWithStatus<T>(
    key: string,
    loader: () => Promise<T>,
  ): Promise<{ value: T; cacheStatus: CacheFetchStatus }> {
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      this.hits += 1;
      this.entries.delete(key);
      this.entries.set(key, cached);
      return { value: cached.value as T, cacheStatus: 'hit' };
    }
    if (cached) {
      this.currentBytes -= cached.bytes;
      this.entries.delete(key);
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      this.coalesced += 1;
      return { value: await pending as T, cacheStatus: 'coalesced' };
    }

    this.misses += 1;
    const generation = this.generation;
    const prefixGeneration = this.prefixGenerationFor(key);
    const task = loader().then((value) => {
      if (generation === this.generation && prefixGeneration === this.prefixGenerationFor(key) && this.ttlSeconds > 0) {
        this.store(key, value);
      }
      return value;
    });
    this.inFlight.set(key, task);
    try {
      return { value: await task, cacheStatus: 'miss' };
    } finally {
      if (this.inFlight.get(key) === task) this.inFlight.delete(key);
    }
  }

  getStats() {
    this.removeExpiredEntries();
    const approxBytes = this.currentBytes;
    const requests = this.hits + this.misses;
    return {
      ttlSeconds: this.ttlSeconds,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      entryCount: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      coalescedRequests: this.coalesced,
      hitRate: requests ? Number((this.hits / requests).toFixed(4)) : 0,
      approxBytes,
      clearedAt: this.clearedAt,
    };
  }

  clear(): void {
    this.entries.clear();
    this.currentBytes = 0;
    this.inFlight.clear();
    this.generation += 1;
    this.prefixGenerations.clear();
    this.clearedAt = new Date();
  }

  clearByPrefix(prefix: string): number {
    let clearedEntries = 0;
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(prefix)) continue;
      this.entries.delete(key);
      this.currentBytes -= entry.bytes;
      clearedEntries += 1;
    }
    for (const key of this.inFlight.keys()) {
      if (key.startsWith(prefix)) this.inFlight.delete(key);
    }
    this.prefixGenerations.set(prefix, (this.prefixGenerations.get(prefix) ?? 0) + 1);
    this.clearedAt = new Date();
    return clearedEntries;
  }

  async updateTtl(ttlSeconds: number) {
    await this.settings.updateOne(
      { _id: 'shipment-cache' },
      { $set: { ttlSeconds, updatedAt: new Date() } },
      { upsert: true },
    );
    this.ttlSeconds = ttlSeconds;
    this.clear();
    return this.getStats();
  }

  private get settings() {
    return this.mongo.db.collection<CacheSettingsDocument>('app_settings');
  }

  private prefixGenerationFor(key: string): string {
    return Array.from(this.prefixGenerations.entries())
      .filter(([prefix]) => key.startsWith(prefix))
      .map(([prefix, generation]) => `${prefix}:${generation}`)
      .sort()
      .join('|');
  }

  private store(key: string, value: unknown): void {
    let bytes = 0;
    try {
      bytes = Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
    } catch {
      bytes = 0;
    }
    const existing = this.entries.get(key);
    if (existing) this.currentBytes -= existing.bytes;
    this.entries.delete(key);
    if (bytes > this.maxBytes) return;
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlSeconds * 1000, bytes });
    this.currentBytes += bytes;
    while (this.entries.size > this.maxEntries || this.currentBytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldestEntry = this.entries.get(oldestKey);
      if (oldestEntry) this.currentBytes -= oldestEntry.bytes;
      this.entries.delete(oldestKey);
    }
  }

  private removeExpiredEntries(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.currentBytes -= entry.bytes;
        this.entries.delete(key);
      }
    }
  }
}
