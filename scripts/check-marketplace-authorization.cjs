process.env.DOTENV_CONFIG_PATH='/dev/null';
process.env.MONGODB_URI='mongodb://127.0.0.1:27017';
process.env.SYSTEM_DATABASE_NAME='marketplace_auth_fixture';
process.env.JWT_ACCESS_SECRET='offline-marketplace-authorization-secret-32-characters';
for(const key of ['RDS_URLDB_API','RDS_DB_NAME','RDS_USERNAME','RDS_PASSWORD'])process.env[key]='';
const assert=require('node:assert/strict');
const {TransactionReportService}=require('../dist/src/agent/transaction-report.service');
const {transactionReportBlocks}=require('../dist/src/agent/transaction-report.blocks');
const sources=[{databaseName:'store-a',alias:'Store A',branchId:'A',sourceType:'central'},{databaseName:'store-b',alias:'Store B',branchId:'B',sourceType:'branch'}];
const row={no_faktur_group_user:'GROUP',kode_marketplace:'TIKTOK',detail:[
  {no_faktur_jual:'FJ-1',kode_dept:'CIMD',nama_barang:'CINCIN',harga_jual:2000000,ongkos:20000,harga_total:2020000},
  {no_faktur_jual:'FJ-2',kode_dept:'CIMD',nama_barang:'GELANG',harga_jual:1000000,ongkos:10000,harga_total:1010000},
  {no_faktur_jual:'PACK',kode_dept:'LAINNYA',nama_barang:'PACKING',harga_total:20000},
]};
const mongo={getDatabase(database){return {
  listCollections:()=>({hasNext:async()=>true}),
  collection(name){return name==='tt_authorization'?{find(query){
    assert.deepEqual(query.no_faktur,{$in:['FJ-1','FJ-2']});
    return {maxTimeMS(){return this},sort(){return this},limit(){return this},async toArray(){
      if(database==='store-b')throw new Error('auth unavailable');
      return [{no_faktur:'FJ-2',kategori:'PENJUALAN',description:'PENJUALAN DI BAWAH MODAL',keterangan:'Disetujui harga khusus'}];
    }};
  }}:{aggregate(pipeline){assert.equal(name,'tt_jual_detail');assert.equal(pipeline[0].$match.status_valid,'DONE');return {toArray:async()=>[structuredClone(row)]}}};},
}}};
(async()=>{
  const report=await new TransactionReportService(mongo).read({reportType:'online_marketplace_price',from:'2026-11-23',to:'2026-11-23'},sources);
  assert.equal(report.sources[0].rows.length,1);assert.equal(report.sources[0].rows[0].no_faktur_utama,'FJ-1');
  assert.equal(report.sources[0].rows[0].harga_online_final,3050000);
  assert.equal(report.sources[0].rows[0].belowCostAuthorization.status,'Ada otorisasi');
  assert.equal(report.sources[1].status,'available','authorization failure does not discard valid sales');
  assert.equal(report.sources[1].rows[0].belowCostAuthorization.status,'Belum dapat diperiksa');
  const tables=transactionReportBlocks(report).filter(block=>block.type==='table');
  const cell=(table,column)=>table.rows[0][table.columns.indexOf(column)];
  assert.equal(cell(tables[0],'Otorisasi di Bawah Modal'),'Ada otorisasi');assert.equal(cell(tables[0],'Keterangan Otorisasi'),'FJ-2: Disetujui harga khusus');
  assert.equal(cell(tables[1],'Otorisasi di Bawah Modal'),'Belum dapat diperiksa');
  assert.equal(cell(tables[0],'Total Harga Online (IDR)'),3050000);
  console.log('Marketplace authorization integration passed: grouped secondary invoice, source isolation, safe lookup failure, shared table output and unchanged totals.');
})().catch(error=>{console.error(error);process.exitCode=1});
