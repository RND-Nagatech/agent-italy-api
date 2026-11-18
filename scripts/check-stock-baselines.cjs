process.env.MONGODB_URI='mongodb://127.0.0.1:27017';
process.env.SYSTEM_DATABASE_NAME='baseline_offline';
process.env.JWT_ACCESS_SECRET='baseline-check-secret-at-least-32-characters';
process.env.DEEPSEEK_API_KEY='offline';
require('reflect-metadata');
const assert=require('node:assert/strict');
const {MongoClient,ObjectId}=require('mongodb');
const {StockBaselineService,baselineFor}=require('../dist/src/stock-baselines/stock-baseline.service');
const {RestockRecommendationService}=require('../dist/src/agent/restock-recommendation.service');
const {NetworkRestockRecommendationService}=require('../dist/src/agent/network-restock-recommendation.service');
const {AgentService}=require('../dist/src/agent/agent.service');
const {StockBaselineController}=require('../dist/src/stock-baselines/stock-baseline.controller');
const {normalizeAgentResponseBlocks}=require('../dist/src/agent/response-blocks');
(async()=>{
 const client=new MongoClient('mongodb://127.0.0.1:27017',{serverSelectionTimeoutMS:3000});await client.connect();
 const dbName=`pantes_baseline_qa_${Date.now()}`,centralName=`${dbName}_central`;
 const db=client.db(dbName),central=client.db(centralName);
 const mongo={db,getDatabase:name=>client.db(name)};
 const cleared=[],keys=[];
 const cache={clearByPrefix:prefix=>cleared.push(prefix),getOrLoadWithStatus:async(key,load)=>{keys.push(key);return {value:await load(),cacheStatus:'miss'}}};
 const actor=new ObjectId();
 const sources=[{branchId:'PUSAT',alias:'Pusat',sourceType:'central',databaseName:centralName,active:true},{branchId:'FCL',alias:'FCL',sourceType:'branch',databaseName:'offline_fcl',active:true},{branchId:'DNR',alias:'Donor',sourceType:'branch',databaseName:'offline_donor',active:true}];
 try{
  await db.collection('shipment_sources').insertMany([
    sources[0],
    ...sources.slice(1).map(({sourceType,...source},index)=>index===0?source:{...source,sourceType:null}),
    ...Array.from({length:29},(_,index)=>({branchId:`LEGACY${index}`,alias:`Legacy ${index}`,databaseName:`legacy_${index}`,active:index!==0})),
    {branchId:'GTS',alias:'PANTES KGTS',databaseName:'explicit_gts',sourceType:'branch',active:true},
  ]);
  await db.collection('users').insertOne({_id:actor,name:'QA owner',passwordHash:'never exposed',email:'private'});
  await central.collection('tm_dept').insertMany([{kode_dept:'CN',nama_dept:'CINCIN'},{kode_dept:'GA',nama_dept:'GELANG ANAK'}]);
  const service=new StockBaselineService(mongo,cache);
  assert.equal((await service.snapshot()).revision,0);
  const legacyCatalog=await service.catalog();
  assert.equal(legacyCatalog.branches.length,32);
  assert(legacyCatalog.branches.some(source=>source.branchId==='FCL'&&source.active));
  assert(legacyCatalog.branches.some(source=>source.branchId==='DNR'&&source.active));
  assert(legacyCatalog.branches.some(source=>source.branchId==='GTS'&&source.active));
  assert(!legacyCatalog.branches.some(source=>source.branchId==='PUSAT'));
  assert.equal(legacyCatalog.branches.find(source=>source.branchId==='LEGACY0').active,false);
  assert.equal(legacyCatalog.catalogWarning,null);
  const {SourcesService}=require('../dist/src/sources/sources.service');
  const sourceListing=await new SourcesService(mongo).list();
  assert.deepEqual(legacyCatalog.branches.map(source=>source.branchId).sort(),sourceListing.items.filter(source=>source.sourceType==='branch').map(source=>source.branchId).sort());
  const item=(branchId,jenisCode,baselinePcs,active=true)=>({branchId,jenisCode,baselinePcs,active,note:'QA'});
  let data=await service.update(0,[item('FCL','CN',339),item('DNR','CN',200),item('FCL','GA',10),item('DNR','GA',0)],actor.toString());
  assert.equal(data.revision,1);assert.equal(data.items.length,4);
  assert.deepEqual(baselineFor(data,'DNR','GA'),{baselinePcs:0,baselineConfigured:true});
  assert.deepEqual(baselineFor(data,'NONE','CN'),{baselinePcs:0,baselineConfigured:false});
  assert(cleared.includes('agent:restock:'));assert(cleared.includes('agent:network-restock:'));
  const history=await service.history();assert.equal(history.items[0].changes.length,4);assert.equal(history.items[0].actorName,'QA owner');assert(!JSON.stringify(history).includes('passwordHash'));
  for(const pcs of [-1,1.5,1000001,NaN])await assert.rejects(service.update(1,[item('FCL','CN',pcs)],actor.toString()));
  await assert.rejects(service.update(1,[item('INVALID','CN',1)],actor.toString()));
  await assert.rejects(service.update(1,[item('FCL','UNKNOWN',1)],actor.toString()));
  await assert.rejects(service.update(1,[item('FCL','CN',1),item('FCL','cn',2)],actor.toString()));
  await assert.rejects(service.update(0,[item('FCL','CN',1)],actor.toString()),error=>error.getStatus()===409);
  const sold=new Map([['CN',{recent:140,comparison:70,recentWeight:1400,comparisonWeight:700,recentRows:140,comparisonRows:70,recentRowsWithoutWeight:0,comparisonRowsWithoutWeight:0}]]);
  const stock=n=>new Map([['CN',{units:n,weight:n*10,rowsWithoutWeight:0}]]);
  const single=new RestockRecommendationService({},cache,service);
  single.readBranch=async source=>({source,sales:sold,stocks:stock(source.branchId==='FCL'?400:350),departmentNames:new Map([['CN','CINCIN']]),openIncoming:new Map()});
  single.readOpenShipments=async()=>new Map([['FCL',stock(20)]]);
  const result=await single.recommend(sources.slice(1),'FCL','2026-01'),cn=result.branches[0].jenis.find(row=>row.kode==='CN'),ga=result.branches[0].jenis.find(row=>row.kode==='GA');
  assert.equal(cn.baselinePcs,339);assert.equal(cn.weeklyDemandTargetUnits,140);assert.equal(cn.targetStockUnits,479);assert.equal(cn.recommendedRestockUnits,59);
  assert.equal(ga.recommendedRestockUnits,10);assert.equal(ga.baselinePcs,10);assert.equal(ga.weeklyDemandTargetUnits,0);
  assert.equal(result.baselineRevision,1);
  const network=new NetworkRestockRecommendationService({},cache,service);
  network.readSource=async source=>({source,sales:source.sourceType==='central'?new Map():sold,stock:stock(source.sourceType==='central'?40:source.branchId==='FCL'?400:350),jenisNames:new Map([['CN','CINCIN']])});
  network.readOpenShipments=async()=>({byBranchAndJenis:new Map([['FCL',stock(20)]]),byJenis:stock(20),openRows:20,unitsToUnconfiguredDestinations:0});
  const plan=await network.recommend(sources,'2026-01',{jenisCode:'CN'});
  assert.equal(plan.jenis[0].shortageBeforeTransfers,59);assert.equal(plan.jenis[0].baselinePcs,539);
  assert.equal(plan.transfers[0].from.branchId,'PUSAT');assert.equal(plan.transfers[0].quantity,20);
  assert.equal(plan.transfers[1].from.branchId,'DNR');assert.equal(plan.transfers[1].quantity,10);
  assert.equal(plan.totals.unfilledShortageUnits,29);
  const offered=await network.recommend(sources,'2026-01',{jenisCode:'CN',sourceBranchId:'PUSAT',availablePcs:500});
  assert.equal(offered.allocation.allocatedPcs,20);assert.equal(offered.allocation.remainingOfferedPcs,480);
  const agent=new AgentService({},single,network);
  const compact=JSON.parse(await agent.executeTool({id:'baseline',type:'function',function:{name:'suggest_restock_distribution',arguments:JSON.stringify({targetBranchId:'FCL',targetMonth:'2026-01'})}},sources,new Map(),'admin',undefined,{sub:actor.toString(),role:'admin',branchId:null}));
  assert.equal(compact.baselineRevision,1);assert.equal(compact.branches[0].jenis.find(row=>row.kode==='CN').baselinePcs,339);
  assert.equal(compact.transferPlan.totalUnallocatedUnits,39); // CN 29 + GA 10.
  const {branchRestockPcsBlocks}=require('../dist/src/agent/restock-pcs.blocks');
  const blocks=normalizeAgentResponseBlocks(branchRestockPcsBlocks(compact));
  const table=blocks.find(block=>block.type==='table'&&block.title==='Restock per Jenis');
  assert(table.columns.includes('Patokan (pcs)'));const cnRow=table.rows.find(row=>String(row[0]).startsWith('CN'));assert(cnRow.includes(339));assert(cnRow.includes(479));assert(cnRow.includes(59));
  const keyBefore=keys.find(key=>key.startsWith('agent:restock:'));
  data=await service.update(1,[item('FCL','CN',400)],actor.toString());assert.equal(data.revision,2);
  const changed=await single.recommend(sources.slice(1),'FCL','2026-01');assert.equal(changed.branches[0].jenis.find(row=>row.kode==='CN').recommendedRestockUnits,120);
  assert.notEqual(keys.at(-1),keyBefore);
  await service.update(2,[item('FCL','CN',400,false)],actor.toString());
  const disabled=await single.recommend(sources.slice(1),'FCL','2026-01');const disabledCn=disabled.branches[0].jenis.find(row=>row.kode==='CN');assert.equal(disabledCn.baselinePcs,0);assert.equal(disabledCn.baselineConfigured,false);assert.equal(disabledCn.recommendedRestockUnits,0);
  const concurrent=await Promise.allSettled([service.update(3,[item('FCL','CN',401)],actor.toString()),service.update(3,[item('FCL','CN',402)],actor.toString())]);assert.equal(concurrent.filter(row=>row.status==='fulfilled').length,1);assert.equal(concurrent.filter(row=>row.status==='rejected').length,1);
  const beforeRestart=await service.snapshot();const afterRestart=await new StockBaselineService(mongo,cache).snapshot();assert.deepEqual(afterRestart,beforeRestart);
  assert.deepEqual(Reflect.getMetadata('requiredRoles',StockBaselineController),['admin','pusat']);
  console.log('PASS baseline master: legacy source catalog (31 missing/null + explicit GTS + central), isolated Mongo persistence, actual catalog validation, zero/unset/inactive, audit, optimistic concurrency, role metadata, baseline+weekly target 479 and need 59, no-sales baseline, donor reserve, OPEN, 500-pcs offer, cache revisions and authoritative blocks. No operational data changed.');
 }finally{await db.dropDatabase();await central.dropDatabase();await client.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
