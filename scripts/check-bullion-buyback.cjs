process.env.DOTENV_CONFIG_PATH='/dev/null';process.env.MONGODB_URI='mongodb://127.0.0.1:27017';process.env.SYSTEM_DATABASE_NAME='bullion_fixture';
process.env.JWT_ACCESS_SECRET='offline-bullion-fixture-secret-32-characters';process.env.ENC_KEY_DEC='bullion-fixture-key';process.env.DEEPSEEK_API_KEY='offline-model';
for(const key of ['RDS_URLDB_API','RDS_DB_NAME','RDS_USERNAME','RDS_PASSWORD'])process.env[key]='';
const assert=require('node:assert/strict');
const {PriceAuditService}=require('../dist/src/agent/price-audit.service');
const {PriceReferenceService}=require('../dist/src/agent/price-reference.service');
const {encryptBankField:enc}=require('../dist/src/agent/banking.logic');
const {withPriceCache}=require('./price-cache-fixture.cjs');
const {withPriceCellVerification}=require('./price-cell-fixture.cjs');
const date='2026-11-25';
const bullionRows=[
  {product:'ANTAM_YEAR',year:2026,weightGram:1,rateThousands:2367,sourceLabel:'ANTAM 2026'},
  {product:'ANTAM_YEAR',year:2026,weightGram:2,rateThousands:2338,sourceLabel:'ANTAM 2026'},
  {product:'ANTAM_REDMARK',year:null,weightGram:1,rateThousands:2090,sourceLabel:'ANTAM Redmark'},
  {product:'ANTAM_RETRO',year:null,weightGram:1,rateThousands:2085,sourceLabel:'ANTAM Retro'},
  {product:'EMASKU',year:null,weightGram:1,rateThousands:2095,sourceLabel:'EMASKU'},
  {product:'EMASKU',year:null,weightGram:3,rateThousands:null,sourceLabel:'EMASKU'},
];
const page={isJewelryPrice:true,date,batch:1,effectiveFrom:'13:07:32',complete:true,warnings:[],rows:[],buybackRows:[],bullionRows};
const readAudit={async resolveActorEmail(){return ''},async begin(){return 'audit'},async finish(){}};
let saved;
const storage=withPriceCache({db:{collection(){return {async updateOne(_query,update){saved=update.$set}}}}});
const parser=new PriceReferenceService(storage,{},readAudit);
const file={id:'000000000000000000000001',filename:'lm.png',mime:'image/png'};
const originalFetch=global.fetch;
const answer=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}),{status:200});
(async()=>{
  try{
    global.fetch=async()=>answer(page);
    const reference=await parser.extract('100000000000000000000000','owner',Buffer.from('bullion fixture'),file);
    assert.equal(reference.date,date);assert.equal(reference.effectiveFrom,'13:07:32');assert.equal(reference.rows.length,5);
    assert.equal(reference.rows[0].bullionWeightGram,1);assert.equal(reference.rows[0].rate,2367000);
    assert.ok(!reference.rows.some(row=>row.bullionProduct==='EMASKU'&&row.bullionWeightGram===3));
    // A jewelry verification pass must retain the independently extracted OTHER_LM footer.
    global.fetch=withPriceCellVerification(async()=>answer({...page,effectiveFrom:'07:00',bullionRows:[{product:'OTHER_LM',year:null,weightGram:null,rateThousands:2080,sourceLabel:'LM Selain ANTAM'}],buybackRows:[{family:'old',sourceCode:'C5',sourceLabel:'SHINE',printedKadar:'',goodThousands:1533,scrapThousands:1449,stoneMinThousands:1491,stoneMaxThousands:1523}]}));
    const mixed=await parser.extract('100000000000000000000000','owner',Buffer.from('jewelry plus footer'),{...file,id:'000000000000000000000002'});
    assert.ok(mixed.rows.some(row=>row.family==='bullion'&&row.rate===2080000));
    const footer={...mixed,rows:mixed.rows.filter(row=>row.family==='bullion')};
    const purchase=(id,name,weight,rate,extra={})=>({_id:id,no_faktur_beli:id,tgl_system:date,jam:enc('14:00:00'),kode_group:'LM',kode_dept:'LGM',nama_barang:enc(name),berat:enc(String(weight)),harga_rata:enc(String(rate)),harga:1234567,harga_nota:9999999,kondisi:enc('CUCI 16K / 17K'),status_valid:'DONE',...extra});
    const records=[purchase('year','LOGAM MULIA ANTAM CERTIE YE RED 99.99 2026',1,2367000),purchase('bare','LOGAM MULIA ANTAM 99.99',2,2338000),purchase('red','ANTAM CERTI EYE RED 999.9',1,2090000,{kode_group:'LMM',kode_dept:'ANY'}),purchase('retro','ANTAM RETRO',1,2085000),purchase('emasku-missing','EMASKU',3,2095000),purchase('other','LOGAM MULIA PAMP 2026',1,2080000),purchase('cancelled','ANTAM 2026',1,2367000,{status_valid:'CANC'}),purchase('department-only','ANTAM 2026',1,2367000,{kode_dept:'LM',kode_group:'GD'}),{...purchase('group','parent',99,1),detail_barang:[purchase('leaf','ANTAM 2026',1,2390000),purchase('cancelled-leaf','ANTAM 2026',1,2390000,{status_valid:'CANC'})]}];
    const sources=[{databaseName:'a',alias:'Italy A',branchId:'A'},{databaseName:'b',alias:'Italy B',branchId:'B'}];
    const cursor=rows=>({maxTimeMS(){return this},batchSize(){return this},async close(){},async *[Symbol.asyncIterator](){yield*rows}});
    let masterReads=0;
    const mongo={getDatabase(database){return {listCollections(){return {hasNext:async()=>true}},collection(name){
      if(name==='tm_barang'){masterReads++;throw new Error('bullion must not require intern lookup')}
      if(name==='tt_authorization')return {find(query){assert.equal(query.kategori,'PEMBELIAN');assert.ok(!query.no_faktur.$in.includes('cancelled'));return {maxTimeMS(){return this},sort(){return this},limit(){return this},async toArray(){return database==='a'?[{no_faktur:'leaf,year',kategori:'PEMBELIAN',description:'PEMBELIAN DI ATAS NOTA',keterangan:'Disetujui supervisor'}]:[]}}}};
      assert.equal(name,'tt_beli_detail');return {find(query,{projection}){assert.equal(query.status_valid.$ne,'CANC');assert.deepEqual(query.$or[0].kode_group.$in,['LM','LMM']);assert.equal(query.kode_dept,undefined,'filter is group, not department');assert.equal(projection.harga_rata,1);assert.equal(projection.nama_barang,1);return cursor(records)}};
    }}}};
    const report=await new PriceAuditService(mongo,{read:async()=>structuredClone([reference,footer])}).report({windows:[{date,fromTime:'00:00',toTime:'24:00',attachmentIds:[reference.id,footer.id]}],buybackAutoBatch:true},sources,'owner','session');
    const table=report.blocks.find(block=>block.title==='Audit harga buyback logam mulia');
    assert.equal(table.rows.length,14);assert.equal(masterReads,0);assert.ok(table.rows.every(row=>row.length===table.columns.length));
    const cell=(row,column)=>row[table.columns.indexOf(column)];const byInvoice=(store,invoice)=>table.rows.find(row=>cell(row,'Toko')===store&&cell(row,'No. Faktur')===invoice);
    for(const source of sources){assert.equal(cell(byInvoice(source.alias,'year'),'Kategori Acuan'),'ANTAM 2026');assert.equal(cell(byInvoice(source.alias,'bare'),'Kategori Acuan'),'ANTAM 2026');assert.equal(cell(byInvoice(source.alias,'year'),'Harga Rata per gram (IDR)'),2367000);assert.equal(cell(byInvoice(source.alias,'red'),'Hasil Pemeriksaan'),'Masih dalam batas range acuan');assert.equal(cell(byInvoice(source.alias,'other'),'Hasil Pemeriksaan'),'Masih dalam batas range acuan');assert.equal(cell(byInvoice(source.alias,'emasku-missing'),'Hasil Pemeriksaan'),'Perlu diperhatikan');assert.equal(cell(byInvoice(source.alias,'leaf'),'Hasil Pemeriksaan'),'Di luar range acuan');assert.ok(!byInvoice(source.alias,'cancelled'));assert.ok(!byInvoice(source.alias,'department-only'));}
    assert.equal(cell(byInvoice('Italy A','leaf'),'Otorisasi di Atas Nota'),'Ada otorisasi');assert.equal(cell(byInvoice('Italy A','leaf'),'Deskripsi Otorisasi'),'PEMBELIAN DI ATAS NOTA');assert.equal(cell(byInvoice('Italy B','leaf'),'Otorisasi di Atas Nota'),'Tidak ditemukan');
    console.log('Bullion buyback passed: parsed second-precision headers, weight tariffs, blank cells, preserved OTHER_LM footer, LM/LMM group filter, decrypted names/rates, year priority, cancellation exclusions and same-store invoice authorizations.');
  }finally{global.fetch=originalFetch}
})().catch(error=>{console.error(error);process.exitCode=1});
