import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditMarketplacePrice, marketplacePriceReportTable } from '../src/agent/marketplace-price-audit.logic';
import type { AuditTransaction, PriceReference, PriceRule } from '../src/agent/price-audit.logic';

const date = '2026-11-23';
const rule = (kadar: number, rate: number, sourceCode = 'ANY', fee = 20000): PriceRule => ({ kind:'sales',family:kadar<=60?'young':'old',kadar,rate,maxRate:null,sourceCode,fee,feeType:'nominal',condition:'ANY',note:'' });
const ref = (batch: number, rows: PriceRule[], extra: Partial<PriceReference> = {}): PriceReference => ({ id:`ref-${batch}`,filename:`harga-${batch}.jpeg`,date,batch,complete:true,warnings:[],rows,...extra });
const tx = (kadar: number | null, pricePerGram: number | null, extra: Partial<AuditTransaction> = {}): AuditTransaction => ({ id:'sale',kind:'sales',store:'Italy',date,time:'10:00:00',invoice:'J-1',marketplace:'TIKTOK',invoiceGroup:'G-1',barcode:'00123',name:'Gelang',kadar,pricePerGram,weight:1.71,price:9999999,fee:98765,quantity:1,condition:'',inputBy:'Kasir',...extra });

test('marketplace uses grade and stored unit price, independent of internal codes and same-grade fees', () => {
  const refs=[ref(1,[rule(88,1848000,'C5',20000),rule(88,1848000,'D7',25000),rule(90,1890000,'C6'),rule(90,1890000,'D8',25000)])];
  const result=auditMarketplacePrice(tx(88,1848000,{internalCode:'WRONG',lookupNote:'Kode intern tidak tersedia'}),refs);
  assert.equal(result.status,'Cocok');assert.equal(result.expectedRate,1848000);assert.equal(result.referenceKadar,88);assert.equal(result.priceDifference,0);assert.equal(result.batch,'Batch 1');
  assert.equal(auditMarketplacePrice(tx(90,1890000),refs).status,'Cocok');
  const table=marketplacePriceReportTable([result]);assert.ok(!table.columns.includes('Kode Intern'));assert.ok(!table.columns.includes('Sumber Barang'));
  assert.equal(table.rows[0][table.columns.indexOf('Status Pemeriksaan')],'Masih dalam batas range acuan');
  assert.equal(table.rows[0][table.columns.indexOf('Marketplace')],'TIKTOK');assert.equal(table.rows[0].length,table.columns.length);
});

test('a matching price for another grade cannot change the item grade or approve it', () => {
  const result=auditMarketplacePrice(tx(81,1365000),[ref(1,[rule(65,1365000,'C8'),rule(81,1701000,'C8')])]);
  assert.equal(result.status,'Tidak cocok');assert.equal(result.referenceKadar,81);assert.equal(result.expectedRate,1701000);assert.equal(result.priceDifference,-336000);
  assert.match(result.reason,/kadar 81/);assert.doesNotMatch(result.reason,/kadar 65/);
});

test('untimed marketplace batches use exact prices at the same grade and exclude buyback tariffs', () => {
  const refs=[ref(1,[rule(38,798000,'H04'),rule(50,1050000,'H16')]),ref(2,[rule(38,804000,'H04'),rule(50,1057000,'H16')]),ref(2,[{...rule(38,795000,'H04'),kind:'buyback'}],{id:'bb',effectiveFrom:'12:00'})];
  assert.equal(auditMarketplacePrice(tx(38,798000),refs).batch,'Batch 1');assert.equal(auditMarketplacePrice(tx(38,804000),refs).batch,'Batch 2');
  const gap=auditMarketplacePrice(tx(38,801000),refs);assert.equal(gap.status,'Tidak cocok');assert.equal(gap.batch,'Tidak teridentifikasi');assert.equal(gap.expectedRate,null);assert.equal(gap.priceDifference,null);
  assert.deepEqual(gap.batchPrices?.map(item=>[item.rate,item.difference]),[[798000,3000],[804000,-3000]]);
  assert.match(gap.batchRates!,/798\.000/);assert.match(gap.batchRates!,/804\.000/);
  assert.equal(auditMarketplacePrice(tx(38,795000),refs).status,'Tidak cocok');
});

test('same-grade conflicts and ambiguous or missing batches remain visible for attention', () => {
  const conflict=auditMarketplacePrice(tx(88,1848000),[ref(1,[rule(88,1848000),rule(88,1849000)])]);assert.equal(conflict.status,'Belum dapat diperiksa');
  const duplicate=auditMarketplacePrice(tx(38,798000),[ref(1,[rule(38,798000)]),ref(2,[rule(38,798000)])]);assert.equal(duplicate.status,'Belum dapat diperiksa');assert.equal(duplicate.priceStatus,'Cocok');assert.match(duplicate.batch!,/1 \/ 2/);
  const missing=auditMarketplacePrice(tx(38,798000),[ref(1,[rule(38,798000)]),ref(2,[rule(39,825000)])]);assert.equal(missing.status,'Belum dapat diperiksa');
});

