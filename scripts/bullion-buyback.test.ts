import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditBullionBuyback, bullionBuybackReportTable, bullionIdentity, type BullionTransaction } from '../src/agent/bullion-buyback.logic';
import type { BullionProduct, PriceReference, PriceRule } from '../src/agent/price-audit.logic';
import { headerSchedule } from '../src/agent/price-reference-periods';

const date='2026-11-25';
const rule=(product:BullionProduct,weight:number|null,rate:number,year:number|null=null):PriceRule=>({family:'bullion',kind:'buyback',kadar:null,sourceCode:`${product}:${year}:${weight}`,rate,maxRate:null,fee:null,feeType:'unknown',condition:'ANY',note:'',bullionProduct:product,bullionYear:year,bullionWeightGram:weight});
const ref=(batch:number,rows:PriceRule[],effectiveFrom:string|null='08:15:20'):PriceReference=>({id:`r${batch}`,filename:`b${batch}.png`,date,batch,effectiveFrom,complete:true,warnings:[],rows});
const tx=(name='LOGAM MULIA ANTAM CERTIE YE RED 99.99 2026',extra:Partial<BullionTransaction>={}):BullionTransaction=>({id:'FB1',kind:'buyback',store:'Italy',date,time:'10:00:00',invoice:'FB1',name,group:'LM',kadar:null,weight:1,price:1234567,invoicePrice:9999999,pricePerGram:2367000,fee:null,quantity:1,condition:'CUCI',inputBy:'Kasir',...extra});
const refs=[ref(1,[rule('ANTAM_YEAR',1,2367000,2026),rule('ANTAM_YEAR',0.5,2458000,2026),rule('ANTAM_REDMARK',1,2090000),rule('ANTAM_RETRO',1,2085000),rule('EMASKU',1,2095000),rule('OTHER_LM',null,2080000)]),ref(2,[rule('ANTAM_YEAR',1,2374000,2026)],'13:07:32'),ref(3,[rule('ANTAM_YEAR',1,2380000,2026)],'15:00')];

test('Antam explicit years outrank variants and unqualified Antam uses the requested 2026 fallback',()=>{
  assert.equal(bullionIdentity('LOGAM\nMULIA\nANTAM CERTIE YE RED 99.99 2026').label,'ANTAM 2026');
  assert.equal(bullionIdentity('ANTAM RETRO 2025').label,'ANTAM 2025');
  const fallback=bullionIdentity('LOGAM MULIA ANTAM 99.99'); assert.equal(fallback.label,'ANTAM 2026'); assert.match(fallback.reason,/tanpa tahun/);
  assert.equal(bullionIdentity('ANTAM CERTI EYE RED 999.9').product,'ANTAM_REDMARK');
  assert.equal(bullionIdentity('ANTAM RETRO').product,'ANTAM_RETRO');
});

test('EMASKU and non-Antam gold stay separate, while unreadable or conflicting names need review',()=>{
  assert.equal(bullionIdentity('LOGAM MULIA EMASKU 2026').product,'EMASKU');
  assert.equal(bullionIdentity('LOGAM MULIA PAMP 2026').product,'OTHER_LM');
  assert.equal(bullionIdentity('ANTAM 2025 2026').product,null);
  assert.equal(bullionIdentity('ANTAM RED RETRO').product,null);
  for(const name of ['','-','C494E098E8DEDC','PERAK ANTAM']) assert.equal(bullionIdentity(name).product,null);
});

test('bullion uses stored harga_rata and the exact reference weight without dividing the per-gram tariff again',()=>{
  const half=auditBullionBuyback(tx('ANTAM 2026',{weight:0.5,pricePerGram:2458000}),refs);
  assert.equal(half.status,'Masih dalam batas range acuan'); assert.equal(half.comparisons[0].rate,2458000); assert.equal(half.price,1234567);
  assert.equal(auditBullionBuyback(tx('ANTAM 2026',{weight:0.49,pricePerGram:2458000}),refs).status,'Perlu diperhatikan');
  assert.equal(auditBullionBuyback(tx('ANTAM 2025'),refs).status,'Perlu diperhatikan');
  const missing=auditBullionBuyback(tx('ANTAM 2026',{pricePerGram:null}),refs); assert.equal(missing.batch,'Batch 1'); assert.equal(missing.comparisons[0].rate,2367000); assert.equal(missing.status,'Perlu diperhatikan');
});

