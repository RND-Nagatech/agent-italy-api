process.env.DOTENV_CONFIG_PATH='/dev/null';process.env.MONGODB_URI='mongodb://127.0.0.1:27017';process.env.SYSTEM_DATABASE_NAME='marketplace_fixture';process.env.JWT_ACCESS_SECRET='offline-marketplace-fixture-secret-at-least-32-characters';process.env.ENC_KEY_DEC='marketplace-test-key';
for(const key of ['RDS_URLDB_API','RDS_DB_NAME','RDS_USERNAME','RDS_PASSWORD'])process.env[key]='';
const assert=require('node:assert/strict');const {PriceAuditService}=require('../dist/src/agent/price-audit.service');const {priceAuditScope}=require('../dist/src/agent/price-audit-scope');const {encryptBankField:enc}=require('../dist/src/agent/banking.logic');
const date='2026-11-23';const rate=(kadar,price)=>({kind:'sales',family:'young',kadar,rate:price,maxRate:null,sourceCode:'DOES-NOT-MATCH-ITEM',fee:null,feeType:'unknown',condition:'ANY',note:''});
const refs=[{id:'sales1',filename:'harga1.jpeg',date,batch:1,complete:true,warnings:[],rows:[rate(50,1050000),rate(54,1134000)]},{id:'sales2',filename:'harga2.jpeg',date,batch:2,complete:true,warnings:[],rows:[rate(50,1057000),rate(54,1143000)]},{id:'bb',filename:'bb.jpeg',date,batch:1,complete:true,warnings:[],rows:[{...rate(50,1039000),kind:'buyback',sourceCode:'H16',condition:'GOOD'}]}];
const sale=(id,kadar,price,extra={})=>({_id:id,no_faktur_jual:id,no_faktur_group_user:'GROUP-1',tgl_system:date,jam:enc('10:00:00'),kode_marketplace:'TIKTOK',kode_barcode:id,nama_barang:enc('Cincin'),barang:kadar===null?undefined:{kadar:enc(String(kadar))},harga_gram:price,harga_jual:9876543,ongkos:22222,harga_total:9999999,berat:1.71,qty:1,status_valid:'DONE',status_kembali:'OPEN',kode_dept:'CIMD',kode_group:'GD',...extra});
const records=[sale('batch1',50,1050000),sale('batch2',50,1057000),sale('wrong-grade-price',50,1134000),sale('master',null,1050000,{kode_barcode:'00007'}),sale('no-rate',50,undefined),sale('offline',50,1050000,{kode_marketplace:'-'}),sale('missing-marketplace',50,1050000,{kode_marketplace:undefined}),sale('cancelled',50,1050000,{status_valid:'CANC'}),sale('returned',50,1050000,{status_kembali:'CLOSE'}),sale('exchange',50,1050000,{status_tukar:true}),sale('packing',null,1000,{kode_dept:'LAINNYA',nama_barang:enc('Packing')}),sale('bullion',50,1050000,{kode_dept:'LM',nama_barang:enc('Antam')}),sale('silver',50,1050000,{nama_barang:enc('Perak')}),sale('group',50,9999999,{barang:{kadar:enc('99')},detail_barang:[{no_faktur_jual:'leaf50',barang:{kadar:enc('50')},harga_gram:1050000,berat:0.7},{no_faktur_jual:'leaf54',barang:{kadar:enc('54')},harga_gram:1143000,berat:1.1},{no_faktur_jual:'leaf-cancelled',barang:{kadar:enc('50')},harga_gram:1050000,status_valid:'CANC'}]})];
records.find(row=>row._id==='batch1').lebih_bayar=enc('25000.50');
records.find(row=>row._id==='batch2').lebih_bayar=0;
records.find(row=>row._id==='group').lebih_bayar=50000;
const sources=[{databaseName:'pusat',alias:'Italy Pusat',branchId:'ITY'},{databaseName:'otista',alias:'Italy Otista',branchId:'IT2'}];let gradeQueries=0,buybackReads=0;
const cursor = rows => ({ maxTimeMS(){return this;}, batchSize(){return this;}, async close(){}, async *[Symbol.asyncIterator](){yield*rows;} });
const mongo = {
  getDatabase(database) {
    return {
      listCollections() { return { async hasNext() { return true; } }; },
      collection(name) {
        if (name === 'tt_authorization') return {
          find(query) {
            assert.equal(query.kategori,'PENJUALAN'); assert.equal(query.datetime,undefined);
            return { maxTimeMS(){return this;},sort(){return this;},limit(){return this;},async toArray(){return database === 'pusat' ? [{no_faktur:'wrong-grade-price',kategori:'PENJUALAN',description:'PENJUALAN DI BAWAH MODAL',keterangan:'Disetujui harga promosi marketplace'}] : [];} };
          },
        };
        if (name === 'tm_barang') return {
          find(query, { projection }) {
            gradeQueries++;
            assert.equal(projection.kadar, 1);
            assert.equal(projection.kode_intern, undefined, 'marketplace grade fallback must not require intern codes');
            assert.deepEqual(query.kode_barcode.$in, ['00007']);
            return { maxTimeMS(){return this;}, limit(){return this;}, async toArray(){return [{kode_barcode:'00007',kadar:enc('50'),kode_intern:enc('WRONG')}];} };
          },
        };
        return {
          find(query, { projection }) {
            if (name === 'tt_beli_detail') { buybackReads++; return cursor([]); }
            assert.equal(name, 'tt_jual_detail');
            assert.equal(query.$or[0].kode_marketplace.$exists, true);
            assert.deepEqual(query.$or[0].kode_marketplace.$nin, ['-', '', null]);
            assert.equal(projection.harga_gram, 1); assert.equal(projection.kode_marketplace, 1); assert.equal(projection.lebih_bayar,1); assert.equal(projection['detail_barang.lebih_bayar'],1);
            assert.equal(projection['detail_barang.barang.kadar'], 1);
            return cursor(records.filter(row => !/^LM/.test(row.kode_dept) && row.kode_dept !== 'LAINNYA'));
          },
        };
      },
    };
  },
};
(async()=>{const scope=priceAuditScope('cek penjualan marketplace dan buyback sesuai file',refs);assert.equal(scope.selection.salesMarketplaceOnly,true);const report=await new PriceAuditService(mongo,{async read(){return structuredClone(refs);}}).report(scope.selection,sources,'owner','session');const table=report.blocks.find(block=>block.title==='Audit harga penjualan marketplace perhiasan');assert.ok(table);assert.equal(table.rows.length,14,'seven jewelry details per store, not invoice totals/fees/offline/cancelled records');assert.equal(gradeQueries,2);assert.equal(buybackReads,2,'buyback files keep their independent purchase path');assert.ok(report.blocks.some(block=>block.title==='Audit harga buyback perhiasan'));
const cell=(row,col)=>row[table.columns.indexOf(col)];for(const source of sources){const row=invoice=>table.rows.find(row=>cell(row,'Toko')===source.alias&&cell(row,'No. Faktur')===invoice);assert.equal(cell(row('batch1'),'Batch Acuan'),'Batch 1');assert.equal(cell(row('batch2'),'Batch Acuan'),'Batch 2');assert.equal(cell(row('master'),'Kadar Barang'),50);assert.equal(cell(row('master'),'Status Pemeriksaan'),'Masih dalam batas range acuan');assert.equal(cell(row('wrong-grade-price'),'Kadar Barang'),50);assert.equal(cell(row('wrong-grade-price'),'Status Pemeriksaan'),'Di luar range acuan');assert.equal(cell(row('no-rate'),'Status Pemeriksaan'),'Perlu diperhatikan');assert.equal(cell(row('leaf50'),'Kadar Barang'),50);assert.equal(cell(row('leaf54'),'Kadar Barang'),54);assert.equal(cell(row('leaf54'),'Batch Acuan'),'Batch 2');assert.equal(cell(row('batch1'),'Harga Jual (IDR)'),9876543);assert.equal(cell(row('batch1'),'Harga Transaksi per gram (IDR)'),1050000);assert.equal(cell(row('wrong-grade-price'),'Acuan Batch 1 (IDR/gram)'),1050000);assert.equal(cell(row('wrong-grade-price'),'Acuan Batch 2 (IDR/gram)'),1057000);assert.equal(cell(row('wrong-grade-price'),'Selisih Batch 1 (IDR/gram)'),84000);assert.equal(cell(row('wrong-grade-price'),'Selisih Batch 2 (IDR/gram)'),77000);assert.equal(cell(row('no-rate'),'Acuan Batch 1 (IDR/gram)'),1050000);assert.equal(cell(row('no-rate'),'Selisih Batch 1 (IDR/gram)'),'Harga transaksi belum tersedia');assert.equal(cell(row('batch1'),'Pengembalian Kelebihan Pembayaran (IDR)'),25000.5);assert.equal(cell(row('batch2'),'Pengembalian Kelebihan Pembayaran (IDR)'),0);assert.equal(cell(row('no-rate'),'Pengembalian Kelebihan Pembayaran (IDR)'),null);assert.equal(cell(row('leaf50'),'Pengembalian Kelebihan Pembayaran (IDR)'),50000);assert.equal(cell(row('leaf54'),'Pengembalian Kelebihan Pembayaran (IDR)'),50000);}
assert.deepEqual(report.blocks.filter(block=>block.type==='metric'&&block.unit==='penjualan').map(block=>[block.label,block.value]), [['Masih dalam batas range acuan',10],['Di luar range acuan',2],['Perlu diperhatikan',2]]);
const authorized=table.rows.find(row=>cell(row,'Toko')==='Italy Pusat'&&cell(row,'No. Faktur')==='wrong-grade-price');
assert.equal(cell(authorized,'Otorisasi di Bawah Modal'),'Ada otorisasi');
assert.match(cell(authorized,'Keterangan Otorisasi'),/Disetujui harga promosi marketplace/);
assert.equal(cell(authorized,'Status Pemeriksaan'),'Di luar range acuan','approval does not change the price audit outcome');
const otherStore=table.rows.find(row=>cell(row,'Toko')==='Italy Otista'&&cell(row,'No. Faktur')==='wrong-grade-price');
assert.equal(cell(otherStore,'Otorisasi di Bawah Modal'),'Tidak ditemukan');
const {transactionReportBlocks}=require('../dist/src/agent/transaction-report.blocks');
const normal=transactionReportBlocks({reportType:'online_marketplace_price',sources:[{...sources[0],status:'available',rows:[{no_faktur_utama:'FJ-1',kode_marketplace:'TIKTOK',lebih_bayar:50000,harga_online_final:9999999}]}]});
const normalTable=normal.find(block=>block.type==='table');assert.equal(normalTable.rows[0][normalTable.columns.indexOf('Pengembalian Kelebihan Pembayaran (IDR)')],50000);
assert.ok(table.rows.every(row=>row.length===table.columns.length));console.log('Marketplace audit passed: mixed uploads, marketplace-only jewelry details, snapshot/master grades, direct harga_gram, per-item batches, fee exclusions, statuses and independent buyback reads.');})().catch(error=>{console.error(error);process.exitCode=1;});