test('printed sales hours assign the batch before checking prices, with exclusive transitions', () => {
  const refs=[ref(1,[rule(38,798000)],{effectiveFrom:'08:15'}),ref(2,[rule(38,804000)],{effectiveFrom:'13:40'})];
  assert.equal(auditMarketplacePrice(tx(38,798000,{time:'13:39:59'}),refs).batch,'Batch 1');
  const wrong=auditMarketplacePrice(tx(38,798000,{time:'13:40:00'}),refs);assert.equal(wrong.batch,'Batch 2');assert.equal(wrong.status,'Tidak cocok');assert.equal(wrong.expectedRate,804000);assert.equal(wrong.priceDifference,-6000);
  assert.equal(auditMarketplacePrice(tx(38,804000,{time:''}),refs).status,'Belum dapat diperiksa');
  assert.equal(auditMarketplacePrice(tx(38,798000,{time:'08:14:59'}),refs).status,'Belum dapat diperiksa');
  assert.equal(auditMarketplacePrice(tx(38,804000),[refs[0],{...refs[1],effectiveFrom:null}]).status,'Belum dapat diperiksa');
});

test('missing grades, unit prices, document dates and exact decimal grades cannot be inferred', () => {
  const refs=[ref(1,[rule(50,1050000)])];
  assert.equal(auditMarketplacePrice(tx(null,1050000),refs).status,'Belum dapat diperiksa');
  assert.equal(auditMarketplacePrice(tx(50,null,{price:1795500,weight:1.71}),refs).status,'Belum dapat diperiksa');
  assert.equal(auditMarketplacePrice(tx(50.1,1050000),refs).status,'Belum dapat diperiksa');
  assert.equal(auditMarketplacePrice(tx(50,1050000,{date:'2026-11-24'}),refs).status,'Belum dapat diperiksa');
});

test('young-gold reference prices remain numeric in each batch when actual prices are outside both references', () => {
  const refs = [ref(1,[rule(54,1134000),rule(57,1197000)]),ref(2,[rule(54,1143000),rule(57,1206000)])];
  const rows = [auditMarketplacePrice(tx(54,1115278),refs),auditMarketplacePrice(tx(57,1177114),refs),auditMarketplacePrice(tx(54,1117021),refs)];
  const table = marketplacePriceReportTable(rows,refs);
  const cell = (index: number,column: string) => table.rows[index][table.columns.indexOf(column)];
  assert.equal(cell(0,'Acuan Batch 1 (IDR/gram)'),1134000); assert.equal(cell(0,'Selisih Batch 1 (IDR/gram)'),-18722);
  assert.equal(cell(0,'Acuan Batch 2 (IDR/gram)'),1143000); assert.equal(cell(0,'Selisih Batch 2 (IDR/gram)'),-27722);
  assert.equal(cell(1,'Acuan Batch 1 (IDR/gram)'),1197000); assert.equal(cell(1,'Selisih Batch 1 (IDR/gram)'),-19886);
  assert.equal(cell(1,'Acuan Batch 2 (IDR/gram)'),1206000); assert.equal(cell(1,'Selisih Batch 2 (IDR/gram)'),-28886);
  assert.equal(cell(2,'Selisih Batch 1 (IDR/gram)'),-16979); assert.equal(cell(2,'Selisih Batch 2 (IDR/gram)'),-25979);
  for(let i=0;i<rows.length;i++) { assert.equal(cell(i,'Batch Acuan'),'Tidak teridentifikasi'); assert.equal(cell(i,'Status Pemeriksaan'),'Di luar range acuan'); assert.equal(table.rows[i].length,table.columns.length); }
  assert.match(rows[0].reason,/lebih rendah Rp18\.722/); assert.match(rows[0].reason,/lebih rendah Rp27\.722/);
  assert.equal(table.columns.includes('Harga Acuan per gram (IDR)'),false,'no blank single-rate column when multiple batch references exist');
});

test('reference availability does not depend on transaction price or an identified batch', () => {
  const refs=[ref(1,[rule(50,1050000),rule(88,1848000)]),ref(2,[rule(50,1058000)])];
  const rows=[auditMarketplacePrice(tx(50,null),refs),auditMarketplacePrice(tx(88,1848000),refs),auditMarketplacePrice(tx(null,1050000),refs)];
  const table=marketplacePriceReportTable(rows,refs);
  const cell=(index:number,column:string)=>table.rows[index][table.columns.indexOf(column)];
  assert.equal(cell(0,'Acuan Batch 1 (IDR/gram)'),1050000); assert.equal(cell(0,'Acuan Batch 2 (IDR/gram)'),1058000);
  assert.equal(cell(0,'Selisih Batch 1 (IDR/gram)'),'Harga transaksi belum tersedia');
  assert.equal(cell(1,'Acuan Batch 1 (IDR/gram)'),1848000); assert.equal(cell(1,'Acuan Batch 2 (IDR/gram)'),'Acuan belum tersedia');
  assert.equal(cell(2,'Acuan Batch 1 (IDR/gram)'),'Kadar barang belum diketahui');
  const timed=[ref(1,[rule(50,1050000)],{effectiveFrom:'08:15'}),ref(2,[rule(50,1058000)],{effectiveFrom:'13:40'})];
  const wrong=auditMarketplacePrice(tx(50,1050000,{time:'13:40:00'}),timed);
  const timedTable=marketplacePriceReportTable([wrong],timed);
  assert.equal(wrong.batch,'Batch 2'); assert.equal(wrong.status,'Tidak cocok'); assert.equal(wrong.batchPrices![0].difference,0); assert.equal(wrong.batchPrices![1].difference,-8000);
  assert.equal(timedTable.rows[0][timedTable.columns.indexOf('Acuan Batch 2 (IDR/gram)')],1058000);
});
