import type { BullionPriceBasis, BullionProduct, PriceReference } from './price-audit.logic';
import { BULLION_GROUPS, bullionIdentity, type BullionTransaction } from './bullion-buyback.logic';
import { BUYBACK_STATUSES } from './buyback-audit.logic';
import { headerSchedule, inHeaderPeriod, priceReferenceParts } from './price-reference-periods';
import type { AgentResponseBlock } from './response-blocks';

type SalesIdentity={product:BullionProduct|null;year:number|null;label:string;reason:string;namedLabel?:string};
type SalesComparison={batch:number|null;sourceRate:number|null;sourceBasis:BullionPriceBasis|null;rate:number|null;actual:number|null;difference:number|null;reason:string};
export type BullionMarketplaceRow=BullionTransaction&{identity:SalesIdentity;comparisons:SalesComparison[];batch:string;period:string;status:typeof BUYBACK_STATUSES[number];reason:string;reference:string};
export type BullionPieceAuditMode='per-gram'|'per-piece';
const textKey=(value:string)=>value.toUpperCase().replace(/[^A-Z0-9]+/g,' ').trim().replace(/\s+/g,' ');
const positive=(value:number|null):value is number=>value!==null&&Number.isFinite(value)&&value>0;
const money=(value:number)=>`Rp${new Intl.NumberFormat('id-ID',{maximumFractionDigits:6}).format(Math.abs(value))}`;
const rawLabels=(references:PriceReference[])=>references.flatMap(ref=>[
  ...ref.rows.filter(row=>row.family==='bullion'&&row.kind==='sales'&&row.bullionProduct==='NAMED_PRODUCT').map(row=>row.sourceLabel||''),
  ...(ref.unavailableBullion??[]).filter(row=>row.kind==='sales'&&row.product==='NAMED_PRODUCT').map(row=>row.sourceLabel),
]).filter(Boolean);

/** Explicit product labels on the uploaded file outrank generic Antam names/years. */
export function bullionSalesIdentity(name:string,references:PriceReference[]):SalesIdentity{
  const key=textKey(name), padded=` ${key} `;
  const unknown=(reason:string):SalesIdentity=>({product:null,year:null,label:'Belum dapat ditentukan',reason});
  if(!key||name.trim()==='-'||/^(?:[A-F\d]{2})+$/i.test(name.trim()))return unknown('Nama barang belum tersedia atau belum dapat didekripsi.');
  if(/\b(?:PERAK|SILVER)\b/.test(key))return unknown('Barang perak tidak termasuk audit harga logam mulia emas.');
  const labels=new Map<string,string>();for(const label of rawLabels(references))labels.set(textKey(label),label.trim());
  const matched=[...labels].filter(([label])=>padded.includes(` ${label} `)||(label==='MICRO GOLD'&&/\bMICRO\b/.test(key)));
  if(matched.length>1)return unknown('Nama barang cocok dengan beberapa kategori produk pada file; kategori tidak dipilih dari harganya.');
  if(matched.length===1)return {product:'NAMED_PRODUCT',year:null,label:matched[0][1],namedLabel:matched[0][0],reason:`Nama barang sesuai kategori ${matched[0][1]} yang tercetak pada file.`};
  // Known special markers must never silently fall back to ordinary Antam when
  // the required piece-price table is missing or entirely unreadable.
  if(/\b(?:GIFT|MICRO|SERIES|MINI|THIN|HA)\b/.test(key))return unknown('Nama barang menyebut produk khusus, tetapi kategori harga produk tersebut belum tersedia pada file.');
  if(/\bEMAS\s*KITA\b/.test(key))return {product:'EMAS_KITA',year:null,label:'Emas Kita',reason:'Nama barang menyebut Emas Kita.'};
  if(/\bUBS\b/.test(key))return {product:'UBS',year:null,label:'UBS',reason:'Nama barang menyebut UBS.'};
  if(/\b(?:LOTUS|ARCHI)\b/.test(key))return {product:'LOTUS_ARCHI',year:null,label:'Lotus Archi',reason:'Nama barang menyebut Lotus/Archi.'};
  return bullionIdentity(name);
}

