import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditBullionMarketplace, bullionMarketplaceReportTable, bullionSalesIdentity } from '../src/agent/bullion-marketplace.logic';
import type { BullionTransaction } from '../src/agent/bullion-buyback.logic';
import type { BullionPriceBasis, BullionProduct, PriceReference, PriceRule } from '../src/agent/price-audit.logic';

const date='2026-11-25';
const rule=(product:BullionProduct,label:string,weight:number,rate:number,basis:BullionPriceBasis='PER_GRAM',year:number|null=null):PriceRule=>({family:'bullion',kind:'sales',kadar:null,sourceCode:`${label}:${weight}`,sourceLabel:label,rate,maxRate:null,fee:null,feeType:'unknown',condition:'ANY',note:'',bullionProduct:product,bullionYear:year,bullionWeightGram:weight,bullionPriceBasis:basis});
const ref=(batch:number,rows:PriceRule[],time:string|null='13:07:32'):PriceReference=>({id:`r${batch}`,filename:`sales-${batch}.png`,date,batch,effectiveFrom:time,complete:true,warnings:[],rows});
const first=ref(1,[rule('ANTAM_YEAR','ANTAM 2026',0.5,2628000,'PER_GRAM',2026),rule('ANTAM_YEAR','ANTAM 2026',1,2497000,'PER_GRAM',2026),rule('ANTAM_REDMARK','ANTAM Red Mark',1,2370000),rule('ANTAM_RETRO','ANTAM Retro',1,2365000),rule('EMAS_KITA','Emas Kita',1,2331000),rule('EMASKU','Emasku',1,2220000),rule('UBS','UBS',1,2234000),rule('NAMED_PRODUCT','Gift',0.5,1425000,'PER_PIECE'),rule('NAMED_PRODUCT','Micro Gold',0.1,294000,'PER_PIECE'),rule('NAMED_PRODUCT','HA',0.25,622000,'PER_PIECE'),rule('NAMED_PRODUCT','Series',0.5,1203000,'PER_PIECE'),rule('NAMED_PRODUCT','Mini',0.1,315000,'PER_PIECE'),rule('NAMED_PRODUCT','Thin',0.2,896000,'PER_PIECE')]);
const tx=(name='ANTAM CERTI EYE RED 2026',extra:Partial<BullionTransaction>={}):BullionTransaction=>({id:'J1',kind:'sales',store:'Italy',date,time:'14:00:00',invoice:'J1',marketplace:'TIKTOK',group:'LM',name,kadar:null,weight:1,price:2497000,pricePerGram:2497000,fee:25000,quantity:1,inputBy:'Kasir',condition:'',...extra});

test('marketplace bullion names match the printed brands and special product headings before Antam year fallback',()=>{
  assert.equal(bullionSalesIdentity('ANTAM GIFT 2026',[first]).product,'NAMED_PRODUCT');assert.equal(bullionSalesIdentity('ANTAM GIFT 2026',[first]).label,'Gift');
  for(const [name,label] of [['ANTAM MICRO 2026','Micro Gold'],['LM HA','HA'],['ANTAM SERIES','Series'],['ANTAM MINI','Mini'],['ANTAM THIN','Thin'],['EMASKITA','Emas Kita'],['LOGAM MULIA EMASKU','EMASKU'],['LM UBS','UBS'],['LM LOTUS','Lotus Archi'],['LM ARCHI','Lotus Archi']])assert.equal(bullionSalesIdentity(name,[first]).label,label);
  assert.equal(bullionSalesIdentity('ANTAM CERTI EYE RED 2026',[first]).label,'ANTAM 2026');
  assert.equal(bullionSalesIdentity('ANTAM RETRO',[first]).product,'ANTAM_RETRO');
  assert.equal(bullionSalesIdentity('ANTAM GIFT 2026',[]).product,null,'a missing special-product reference must not fall back to ordinary Antam');
  assert.equal(bullionSalesIdentity('ANTAM GIFT MINI',[first]).product,null);assert.notEqual(bullionSalesIdentity('HALLAGOLD ANTAM 2026',[first]).label,'HA');
});

test('per-gram sales read stored harga_gram and do not add fees or derive it from invoice totals',()=>{
  const row=auditBullionMarketplace(tx(undefined,{price:1234567,fee:987654}),[first]);assert.equal(row.status,'Masih dalam batas range acuan');assert.equal(row.comparisons[0].rate,2497000);
  assert.equal(auditBullionMarketplace(tx(undefined,{pricePerGram:null,price:2497000}),[first]).status,'Perlu diperhatikan');
  assert.equal(auditBullionMarketplace(tx(undefined,{marketplace:'-'}),[first]).status,'Perlu diperhatikan');
});

