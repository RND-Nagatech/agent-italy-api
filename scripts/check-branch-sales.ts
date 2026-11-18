import 'dotenv/config';
import assert from 'node:assert/strict';
async function main() {
  const base = `pantes_sales_qa_${Date.now()}`;
  process.env.SYSTEM_DATABASE_NAME = base; process.env.ENC_KEY_DEC = 'qa-key';
  const [{ MongoService }, { BranchSalesService, branchSalesPipeline }, { env }, { compactBranchSales, branchSalesBlocks }] = await Promise.all([import('../src/database/mongo.service'), import('../src/agent/branch-sales.service'), import('../src/config/env'), import('../src/agent/branch-sales.blocks')]);
  const mongo = new MongoService(); await mongo.onModuleInit();
  const sources = [{ branchId: 'FCL', alias: 'FCL', databaseName: base + '_fcl', sourceType: 'branch' as const }, { branchId: 'CWK', alias: 'CWK', databaseName: base + '_cwk', sourceType: 'branch' as const }];
  const encrypt = (text: string) => { let i = 0, output = ''; for (const character of text) { output += (character.charCodeAt(0) + env.encKeyDec.charCodeAt(i)).toString(16).padStart(2, '0'); if (i === env.encKeyDec.length - 1) i = 0; i++; } return output; };
  const record = (kode_sales: unknown, kode_dept: string, berat: unknown, harga_total: number, extra = {}) => ({ kode_sales, kode_dept, berat, harga_total, tgl_system: '2026-10-29', status_kembali: 'OPEN', status_valid: 'DONE', status_tukar: false, trs_barang_tukar: false, ...extra });
  const args = { from: '2026-10-01', to: '2026-10-30' };
  try {
    const fcl = mongo.getDatabase(sources[0].databaseName), cwk = mongo.getDatabase(sources[1].databaseName);
    await fcl.collection('tt_jual_detail').insertMany([record('1','CN',10,1000),record(1,'GR',5,500),record('2','CN',20,2000),record('1','CN',null,50),record('1','CN',100,999,{status_valid:'CANC'}),record('1','CN',100,999,{status_kembali:'CLOS'}),record('1','CN',100,999,{status_tukar:true}),record('1','CN',100,999,{trs_barang_tukar:true}),record('1','CN',100,999,{tgl_system:'2026-09-30'})]);
    await cwk.collection('tt_jual_detail').insertOne(record('1','CN',8,800));
    await fcl.collection('tm_sales').insertMany([{kode_sales:1,nama_sales:encrypt('Sari'),no_hp:'PRIVATE',password:'SECRET'},{kode_sales:'2',nama_sales:encrypt('Tono')}]);
    await cwk.collection('tm_sales').insertOne({kode_sales:'1',nama_sales:encrypt('Budi')});
    for (const db of [fcl,cwk]) await db.collection('tm_dept').insertMany([{kode_dept:'CN',nama_dept:encrypt('CINCIN')},{kode_dept:'GR',nama_dept:encrypt('GELANG')}]);
    const service = new BranchSalesService(mongo);
    const summary = await service.read(false,args,sources);
    assert.equal(summary.branches[0].totals.weightGram,35); assert.equal(summary.branches[0].totals.salesAmountIdr,3550); assert.deepEqual(summary.branches[0].jenis,[]); assert.equal(summary.branches[0].totals.recordsWithoutWeight,1);
    const detail = await service.read(false,{...args,branchIds:['FCL'],includeJenis:true,pageSize:1},sources);
    assert.equal(detail.branches[0].jenis[0].kode,'CN'); assert.equal(detail.branches[0].jenis[0].nama,'CINCIN'); assert.equal(detail.branches[0].jenis[0].weightGram,30); assert.equal(detail.branches[0].hasMore,true); assert.equal(detail.branches[0].totals.weightGram,35);
    const second = await service.read(false,{...args,branchIds:['FCL'],includeJenis:true,pageSize:1,page:2},sources); assert.equal(second.branches[0].jenis[0].kode,'GR');
    const report = await service.read(true,args,sources);
    const sari = report.branches[0].salespeople.find((row: any)=>row.salesCode==='1'); assert.equal(sari.salesName,'Sari'); assert.equal(sari.weightGram,15); assert.equal(sari.jenis.length,2); assert.equal(report.branches[1].salespeople[0].salesName,'Budi'); assert.equal(report.branches[1].salespeople[0].weightGram,8);
    assert(!JSON.stringify(report).includes('PRIVATE')); assert(!JSON.stringify(report).includes('SECRET')); assert(!JSON.stringify(report).includes(encrypt('Sari')));
    const filtered = await service.read(true,{...args,branchIds:['FCL'],salesCode:'1',jenisPageSize:1},sources); assert.equal(filtered.branches[0].salespeople[0].jenisHasMore,true); assert.equal(filtered.branches[0].totals.weightGram,15);
    const next = await service.read(true,{...args,branchIds:['FCL'],salesCode:'1',jenisPageSize:1,jenisPage:2},sources); assert.equal(next.branches[0].salespeople[0].jenis[0].kode,'GR');
    const salesPage = await service.read(true,{...args,branchIds:['FCL'],pageSize:1},sources); assert.equal(salesPage.branches[0].salespeople.length,1); assert.equal(salesPage.branches[0].totals.weightGram,35); assert.equal(salesPage.branches[0].hasMore,true);
    const jenisFilter = await service.read(true,{...args,branchIds:['FCL'],salesCode:'1',jenisCode:'CN'},sources); assert.equal(jenisFilter.branches[0].totals.weightGram,10); assert.equal(jenisFilter.branches[0].totals.salesAmountIdr,1050);
    const savedKey = env.encKeyDec; env.encKeyDec = '';
    const undecoded = await service.read(true,{...args,branchIds:['FCL'],salesCode:'1'},sources);
    assert.equal(undecoded.branches[0].salespeople[0].salesName,'Sales 1'); assert.equal(undecoded.branches[0].salespeople[0].salesNameUnavailable,true);
    env.encKeyDec = savedKey;
    const { AgentService } = await import('../src/agent/agent.service');
    const { Role } = await import('../src/users/roles');
    const agent = new (AgentService as any)({},null,null,null,null,null,null,null,null,null,null,null,null,null,service);
    const principal = { sub:'qa',role:Role.Branch,branchId:'FCL' };
    agent.getAllowedSources = async () => [sources[0]];
    let calls = 0;
    agent.requestModel = async (_messages: any[], tools: any[]) => {
      assert(tools.some(tool=>tool.function.name==='get_sales_by_salesperson'));
      return { choices:[{finish_reason:'stop',message:++calls===1 ? {role:'assistant',tool_calls:[{id:'qa-sales',type:'function',function:{name:'get_sales_by_salesperson',arguments:JSON.stringify({...args,branchIds:['FCL']})}}]} : {role:'assistant',content:JSON.stringify({blocks:[{type:'text',text:'Penjualan valid per sales.'}]})}}] };
    };
    const answer = await agent.runChat({messages:[{role:'user',content:'Penjualan cabang saya per sales dan Jenis pada Oktober'}]},principal);
    assert(answer.blocks.some((block:any)=>block.type==='table'&&block.title==='Rincian Jenis per sales')); assert(JSON.stringify(answer).includes('Sari')); assert(!JSON.stringify(answer).includes('Budi'));
    const denied = JSON.parse(await agent.executeTool({id:'denied',type:'function',function:{name:'get_sales_by_salesperson',arguments:JSON.stringify({...args,branchIds:['CWK']})}},[sources[0]],new Map(),Role.Branch,undefined,principal)); assert(denied.error);
    await fcl.collection('tm_sales').insertOne({kode_sales:'1',nama_sales:encrypt('Duplikat')});
    const dup = await service.read(true,{...args,branchIds:['FCL'],salesCode:'1'},sources); assert.equal(dup.branches[0].totals.weightGram,15); assert.equal(dup.branches[0].salespeople[0].salesNameUnavailable,true); assert.equal(dup.branches[0].salespeople[0].salesName,'Sales 1');
    const missing = await service.read(true,args,[sources[0],{branchId:'EMPTY',alias:'Empty',databaseName:base+'_empty',sourceType:'branch'}]); assert.equal(missing.partial,true); assert.equal(missing.branches[1].status,'unavailable'); assert.equal(missing.branches[1].totals,undefined);
    const zero = await service.read(true,{...args,salesCode:'404'},sources); assert.equal(zero.branches[0].totals.weightGram,0); assert.equal(zero.branches[0].status,'available');
    await assert.rejects(()=>service.read(true,{...args,branchIds:['CWK']},[sources[0]]));
    await assert.rejects(()=>service.read(true,{...args,pageSize:21},sources));
    await assert.rejects(()=>service.read(true,{...args,from:'2026-02-30'},sources));
    await assert.rejects(()=>service.read(true,{...args,from:'2024-01-01'},sources));
    const blocks = branchSalesBlocks(compactBranchSales(report)); assert(blocks.some(block=>block.type==='table'&&block.title==='Rincian Jenis per sales')); assert(JSON.stringify(blocks).includes('Sari')); assert(!JSON.stringify(blocks).includes('SECRET'));
    const pipe = branchSalesPipeline(true,args); assert.equal(pipe[0].$match.status_valid,'DONE'); assert.equal(pipe[0].$match.status_kembali,'OPEN'); assert(!JSON.stringify(pipe).includes('$unwind'));
    console.log('PASS branch sales: real isolated Mongo aggregates, branch → sales → Jenis, decrypted names, same-code branch isolation, duplicate master without fan-out, gram/IDR totals, pagination, scope, missing data and safe blocks.');
  } finally {
    for (const name of [base,...sources.map(source=>source.databaseName)]) { assert(name.startsWith('pantes_sales_qa_')); await mongo.getDatabase(name).dropDatabase(); }
    await mongo.onModuleDestroy();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1});