export function auditBullionMarketplace(tx:BullionTransaction,references:PriceReference[],pieceMode:BullionPieceAuditMode='per-gram',tolerance=0):BullionMarketplaceRow{
  const dated=priceReferenceParts(references).filter(ref=>ref.date===tx.date&&ref.rows.some(row=>row.family==='bullion'&&row.kind==='sales'));
  const identity=bullionSalesIdentity(tx.name,dated);
  const base:BullionMarketplaceRow={...tx,identity,comparisons:[],batch:'Belum dapat ditentukan',period:'Belum dapat ditentukan',status:BUYBACK_STATUSES[2],reason:'',reference:[...new Set(dated.map(ref=>ref.filename))].join('; ')};
  const review=(reason:string):BullionMarketplaceRow=>({...base,reason});
  if(tx.kind!=='sales'||!BULLION_GROUPS.includes(tx.group as typeof BULLION_GROUPS[number]))return review('Transaksi bukan penjualan pada grup LM/LMM.');
  if(!tx.marketplace||['-','ALL','SEMUA'].includes(tx.marketplace.toUpperCase()))return review('Transaksi bukan penjualan marketplace yang dapat diperiksa.');
  if(!identity.product)return review(identity.reason);
  const matchesIdentity=(product:BullionProduct|undefined,year:number|null|undefined,label:string|undefined)=>product===identity.product&&(product!=='ANTAM_YEAR'||year===identity.year)&&(product!=='NAMED_PRODUCT'||textKey(label||'')===identity.namedLabel);
  const parts=dated.filter(ref=>ref.rows.some(row=>row.family==='bullion'&&row.kind==='sales'&&matchesIdentity(row.bullionProduct,row.bullionYear,row.sourceLabel))||(ref.unavailableBullion??[]).some(row=>row.kind==='sales'&&matchesIdentity(row.product,row.year,row.sourceLabel)));
  if(!parts.length)return review(`Acuan harga penjualan ${identity.label} belum tersedia untuk tanggal transaksi ini.`);
  base.reference=[...new Set(parts.map(ref=>ref.filename))].join('; ');
  const groups=new Map<string,PriceReference[]>();for(const ref of parts){const key=ref.batch==null?ref.id:String(ref.batch);groups.set(key,[...(groups.get(key)??[]),ref]);}
  base.comparisons=[...groups.values()].map(refs=>{
    const rules=refs.flatMap(ref=>ref.rows.filter(row=>row.family==='bullion'&&row.kind==='sales'&&matchesIdentity(row.bullionProduct,row.bullionYear,row.sourceLabel)&&positive(tx.weight)&&(row.bullionWeightGram===tx.weight||identity.product==='OTHER_LM'&&row.bullionWeightGram===null)));
    const values=new Set(rules.map(row=>`${row.rate}:${row.bullionPriceBasis??'PER_GRAM'}`));
    const valid=refs.every(ref=>ref.complete)&&values.size===1&&rules.every(row=>positive(row.rate)&&(row.maxRate===null||row.maxRate===row.rate));
    const rule=valid?rules[0]:null,sourceBasis=rule?.bullionPriceBasis??(rule?'PER_GRAM':null);
    const asPiece=pieceMode==='per-piece'&&sourceBasis==='PER_PIECE';
    const rate=rule?sourceBasis==='PER_PIECE'&&!asPiece?Number((rule.rate/rule.bullionWeightGram!).toFixed(0)):rule.rate:null;
    const actual=asPiece?tx.price:tx.pricePerGram;
    return {batch:refs[0].batch??null,sourceRate:rule?.rate??null,sourceBasis,rate,actual,difference:rate!==null&&positive(actual)?actual-rate:null,
      reason:!rules.length?`Tarif ${identity.label} untuk berat ${tx.weight??'belum diketahui'} gram belum tersedia pada file.`:!valid?'Tarif atau satuan acuan belum tunggal, atau pembacaan file belum lengkap.':''};
  }).sort((a,b)=>(a.batch??Infinity)-(b.batch??Infinity));
  const schedule=headerSchedule(parts,tx.date,'sales',['bullion']);let selected:SalesComparison|undefined;
  if(schedule.hasTimes){
    if(!schedule.valid)return review(schedule.reason);
    if(!/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(tx.time))return review('Jam transaksi belum tersedia atau tidak valid; batch penjualan belum dapat ditentukan.');
    const period=schedule.periods.find(item=>inHeaderPeriod(tx.time,item));
    if(!period)return review(`Transaksi terjadi sebelum acuan penjualan pertama berlaku pukul ${schedule.periods[0].fromTime} WIB.`);
    base.batch=`Batch ${period.batch}`;base.period=`${period.fromTime}–${period.toTime==='24:00'?'akhir hari':`sebelum ${period.toTime}`} WIB`;
    selected=base.comparisons.find(item=>item.batch===period.batch);
    if(!selected||selected.rate===null)return review(selected?.reason||'Tarif batch transaksi belum tersedia.');
    if(selected.difference===null)return review('Harga transaksi yang perlu diperiksa belum tersedia; harga tidak dihitung dari total faktur atau biaya marketplace.');
  }else{
    const matched=base.comparisons.filter(item=>item.batch!==null&&item.difference===0),unresolved=base.comparisons.some(item=>item.rate===null||item.batch===null||item.difference===null);
    if(unresolved||matched.length>1)return review('Jam tidak tercantum dan acuan belum lengkap atau lebih dari satu batch sesuai; batch tunggal belum dapat ditentukan.');
    if(matched.length===1){selected=matched[0];base.batch=`Batch ${selected.batch}`;}
    else return {...base,status:BUYBACK_STATUSES[1],batch:'Tidak teridentifikasi',period:'Jam tidak tercantum pada file',reason:`${identity.reason} Harga berbeda dari seluruh acuan kategori dan berat yang tersedia; batch tidak dipilih dari harga terdekat.`};
    base.period='Jam tidak tercantum pada file';
  }
  const delta=selected!.difference!,within=Math.abs(delta)<=tolerance;
  const conversion=selected!.sourceBasis==='PER_PIECE'&&pieceMode==='per-gram'?` Acuan file per piece ${money(selected!.sourceRate!)} dibagi berat ${tx.weight} gram untuk dibandingkan dengan harga_gram.`:'';
  return {...base,status:within?BUYBACK_STATUSES[0]:BUYBACK_STATUSES[1],reason:`${identity.reason} ${base.batch}. ${within?'Harga transaksi masih dalam acuan.':`Harga penjualan lebih ${delta<0?'rendah':'tinggi'} ${money(delta)} dari acuan ${money(selected!.rate!)}.`}${conversion}`};
}

