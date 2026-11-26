process.env.DOTENV_CONFIG_PATH='/dev/null';process.env.MONGODB_URI='mongodb://127.0.0.1:27017';process.env.SYSTEM_DATABASE_NAME='bullion_marketplace_fixture';process.env.JWT_ACCESS_SECRET='offline-bullion-marketplace-fixture-secret';process.env.ENC_KEY_DEC='bullion-marketplace-key';process.env.DEEPSEEK_API_KEY='offline-model';
for(const key of ['RDS_URLDB_API','RDS_DB_NAME','RDS_USERNAME','RDS_PASSWORD'])process.env[key]='';
const assert=require('node:assert/strict');
const {PriceAuditService}=require('../dist/src/agent/price-audit.service');
const {PriceReferenceService}=require('../dist/src/agent/price-reference.service');
const {encryptBankField:enc}=require('../dist/src/agent/banking.logic');
const {withPriceCache}=require('./price-cache-fixture.cjs');
const date='2026-11-25';
const modelPage={isJewelryPrice:true,date,batch:1,effectiveFrom:'13:07:32',complete:true,warnings:[],rows:[],buybackRows:[],bullionRows:[
  {kind:'sales',priceBasis:'PER_GRAM',product:'ANTAM_YEAR',year:2026,weightGram:1,rateThousands:2497,sourceLabel:'ANTAM 2026'},
  {kind:'sales',priceBasis:'PER_GRAM',product:'UBS',year:null,weightGram:1,rateThousands:2234,sourceLabel:'UBS'},
  {kind:'sales',priceBasis:'PER_PIECE',product:'NAMED_PRODUCT',year:null,weightGram:0.5,rateThousands:1425,sourceLabel:'Gift'},
  {kind:'sales',priceBasis:'PER_PIECE',product:'NAMED_PRODUCT',year:null,weightGram:0.1,rateThousands:null,sourceLabel:'Micro Gold'},
]};
const originalFetch=global.fetch;let saved;
const storage=withPriceCache({db:{collection(){return {async updateOne(_query,update){saved=update.$set}}}}});
(async()=>{try{
  global.fetch=async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(modelPage)}}]}),{status:200});
  const parser=new PriceReferenceService(storage,{}, {async resolveActorEmail(){return ''},async begin(){return 'fixture'},async finish(){}});
  const reference=await parser.extract('100000000000000000000000','owner',Buffer.from('bullion sales fixture'),{id:'000000000000000000000001',filename:'sales-lm.png',mime:'image/png'});
  assert.equal(reference.rows.length,3);assert.equal(reference.rows.find(row=>row.sourceLabel==='Gift').rate,1425000);assert.equal(reference.rows.find(row=>row.sourceLabel==='Gift').bullionPriceBasis,'PER_PIECE');assert.equal(reference.unavailableBullion[0].sourceLabel,'Micro Gold');assert.equal(reference.unavailableBullion[0].kind,'sales');
  assert.equal(saved.unavailableBullion[0].sourceLabel,'Micro Gold');
  const sale=(id,name,weight,rate,extra={})=>({_id:id,no_faktur_jual:id,no_faktur_group_user:'GROUP',tgl_system:date,jam:enc('14:00:00'),kode_group:'LM',kode_dept:'LGM',kode_marketplace:'TIKTOK',nama_barang:enc(name),berat:enc(String(weight)),harga_gram:rate,harga_jual:1234567,ongkos:20000,lebih_bayar:0,qty:1,status_valid:'DONE',status_kembali:'OPEN',...extra});
  const records=[sale('antam','ANTAM RED 2026',1,2497000),sale('gift','ANTAM GIFT 2026',0.5,2850000,{harga_jual:1425000,qty:2,lebih_bayar:25000.5}),sale('ubs','LOGAM MULIA UBS',1,2234000,{kode_group:'LMM',kode_dept:'ANY'}),sale('micro','ANTAM MICRO GOLD 2026',0.1,2940000),sale('cancel','ANTAM 2026',1,2497000,{status_valid:'CANC'}),sale('return','ANTAM 2026',1,2497000,{status_kembali:'CLOSE'}),sale('exchange','ANTAM 2026',1,2497000,{trs_barang_tukar:true}),sale('offline','ANTAM 2026',1,2497000,{kode_marketplace:'-'}),sale('wrong-group','ANTAM 2026',1,2497000,{kode_group:'GD',kode_dept:'LM'}),sale('silver','PERAK UBS',1,2234000),{...sale('parent','parent',99,999999),detail_barang:[sale('wrong-price','ANTAM GIFT',0.5,1425000),sale('no-rate','ANTAM 2026',1,undefined),sale('cancel-child','ANTAM 2026',1,2497000,{status_valid:'CANC'})]}];
  const sources=[{databaseName:'a',alias:'Italy A',branchId:'A'},{databaseName:'b',alias:'Italy B',branchId:'B'}];let masterReads=0;
  const mongo={getDatabase(database){return {listCollections(){return {hasNext:async()=>true}},collection(name){
    if(name==='tm_barang'){masterReads++;throw new Error('LM does not use kadar master lookup')}
    if(name==='tt_authorization')return {find(query){assert.equal(query.kategori,'PENJUALAN');assert.ok(!query.no_faktur.$in.includes('cancel'));return {maxTimeMS(){return this},sort(){return this},limit(){return this},async toArray(){return database==='a'?[{no_faktur:'wrong-price',kategori:'PENJUALAN',description:'PENJUALAN DI BAWAH MODAL',keterangan:'Disetujui harga khusus'}]:[]}}}};
    assert.equal(name,'tt_jual_detail');return {find(query,{projection}){assert.equal(query.status_valid,'DONE');assert.equal(query.status_kembali,'OPEN');assert.deepEqual(query.$and[0].$or[0].kode_group.$in,['LM','LMM']);assert.equal(query.kode_dept,undefined);assert.equal(projection.harga_gram,1);assert.equal(projection.harga_jual,1);return {maxTimeMS(){return this},batchSize(){return this},async close(){},async *[Symbol.asyncIterator](){yield*records}}}};
  }}}};
  const report=await new PriceAuditService(mongo,{read:async()=>[reference]}).report({windows:[{date,fromTime:'00:00',toTime:'24:00',attachmentIds:[reference.id]}],salesAutoBatch:true,salesMarketplaceOnly:true},sources,'owner','session');
  const table=report.blocks.find(block=>block.title==='Audit harga penjualan marketplace logam mulia');assert.ok(table);assert.equal(table.rows.length,12);assert.equal(masterReads,0);assert.ok(!report.blocks.some(block=>block.title==='Audit harga penjualan marketplace perhiasan'));
  const referenceTable=report.blocks.find(block=>block.title==='Daftar acuan pemeriksaan harga');assert.equal(referenceTable.rows[0][referenceTable.columns.indexOf('Berlaku Mulai WIB')],'13:07:32');
  const cell=(row,column)=>row[table.columns.indexOf(column)];const find=(store,invoice)=>table.rows.find(row=>cell(row,'Toko')===store&&cell(row,'No. Faktur')===invoice);
  for(const source of sources){assert.equal(cell(find(source.alias,'gift'),'Kategori Acuan'),'Gift');assert.equal(cell(find(source.alias,'gift'),'Tarif File Batch 1 (IDR)'),1425000);assert.equal(cell(find(source.alias,'gift'),'Acuan Batch 1 (IDR)'),2850000);assert.equal(cell(find(source.alias,'gift'),'Hasil Pemeriksaan'),'Masih dalam batas range acuan');assert.equal(cell(find(source.alias,'gift'),'Pengembalian Kelebihan Pembayaran (IDR)'),25000.5);assert.equal(cell(find(source.alias,'antam'),'Pengembalian Kelebihan Pembayaran (IDR)'),0);assert.equal(cell(find(source.alias,'micro'),'Kategori Acuan'),'Micro Gold');assert.equal(cell(find(source.alias,'micro'),'Hasil Pemeriksaan'),'Perlu diperhatikan');assert.equal(cell(find(source.alias,'no-rate'),'Hasil Pemeriksaan'),'Perlu diperhatikan');assert.equal(cell(find(source.alias,'wrong-price'),'Hasil Pemeriksaan'),'Di luar range acuan');}
  assert.equal(cell(find('Italy A','wrong-price'),'Otorisasi di Bawah Modal'),'Ada otorisasi');assert.equal(cell(find('Italy B','wrong-price'),'Otorisasi di Bawah Modal'),'Tidak ditemukan');assert.ok(table.rows.every(row=>row.length===table.columns.length));
  console.log('Bullion marketplace passed: parsed gram/piece units and unavailable labels, encrypted names, LM/LMM groups, marketplace-only valid details, stored harga_gram, normalized piece references, preserved authorizations and overpayments.');
}finally{global.fetch=originalFetch}})().catch(error=>{console.error(error);process.exitCode=1});
