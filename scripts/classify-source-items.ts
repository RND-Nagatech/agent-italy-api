import { MongoClient, ObjectId } from 'mongodb';
import { env } from '../src/config/env';
import { inferItemCategory, ItemCategory } from '../src/sources/item-category';

type SourceRow = {
  _id: ObjectId;
  branchId?: string;
  alias?: string;
  sourceType?: string;
  itemCategory?: string;
};

async function main() {
  const apply = process.argv.includes('--apply');
  const client = new MongoClient(env.mongoUri, { maxPoolSize: 5, serverSelectionTimeoutMS: 8000 });
  await client.connect();

  try {
    const collection = client.db(env.systemDatabaseName).collection<SourceRow>('shipment_sources');
    const sources = await collection.find(
      { sourceType: { $ne: 'central' } },
      { projection: { branchId: 1, alias: 1, sourceType: 1, itemCategory: 1 } },
    ).toArray();
    const mapped = sources.map((source) => ({
      source,
      category: inferItemCategory(source.branchId),
    }));
    const changed = mapped.filter(({ source, category }) => source.itemCategory !== category);
    const grouped = (category: ItemCategory) => mapped
      .filter((item) => item.category === category)
      .map(({ source }) => `${source.branchId ?? 'tanpa ID'}${source.alias && source.alias !== source.branchId ? ` (${source.alias})` : ''}`)
      .sort((a, b) => a.localeCompare(b, 'id'));

    console.log(JSON.stringify({
      mode: apply ? 'apply' : 'dry-run',
      branchSources: sources.length,
      categoryX: grouped('X'),
      categoryBIASA: grouped('BIASA'),
      toUpdate: changed.length,
    }, null, 2));

    if (!apply || !changed.length) return;

    const now = new Date();
    const result = await collection.bulkWrite(changed.map(({ source, category }) => ({
      updateOne: {
        filter: { _id: source._id, sourceType: { $ne: 'central' } },
        update: { $set: { itemCategory: category, updatedAt: now } },
      },
    })), { ordered: true });
    console.log(JSON.stringify({ matched: result.matchedCount, updated: result.modifiedCount }));
  } finally {
    await client.close();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  console.error(`Branch category migration failed: ${message}`);
  process.exitCode = 1;
});