export function bullionMarketplaceReportTable(rows:BullionMarketplaceRow[],references:PriceReference[],pieceMode:BullionPieceAuditMode='per-gram'):Extract<AgentResponseBlock,{type:'table'}>{
  const batches=[...new Set(priceReferenceParts(references).filter(ref=>ref.rows.some(rule=>rule.family==='bullion'&&rule.kind==='sales')).map(ref=>ref.batch??null))].sort((a,b)=>(a??Infinity)-(b??Infinity));
  const batchColumns=batches.flatMap(batch=>{const label=batch===null?'file tanpa batch':`Batch ${batch}`;return [`Tarif File ${label} (IDR)`,`Acuan ${label} (IDR)`,`Selisih ${label} (IDR)`];});
  return {type:'table',title:'Audit harga penjualan marketplace logam mulia',columns:['Tanggal','Jam WIB','Toko','Marketplace','No. Faktur','Grup Faktur','Barcode','Nama Barang','Kode Grup','Kategori Acuan','Berat (gram)','Harga Jual (IDR)','Ongkos (IDR)','Pengembalian Kelebihan Pembayaran (IDR)','Harga Transaksi per gram (IDR)','Satuan Harga File','Dasar Pemeriksaan',...batchColumns,'Batch Acuan','Berlaku WIB','Hasil Pemeriksaan','Keterangan Pemeriksaan','Otorisasi di Bawah Modal','Deskripsi Otorisasi','Keterangan Otorisasi','File Acuan','Input oleh'],rows:rows.map(row=>[row.date,row.time||'Belum tersedia',row.store,row.marketplace||'Belum tersedia',row.invoice,row.invoiceGroup||'Tidak tersedia',row.barcode||'Tidak tersedia',row.name,row.group,row.identity.label,row.weight,row.price,row.fee,row.overpayment??null,row.pricePerGram,
    [...new Set(row.comparisons.filter(item=>item.sourceBasis).map(item=>item.sourceBasis==='PER_PIECE'?'Per piece':'Per gram'))].join('; ')||'Belum dapat ditentukan',pieceMode==='per-gram'?'Per gram (harga_gram)':'Per gram: harga_gram; per piece: harga_jual',
    ...batches.flatMap(batch=>{const matches=row.comparisons.filter(item=>item.batch===batch),item=matches.length===1?matches[0]:null;const missing=item?.reason||'Acuan belum dapat ditentukan';return [item?.sourceRate??missing,item?.rate??missing,item?.difference??(item?.rate!==null&&item?.rate!==undefined?'Harga transaksi belum tersedia':missing)];}),
    row.batch,row.period,row.status,row.reason,row.belowCostAuthorization?.status??'Belum dapat diperiksa',row.belowCostAuthorization?.description??'Tidak ditemukan',row.belowCostAuthorization?.note??'Otorisasi belum diperiksa pada laporan ini.',row.reference||'Belum dapat ditentukan',row.inputBy])};
}
