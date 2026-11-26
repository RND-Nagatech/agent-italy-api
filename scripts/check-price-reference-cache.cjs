process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017'; process.env.SYSTEM_DATABASE_NAME = 'offline_cache';
process.env.JWT_ACCESS_SECRET = 'offline-cache-test-secret-at-least-32-characters'; process.env.DEEPSEEK_API_KEY = 'offline-model';
for (const key of ['RDS_URLDB_API', 'RDS_DB_NAME', 'RDS_USERNAME', 'RDS_PASSWORD']) process.env[key] = '';
const assert = require('node:assert/strict');
const { withPriceCache } = require('./price-cache-fixture.cjs');
const { PriceReferenceService, PRICE_REFERENCE_PARSER_VERSION } = require('../dist/src/agent/price-reference.service');
const { auditBuybackBatches } = require('../dist/src/agent/buyback-audit.logic');
const cache = new Map(), saved = new Map(); let nextId = 0, providerCalls = 0;
const storage = withPriceCache({ db: { collection(name) { assert.equal(name, 'agent_price_references'); return { async updateOne(query, update) { saved.set(query.id, structuredClone(update.$set)); } }; } } }, cache);
const sessions = { async uploadPriceAttachment(_session, _owner, _buffer, filename) { return { id: (++nextId).toString(16).padStart(24, '0'), filename, mime: 'image/png' }; }, async deleteAttachment() {} };
const audit = { async resolveActorEmail() { return ''; }, async begin() { return 'fixture'; }, async finish() {} };
const service = () => new PriceReferenceService(storage, sessions, audit);
const room = '000000000000000000000001';
const page = lower => ({ isJewelryPrice: true, date: '2026-11-23', batch: 2, effectiveFrom: '12:00', complete: true, warnings: [], buybackRows: [{ family: 'old', sourceCode: 'C4', sourceLabel: 'STAR', printedKadar: '', goodThousands: 1539, scrapThousands: 1459, stoneMinThousands: lower, stoneMaxThousands: 1533 }] });
const response = data => new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(data)}}]}),{status:200});
const originalFetch = global.fetch;
const modelReply = require('./price-cell-fixture.cjs').withPriceCellVerification;
(async () => {
  global.fetch = modelReply(async (_url, options) => { providerCalls++; assert.match(JSON.parse(options.body).messages[0].content, /sourceCode:string,sourceLabel:string/); return response(page(providerCalls === 1 ? 1502 : 1396)); });
  const first = await service().upload(room,'owner',Buffer.from('identical-image'),'batch-2.png');
  const second = await service().upload(room,'owner',Buffer.from('identical-image'),'renamed-upload.png');
  assert.equal(providerCalls,1,'identical bytes reuse persisted extraction across service instances and attachment IDs');
  assert.notEqual(first.id,second.id); assert.equal(second.filename,'renamed-upload.png'); assert.deepEqual(first.rows,second.rows);
  assert.equal(saved.get(second.id).contentHash,saved.get(first.id).contentHash); assert.equal(saved.get(second.id).parserVersion,PRICE_REFERENCE_PARSER_VERSION);
  const tx = { id:'C4-example',kind:'buyback',store:'Italy',date:'2026-11-23',time:'13:10:46',invoice:'BB-example',name:'Gelang',internalCode:'C4',condition:'CUCI 16K / 17K',printedKadar:'750',pricePerGram:1474427,price:null,weight:37.54,fee:null,quantity:1,kadar:null,inputBy:'' };
  const results = [first,second].map(ref=>auditBuybackBatches(tx,[ref]));
  assert.ok(results.every(result=>result.minimum===1502000&&result.maximum===1539000&&result.status==='Di luar range acuan'));
  await service().upload(room,'owner',Buffer.from('changed-image'),'batch-2.png'); assert.equal(providerCalls,2,'same filename with changed bytes must be read');
  await service().upload(room,'other-owner',Buffer.from('identical-image'),'batch-2.png'); assert.equal(providerCalls,3,'no cache sharing across owners');
  await service().upload('000000000000000000000002','owner',Buffer.from('identical-image'),'batch-2.png'); assert.equal(providerCalls,4,'no cache sharing across rooms');
  let arrivals=0, unblock; const gate=new Promise(resolve=>unblock=resolve);
  global.fetch = modelReply(async () => { const lower=++arrivals===1?1502:1396; if(arrivals===2)unblock(); await gate; return response(page(lower)); });
  const parallel=await Promise.all([service().upload(room,'owner',Buffer.from('parallel-image'),'one.png'),service().upload(room,'owner',Buffer.from('parallel-image'),'two.png')]);
  assert.equal(arrivals,2);assert.deepEqual(parallel[0].rows,parallel[1].rows,'atomic insert returns one canonical result even when concurrent model responses differ');
  const bad=page(1502);delete bad.buybackRows[0].sourceLabel;global.fetch=modelReply(async()=>response(bad));
  await assert.rejects(()=>service().upload(room,'owner',Buffer.from('missing-label'),'bad.png'),error=>error.getStatus()===502);
  global.fetch=modelReply(async()=>response(page(1502)));const recovered=await service().upload(room,'owner',Buffer.from('missing-label'),'recovered.png');
  assert.equal(recovered.rows[0].sourceLabel,'STAR','failed reads are not cached and can be retried');
  const verifiedCells = [
    {condition:'GOOD',fromRow:0,toRow:0,rateThousands:1539,maxRateThousands:null},
    {condition:'SCRAP',fromRow:0,toRow:0,rateThousands:1459,maxRateThousands:null},
    {condition:'STONE',fromRow:0,toRow:0,rateThousands:1502,maxRateThousands:1533},
  ];
  let verifiedComplete = false;
  global.fetch = async (_url,options) => JSON.parse(options.body).messages[0].content.startsWith('VERIFY_BUYBACK_PRICE_CELLS')
    ? response({documents:[{tableIndex:0,complete:verifiedComplete,warnings:[],cells:verifiedCells}]}) : response(page(1396));
  await assert.rejects(()=>service().upload(room,'owner',Buffer.from('independent-geometry'),'uncertain.png'),error=>error.getStatus()===502,'unverified merged borders must not be cached or reported complete');
  verifiedComplete = true;
  const corrected = await service().upload(room,'owner',Buffer.from('independent-geometry'),'verified.png');
  assert.equal(corrected.rows.find(row=>row.condition==='STONE').rate,1502000,'independent physical cells replace an upper-block spill from the first pass');
  global.fetch = async () => { throw new Error('a verified identical file must use the cache'); };
  const repeated = await service().upload(room,'owner',Buffer.from('independent-geometry'),'verified-again.png');
  assert.deepEqual(repeated.rows,corrected.rows);
  console.log('Price content cache passed: byte identity, owner/room isolation, versioned hashes, required labels, changed files, retries, concurrent canonical reads and stable C4 outcomes.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{global.fetch=originalFetch;});
