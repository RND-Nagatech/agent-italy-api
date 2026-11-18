// Offline checks: mock databases and model; no live credentials or network calls.
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017';
process.env.SYSTEM_DATABASE_NAME = 'atomic_check';
process.env.JWT_ACCESS_SECRET = 'offline-atomic-check-secret-at-least-32-characters';
process.env.DEEPSEEK_API_KEY = 'offline-model';
const assert = require('node:assert/strict');
const { AtomicDataService, atomicPipeline, atomicRange } = require('../dist/src/agent/atomic-data.service');
const { AgentService } = require('../dist/src/agent/agent.service');
const { parseAgentResponseBlocks, normalizeAgentResponseBlocks, agentResponseBlocksToText } = require('../dist/src/agent/response-blocks');
const args = { from: '2026-10-01', to: '2026-10-28', branchIds: ['FCL'] };
const allowed = [{ branchId: 'FCL', alias: 'FCL', sourceType: 'branch', databaseName: 'branch_fcl' }];
(async () => {
  assert.throws(() => atomicRange({from: '2026-02-30', to: '2026-03-01'}));
  assert.throws(() => atomicRange({from: '2026-10-28', to: '2026-10-01'}));
  assert.equal(atomicRange({from: '2026-10-28', to: '2026-10-28'}).to.toISOString(), '2026-10-28T17:00:00.000Z');
  const sales = atomicPipeline('sales', args);
  assert.deepEqual(sales[0].$match, { status_kembali: 'OPEN', status_valid: 'DONE', status_tukar: {$ne:true}, trs_barang_tukar: {$ne:true} });
  assert.deepEqual(sales[1].$match.tgl_system, {$gte:args.from,$lte:args.to});
  const stock = atomicPipeline('stock', {});
  assert.deepEqual(stock[0].$match, {status_hancur:false,stock_on_hand:{$gt:0}});
  assert.equal(JSON.stringify(stock).includes('deleted_by'), false);
  assert.equal(JSON.stringify(stock).includes('$multiply'), true);
  const shipments = atomicPipeline('shipments', {...args,shipmentStatus:'OPEN'},'FCL');
  assert.deepEqual(shipments[0].$match,{tujuan:'FCL',status_terima:'OPEN'});
  assert.equal(atomicPipeline('buyback', args)[0].$match.status_valid.$ne,'CANC');
  const databases=[];
  const service = new AtomicDataService({getDatabase: database => {
    databases.push(database);
    return {listCollections:()=>({hasNext:async()=>true}),collection:()=>({aggregate:()=>({toArray:async()=>[{rows:[{_id:{jenis:'CN',status:'OPEN'},weightGram:12,recordsWithoutWeight:0}],totals:[{weightGram:12,salesAmountIdr:0,recordsWithoutWeight:0,groups:1}]}]}),find:()=>({limit:()=>({toArray:async()=>[]})})})};
  }});
  await assert.rejects(service.read('stock', args, allowed));
  await assert.rejects(service.read('sales', {...args,branchIds:['OTHER']}, allowed));
  const result = await service.read('shipments',args,allowed);
  assert.equal(result.partial,false); assert.equal(result.branches[0].totals.weightGram,12);
  assert.notEqual(databases[0],'branch_fcl'); // Shipment documents come from the central DB.
  const unavailable = await new AtomicDataService({getDatabase:()=>({listCollections:()=>({hasNext:async()=>false})})}).read('sales',args,allowed);
  assert.equal(unavailable.partial,true); assert.equal(unavailable.branches[0].status,'unavailable'); assert.equal(unavailable.branches[0].totals,undefined);
  const blocks = normalizeAgentResponseBlocks(parseAgentResponseBlocks(JSON.stringify({blocks:[{type:'comparison',title:'Berat terjual',leftLabel:'FCL',leftValue:100,rightLabel:'CWK',rightValue:0,unit:'gram'},{type:'analysis',title:'Analisis',summary:'Perbandingan gram',findings:['Temuan'],actions:['Periksa stok']}]})));
  assert.equal(blocks.length,2); assert.match(agentResponseBlocksToText(blocks),/100 gram/);
  assert.equal(parseAgentResponseBlocks(JSON.stringify({blocks:[{type:'comparison',title:'Invalid',leftLabel:'A',leftValue:'100',rightLabel:'B',rightValue:1,unit:'gram'}]})).some(b=>b.type==='comparison'),false);
  const agent = new AgentService();
  agent.getAllowedSources = async()=>allowed;
  let round=0, active=0, maximum=0; const ids=[];
  agent.requestModel = async messages => {
    if(round++===0) return {choices:[{message:{role:'assistant',content:null,tool_calls:['get_sales_period','get_current_stock','get_shipments_period','get_buyback_period'].map((name,i)=>({id:String(i),type:'function',function:{name,arguments:'{}'}}))}}]};
    ids.push(...messages.filter(m=>m.role==='tool').map(m=>m.tool_call_id));
    return {choices:[{message:{role:'assistant',content:JSON.stringify({blocks:[{type:'text',text:'Pembacaan gabungan selesai.'}]})},finish_reason:'stop'}]};
  };
  agent.executeTool = async call => { active++; maximum=Math.max(maximum,active); await new Promise(resolve=>setTimeout(resolve,5)); active--; return JSON.stringify({mode:call.function.name,branches:[]}); };
  const answer = await agent.runChat({messages:[{role:'user',content:'Bandingkan keempat data'}]}, {sub:'test',role:'admin'});
  assert.equal(maximum,2); assert.deepEqual(ids,['0','1','2','3']); assert.match(answer.answer,/selesai/);
  console.log('PASS: period boundaries, filters, branch scope, central shipments, partial data, blocks, four calls/concurrency=2 and tool_call_id correlation. No live database/model.');
})().catch(error=>{ console.error(error);process.exitCode=1; });
