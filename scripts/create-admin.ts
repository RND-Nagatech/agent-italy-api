import 'dotenv/config';
import * as argon2 from 'argon2';
import { isEmail } from 'class-validator';
import { ObjectId, MongoClient } from 'mongodb';
import { env } from '../src/config/env';
import { ensureMongoIndexes } from '../src/database/mongo-indexes';
import { Role } from '../src/users/roles';
import { UserDocument } from '../src/users/user.types';

async function main(): Promise<void> {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase() || "rnd@nagatech.id";
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD || "112233445566";
  const name = process.env.BOOTSTRAP_ADMIN_NAME?.trim() || 'Administrator';
  if (!email || !password) {
    throw new Error('Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD for this command');
  }
  if (!isEmail(email)) throw new Error('BOOTSTRAP_ADMIN_EMAIL must be a valid email address');
  if (password.length < 12 || password.length > 128) {
    throw new Error('Bootstrap password must contain between 12 and 128 characters');
  }
  if (name.length < 2 || name.length > 100) {
    throw new Error('BOOTSTRAP_ADMIN_NAME must contain between 2 and 100 characters');
  }

  const client = new MongoClient(env.mongoUri, {
    appName: 'italy-admin-bootstrap',
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 8_000,
    connectTimeoutMS: 8_000,
    retryWrites: true,
    w: 'majority',
  });

  try {
    await client.connect();
    const db = client.db(env.systemDatabaseName);
    await ensureMongoIndexes(db);
    const users = db.collection<UserDocument>('users');
    const activeAdmin = await users.findOne({ role: Role.Admin, active: true }, { projection: { _id: 1 } });
    if (activeAdmin) throw new Error('An active admin already exists; bootstrap was not applied');

    const now = new Date();
    await users.insertOne({
      _id: new ObjectId(),
      name,
      email,
      passwordHash: await argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 19_456,
        timeCost: 2,
        parallelism: 1,
      }),
      role: Role.Admin,
      branchId: null,
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    process.stdout.write(`Created initial admin account for ${email}\n`);
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unexpected bootstrap error';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