test('piece prices keep their printed value and convert only the reference for a harga_gram comparison',()=>{
  const gift=auditBullionMarketplace(tx('ANTAM GIFT 2026',{weight:0.5,price:1425000,pricePerGram:2850000,quantity:3}),[first]);
  assert.equal(gift.identity.label,'Gift');assert.equal(gift.comparisons[0].sourceRate,1425000);assert.equal(gift.comparisons[0].sourceBasis,'PER_PIECE');assert.equal(gift.comparisons[0].rate,2850000);assert.equal(gift.comparisons[0].difference,0);assert.equal(gift.status,'Masih dalam batas range acuan');
  const micro=auditBullionMarketplace(tx('ANTAM MICRO GOLD',{weight:0.1,pricePerGram:2940000}),[first]);assert.equal(micro.status,'Masih dalam batas range acuan');
  const misleading=auditBullionMarketplace(tx('ANTAM GIFT',{weight:0.5,pricePerGram:1425000}),[first]);assert.equal(misleading.status,'Di luar range acuan');
  const decimal=ref(1,[rule('NAMED_PRODUCT','Gift',0.3,299000,'PER_PIECE')]);assert.equal(auditBullionMarketplace(tx('GIFT',{weight:0.3,pricePerGram:996667}),[decimal]).status,'Masih dalam batas range acuan','reference normalization follows the source backend integer harga_gram storage');
});

test('piece-mode support uses the stored per-unit selling field without dividing by quantity',()=>{
  const row=auditBullionMarketplace(tx('ANTAM GIFT',{weight:0.5,price:1425000,pricePerGram:null,quantity:2}),[first],'per-piece');
  assert.equal(row.status,'Masih dalam batas range acuan');assert.equal(row.comparisons[0].rate,1425000);assert.equal(row.comparisons[0].actual,1425000);
});

test('empty product/weight cells remain unavailable, including a named category with every tariff blank',()=>{
  const refs={...first,unavailableBullion:[{kind:'sales' as const,product:'NAMED_PRODUCT' as const,year:null,weightGram:0.5,priceBasis:'PER_PIECE' as const,sourceLabel:'Gift'},{kind:'sales' as const,product:'LOTUS_ARCHI' as const,year:null,weightGram:1,priceBasis:'PER_GRAM' as const,sourceLabel:'Lotus Archi'}],rows:first.rows.filter(row=>row.sourceLabel!=='Gift')};
  const blank=auditBullionMarketplace(tx('ANTAM GIFT 2026',{weight:0.5,pricePerGram:2628000}),[refs]);assert.equal(blank.identity.label,'Gift');assert.equal(blank.status,'Perlu diperhatikan');assert.equal(blank.batch,'Batch 1');
  assert.equal(auditBullionMarketplace(tx('LOTUS'),[refs]).status,'Perlu diperhatikan');
  assert.equal(auditBullionMarketplace(tx('EMASKU',{weight:3,pricePerGram:2220000}),[first]).status,'Perlu diperhatikan');
  assert.equal(auditBullionMarketplace(tx('ANTAM 2025'),[first]).status,'Perlu diperhatikan');
});

test('sales header seconds and later batches are authoritative, even if another batch price matches',()=>{
  const second=ref(2,[rule('ANTAM_YEAR','ANTAM 2026',1,2500000,'PER_GRAM',2026)],'15:12:10'),third=ref(3,[rule('ANTAM_YEAR','ANTAM 2026',1,2510000,'PER_GRAM',2026)],'18:00');
  const refs=[first,second,third];assert.equal(auditBullionMarketplace(tx(undefined,{time:'13:07:31'}),refs).status,'Perlu diperhatikan');assert.equal(auditBullionMarketplace(tx(undefined,{time:'15:12:09'}),refs).batch,'Batch 1');
  const wrong=auditBullionMarketplace(tx(undefined,{time:'15:12:10'}),refs);assert.equal(wrong.batch,'Batch 2');assert.equal(wrong.status,'Di luar range acuan');assert.equal(wrong.comparisons[1].difference,-3000);
  const table=bullionMarketplaceReportTable([wrong],refs);assert.equal(table.rows[0][table.columns.indexOf('Acuan Batch 3 (IDR)')],2510000);assert.equal(table.rows[0].length,table.columns.length);
  const buy={...second,id:'buy',effectiveFrom:'07:00',rows:second.rows.map(row=>({...row,kind:'buyback' as const,rate:1}))};assert.equal(auditBullionMarketplace(tx(),[first,buy]).status,'Masih dalam batas range acuan');
});

test('known prices, authorizations and overpayments remain visible when clocks or rates are missing',()=>{
  const row=auditBullionMarketplace(tx(undefined,{time:'',overpayment:0,belowCostAuthorization:{status:'Ada otorisasi',description:'PENJUALAN DI BAWAH MODAL',note:'J1: Persetujuan harga'}}),[first]);assert.equal(row.comparisons[0].rate,2497000);assert.equal(row.status,'Perlu diperhatikan');
  const table=bullionMarketplaceReportTable([row],[first]),cell=(column:string)=>table.rows[0][table.columns.indexOf(column)];assert.equal(cell('Otorisasi di Bawah Modal'),'Ada otorisasi');assert.equal(cell('Deskripsi Otorisasi'),'PENJUALAN DI BAWAH MODAL');assert.equal(cell('Pengembalian Kelebihan Pembayaran (IDR)'),0);
});