test('second-precision headers assign batches before prices and support batch three',()=>{
  assert.equal(auditBullionBuyback(tx(undefined,{time:'08:15:19'}),refs).status,'Perlu diperhatikan');
  assert.equal(auditBullionBuyback(tx(undefined,{time:'08:15:20'}),refs).batch,'Batch 1');
  assert.equal(auditBullionBuyback(tx(undefined,{time:'13:07:31'}),refs).batch,'Batch 1');
  const wrong=auditBullionBuyback(tx(undefined,{time:'13:07:32'}),refs);
  assert.equal(wrong.batch,'Batch 2'); assert.equal(wrong.status,'Di luar range acuan'); assert.equal(wrong.comparisons[1].difference,-7000);
  assert.equal(auditBullionBuyback(tx(undefined,{time:'15:00:00',pricePerGram:2380000}),refs).batch,'Batch 3');
  const table=bullionBuybackReportTable([wrong],refs),cell=(name:string)=>table.rows[0][table.columns.indexOf(name)];
  assert.equal(cell('Acuan Batch 3 (IDR/gram)'),2380000); assert.equal(cell('Selisih Batch 3 (IDR/gram)'),-13000); assert.equal(table.rows[0].length,table.columns.length);
});

test('blank category/weight prices never borrow a neighboring tariff and LM/LMM is a group filter',()=>{
  assert.equal(auditBullionBuyback(tx('EMASKU',{weight:3,pricePerGram:2095000}),refs).status,'Perlu diperhatikan');
  assert.equal(auditBullionBuyback(tx('PAMP 2026',{weight:5,pricePerGram:2080000,group:'LMM'}),refs).status,'Masih dalam batas range acuan');
  assert.equal(auditBullionBuyback(tx('ANTAM 2026',{group:'GD'}),refs).status,'Perlu diperhatikan');
  assert.equal(auditBullionBuyback(tx('ANTAM RED',{pricePerGram:2090000}),refs).status,'Masih dalam batas range acuan');
});

test('bullion schedules are isolated from jewelry files, with explicit missing timestamps and conflicts',()=>{
  const jewelry=ref(1,[{...rule('OTHER_LM',null,900000),family:'old'}],'07:00');
  assert.equal(headerSchedule([...refs,jewelry],date,'buyback',['bullion']).valid,true);
  assert.equal(auditBullionBuyback(tx(),[...refs,jewelry]).status,'Masih dalam batas range acuan');
  const noTime=auditBullionBuyback(tx(undefined,{time:''}),refs); assert.equal(noTime.status,'Perlu diperhatikan'); assert.equal(noTime.comparisons[0].rate,2367000);
  assert.equal(auditBullionBuyback(tx(undefined,{time:'08:15:19'}),refs).comparisons[0].rate,2367000);
  assert.equal(auditBullionBuyback(tx(),[refs[0],{...refs[1],effectiveFrom:null}]).status,'Perlu diperhatikan');
  assert.equal(auditBullionBuyback(tx(),[ref(1,[rule('ANTAM_YEAR',1,2367000,2026),rule('ANTAM_YEAR',1,2368000,2026)])]).status,'Perlu diperhatikan');
});

test('untimed bullion files retain exact-price compatibility without selecting a nearest batch',()=>{
  const untimed=refs.map(item=>({...item,effectiveFrom:null}));
  assert.equal(auditBullionBuyback(tx(),untimed).batch,'Batch 1');
  assert.equal(auditBullionBuyback(tx(undefined,{pricePerGram:2370000}),untimed).batch,'Tidak teridentifikasi');
  const ambiguous=auditBullionBuyback(tx(),[untimed[0],{...untimed[1],rows:untimed[0].rows}]); assert.equal(ambiguous.status,'Perlu diperhatikan');
});

test('authorization descriptions and remarks accompany bullion prices without overriding the audit result',()=>{
  const row=auditBullionBuyback(tx(undefined,{pricePerGram:2390000,aboveNoteAuthorization:{status:'Ada otorisasi',description:'PEMBELIAN DI ATAS NOTA',note:'FB1: Disetujui supervisor'}}),refs);
  const table=bullionBuybackReportTable([row],refs),cell=(name:string)=>table.rows[0][table.columns.indexOf(name)];
  assert.equal(cell('Hasil Pemeriksaan'),'Di luar range acuan'); assert.equal(cell('Otorisasi di Atas Nota'),'Ada otorisasi');
  assert.equal(cell('Deskripsi Otorisasi'),'PEMBELIAN DI ATAS NOTA'); assert.equal(cell('Keterangan Otorisasi'),'FB1: Disetujui supervisor');
});
