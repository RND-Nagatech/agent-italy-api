import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Db, MongoClient } from 'mongodb';
import { env } from '../config/env';
import { ensureMongoIndexes } from './mongo-indexes';

@Injectable()
export class MongoService implements OnModuleInit, OnModuleDestroy {
  private readonly client = new MongoClient(env.mongoUri, {
    appName: 'pantes-tracking-api',
    maxPoolSize: env.mongoMaxPoolSize,
    serverSelectionTimeoutMS: 8_000,
    connectTimeoutMS: 8_000,
    socketTimeoutMS: 60_000,
    retryWrites: true,
    w: 'majority',
  });

  private database?: Db;

  async onModuleInit(): Promise<void> {
    await this.client.connect();
    this.database = this.client.db(env.systemDatabaseName);
    await ensureMongoIndexes(this.database);
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.close();
  }

  get db(): Db {
    if (!this.database) {
      throw new Error('MongoDB is not connected');
    }
    return this.database;
  }

  getDatabase(databaseName: string): Db {
    if (!/^[a-zA-Z0-9_-]{1,63}$/.test(databaseName)) {
      throw new Error('Invalid MongoDB database name');
    }
    return this.client.db(databaseName);
  }

  get mongoClient(): MongoClient {
    return this.client;
  }
}
