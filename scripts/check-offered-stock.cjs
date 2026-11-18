process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017';
process.env.SYSTEM_DATABASE_NAME = 'offered_stock_check';
process.env.JWT_ACCESS_SECRET = 'offline-allocation-secret-at-least-32-characters';
process.env.DEEPSEEK_API_KEY = 'offline-model';
require('reflect-metadata');
const assert = require('node:assert/strict');
const { NetworkRestockRecommendationService } = require('../dist/src/agent/network-restock-recommendation.service');
const { AgentService } = require('../dist/src/agent/agent.service');
const { centralStockOffer } = require('../dist/src/agent/offered-stock-intent');
const { networkRestockPcsBlocks } = require('../dist/src/agent/restock-pcs.blocks');
const { detectOfferedStockFollowUpIntent, makeOfferedStockAllocationContext, offeredStockFollowUpBlocks, restoreOfferedStockAllocationContextFromBlocks } = require('../dist/src/agent/offered-stock-followup');
const sources = [
  { branchId:'PUSAT', alias:'Pusat', databaseName:'central',sourceType:'central' },
  { branchId:'A',alias:'Cabang A',databaseName:'a',sourceType:'branch' },
  { branchId:'B',alias:'Cabang B',databaseName:'b',sourceType:'branch' },
];
const keys=[];
const cache={getOrLoadWithStatus:async(key,load)=>{keys.push(key);return {value:await load(),cacheStatus:'miss'}}};
const stock=(units)=>({units,weight:units*10,rowsWithoutWeight:0});
const sales=(qty)=>({recent:qty,comparison:qty-7,recentWeight:qty*10,comparisonWeight:(qty-7)*10,recentRows:qty,comparisonRows:qty-7,recentRowsWithoutWeight:0,comparisonRowsWithoutWeight:0});
let central=1000, full=false, donor=false;
const service=new NetworkRestockRecommendationService({},cache,{snapshot:async()=>({revision:0,items:[],updatedAt:null})});
service.readSource=async(source)=>({source,jenisNames:new Map([['CN','CINCIN'],['GA','GELANG ANAK']]),stock:new Map([['CN',stock(source.sourceType==='central'?central:full?1000:donor&&source.branchId==='B'?1000:0)],['GA',stock(source.sourceType==='central'?10000:0)]]),sales:source.sourceType==='central'?new Map():new Map([['CN',sales(source.branchId==='A'?350:450)],['GA',sales(7000)]])});
service.readOpenShipments=async()=>({byBranchAndJenis:new Map([['A',new Map([['CN',stock(10)]])]]),byJenis:new Map([['CN',stock(10)]]),openRows:10,unitsToUnconfiguredDestinations:0});
const options={jenisCode:'CN',sourceBranchId:'PUSAT',availablePcs:500};
const offeredOptions={...options,productCategory:'X'};
(async()=>{
  const plan=await service.recommend(sources,'2026-01',offeredOptions);
  assert.equal(plan.jenis.length,1); assert.equal(plan.jenis[0].kode,'CN');
  assert.equal(plan.totals.shortageBeforeTransfersUnits,790);
  assert.equal(plan.totals.recommendedTransferUnits,500);
  assert.equal(plan.totals.centralPhysicalStockUnits,1000);
  assert.equal(plan.allocation.sourceAvailablePcs,990);
  assert.equal(plan.allocation.remainingOfferedPcs,0);
  assert.equal(plan.transfers[0].to.branchId,'B'); assert.equal(plan.transfers[0].quantity,450);
  assert.equal(plan.transfers[1].quantity,50);
  assert(plan.transfers.every(route=>route.jenis.kode==='CN'&&route.from.branchId==='PUSAT'&&Number.isInteger(route.quantity)));
  assert.equal(plan.totals.unfilledShortageUnits,290);
  await service.recommend(sources,'2026-01',{...offeredOptions,availablePcs:600});
  assert.notEqual(keys.at(-1),keys.at(-2));
  central=30; donor=true;
  const scarce=await service.recommend(sources,'2026-01',offeredOptions);
  assert.equal(scarce.totals.recommendedTransferUnits,20);
  assert.equal(scarce.allocation.sourceAvailablePcs,20);
  assert.equal(scarce.allocation.remainingOfferedPcs,480);
  assert(scarce.transfers.every(route=>route.from.branchId==='PUSAT'));
  central=1000; donor=false; full=true;
  const sufficient=await service.recommend(sources,'2026-01',offeredOptions);
  assert.equal(sufficient.transfers.length,0); assert.equal(sufficient.allocation.remainingOfferedPcs,500);
  assert.equal(sufficient.jenis[0].shortageBeforeTransfers,0);
  const filtered=await service.recommend(sources,'2026-01',{jenisCode:'cn'});
  assert.equal(filtered.jenis.length,1); assert.equal(filtered.jenis[0].kode,'CN');
  for(const availablePcs of [-1,0,1.5,Infinity,1000001,'500']) await assert.rejects(service.recommend(sources,'2026-01',{...offeredOptions,availablePcs}));
  await assert.rejects(service.recommend(sources,'2026-01',{availablePcs:500}));
  await assert.rejects(service.recommend(sources,'2026-01',{...offeredOptions,sourceBranchId:'not-allowed'}));
  await assert.rejects(service.recommend(sources,'2026-01',{...offeredOptions,jenisCode:'unknown'}));

  const categorySources=[
    {branchId:'PUSAT',alias:'Pusat',databaseName:'central',sourceType:'central'},
    {branchId:'X1',alias:'Cabang X1',databaseName:'x1',sourceType:'branch',itemCategory:'X'},
    {branchId:'X2',alias:'Cabang X2',databaseName:'x2',sourceType:'branch',itemCategory:'X'},
    {branchId:'B1',alias:'Cabang B1',databaseName:'b1',sourceType:'branch',itemCategory:'BIASA'},
    {branchId:'EX',alias:'Cabang Exclusive',databaseName:'ex',sourceType:'branch',itemCategory:'BIASA',distributionPriority:'profit_bagus'},
  ];
  const categoryService=new NetworkRestockRecommendationService({},cache,{snapshot:async()=>({revision:0,items:[],updatedAt:null})});
  categoryService.readSource=async(source)=>({source,jenisNames:new Map([['CN','CINCIN']]),stock:new Map([['CN',stock(source.sourceType==='central'?1000:0)]]),sales:source.sourceType==='central'?new Map():new Map([['CN',sales(7)]])});
  categoryService.readOpenShipments=async()=>({byBranchAndJenis:new Map(),byJenis:new Map(),openRows:0,unitsToUnconfiguredDestinations:0});
  const xOffer=await categoryService.recommend(categorySources,'2026-11',{jenisCode:'CN',sourceBranchId:'PUSAT',availablePcs:7,productCategory:'X',distributionOrders:{X:['X2','X1'],XB:[]}});
  assert.deepEqual(xOffer.transfers.map(route=>route.to.branchId),['X2']);
  assert.equal(xOffer.transfers[0].quantity,7,'the configured X recipient order is honored');
  assert.equal(xOffer.branches.find(branch=>branch.branchId==='X1').unfilledShortageUnits,7,'unfilled X-branch demand remains visible for Purchasing');
  assert.equal(xOffer.branches.find(branch=>branch.branchId==='B1').unfilledShortageUnits,7,'BIASA does not receive X while X-group demand remains');
  assert(!xOffer.transfers.some(route=>route.to.branchId==='B1'));
  const xSources=categorySources.map(({alias,branchId})=>({alias,branchId}));
  const xContext=makeOfferedStockAllocationContext(xOffer,'x-offer-request',xSources);
  assert(xContext);
  const followUpQuestion='kurang nya berapa? agar saya hubungi ke bagian purchasing';
  assert.equal(detectOfferedStockFollowUpIntent(followUpQuestion),'purchasing');
  const purchasingSupplyQuestion='berapa stock yang harus disediakan purchasing?';
  assert.equal(detectOfferedStockFollowUpIntent(purchasingSupplyQuestion),'purchasing');
  assert.equal(offeredStockFollowUpBlocks(xContext,'purchasing',purchasingSupplyQuestion).find(block=>block.type==='metric').value,7,'a natural stock-supply question follows up using the previous X allocation');
  assert.equal(detectOfferedStockFollowUpIntent('berapa yang perlu dibeli?'),'purchasing','a short purchase-quantity question is recognized from the prior allocation context');
  assert.equal(detectOfferedStockFollowUpIntent('berapa stok yang harus disediakan?'),'shortfall','category and prior allocation determine the default destination');
  assert.equal(detectOfferedStockFollowUpIntent('berapa stok tersedia di pusat?'),null,'an ordinary stock balance question must not be mistaken for an offered-allocation follow-up');
  const purchasingBlocks=offeredStockFollowUpBlocks(xContext,'purchasing',followUpQuestion);
  assert(purchasingBlocks.some(block=>block.type==='metric'&&block.label==='Saran Purchasing prioritas'&&block.value===7));
  const purchasingTable=purchasingBlocks.find(block=>block.type==='table');
  assert.equal(purchasingTable.rows.reduce((sum,row)=>sum+Number(row[4]),0),7,'Purchasing follow-up sums only unfilled X-group demand, not BIASA');
  assert(purchasingTable.rows.every(row=>row[1]==='X'));
  assert(JSON.stringify(purchasingBlocks).includes('belum masuk prioritas Purchasing'));
  const legacyAllocationBlocks=networkRestockPcsBlocks(xOffer);
  const restoredContext=restoreOfferedStockAllocationContextFromBlocks(legacyAllocationBlocks,'legacy-offer-request',xSources);
  assert(restoredContext,'an allocation answer saved before structured continuation was added can be recovered from its blocks');
  assert.equal(offeredStockFollowUpBlocks(restoredContext,'purchasing',followUpQuestion).find(block=>block.type==='metric').value,7);
  for(const productCategory of ['B','XB']){
    const restricted=await categoryService.recommend(categorySources,'2026-11',{jenisCode:'CN',sourceBranchId:'PUSAT',availablePcs:3,productCategory,distributionOrders:{X:[],XB:[]}});
    assert.deepEqual(restricted.transfers.map(route=>route.to.branchId),['B1'],`${productCategory} is sent only to BIASA without Exclusive flag`);
    assert.equal(restricted.allocation.unfilledEligibleShortagePcs,4,`${productCategory} reports the eligible residual for Cuci`);
    assert.equal(restricted.allocation.excludedRecipientBranchCount,3,'X-category and Exclusive branches are excluded');
    const cuciBlocks=offeredStockFollowUpBlocks(makeOfferedStockAllocationContext(restricted,`${productCategory}-offer-request`,xSources),'cleaning','berapa kekurangan untuk bagian cuci?');
    assert(cuciBlocks.some(block=>block.type==='metric'&&block.label==='Saran ke bagian Cuci'&&block.value===4));
    const cuciTable=cuciBlocks.find(block=>block.type==='table');
    assert.equal(cuciTable.rows.reduce((sum,row)=>sum+Number(row[4]),0),4,`${productCategory} follow-up reports only eligible BIASA recipients`);
    assert(cuciTable.rows.every(row=>row[1]==='BIASA'));
  }
  const missingCategoryQuestion='saya punya CN 500 pcs di pusat , saran dong saya harus kirim kemana aja';
  const detectedWithoutCategory=centralStockOffer(missingCategoryQuestion,sources);
  assert.equal(detectedWithoutCategory.jenisCode,'CN');
  assert.equal(detectedWithoutCategory.availablePcs,500);
  assert.equal(detectedWithoutCategory.sourceBranchId,'PUSAT');
  assert.equal(detectedWithoutCategory.productCategory,undefined);
  const clarificationAgent=new AgentService({}, {}, service);
  clarificationAgent.getAllowedSources=async()=>sources;
  let clarificationModelCalls=0;
  clarificationAgent.requestModel=async()=>{clarificationModelCalls++;throw new Error('Model should not run before product category clarification');};
  const clarification=await clarificationAgent.runChat({messages:[{role:'user',content:missingCategoryQuestion}]},{sub:'test',role:'admin',branchId:null});
  assert(clarification.blocks[0].text.includes('kategori mana'));
  assert.equal(clarificationModelCalls,0,'category clarification is deterministic and does not call the model');
  const question='saya punya CN 500 pcs kategori X di pusat , saran dong saya harus kirim kemana aja';
  assert.deepEqual(centralStockOffer(question,sources),offeredOptions);
  assert.equal(centralStockOffer('Tampilkan penjualan CN 500 pcs di pusat',sources),null);
  const agent=new AgentService({}, {}, service);
  agent.getAllowedSources=async()=>sources;
  agent.agentRunTraces={recordPlan:async()=>{},recordTool:async()=>{}};
  agent.sourcesService={getDistributionOrder:async()=>({orders:{X:[],XB:[]}})};
  agent.networkRestockSettings={getFulfillmentMethod:async()=>'branch-first'};
  let calls=0;
  agent.requestModel=async()=>({choices:[{finish_reason:'stop',message:++calls===1?{role:'assistant',tool_calls:[{id:'wrong-broad',type:'function',function:{name:'suggest_network_restock',arguments:'{}'}}]}:{role:'assistant',content:'Saran distribusi.'}}]});
  const answer=await agent.runChat({messages:[{role:'user',content:question}]},{sub:'test',role:'admin',branchId:null});
  assert(answer.blocks.some(block=>block.type==='metric'&&block.label==='Disarankan dikirim'&&block.value===0));
  assert(answer.blocks.some(block=>block.type==='metric'&&block.label==='Sisa penawaran'&&block.value===500));
  assert(answer.blocks.some(block=>block.type==='callout'&&block.text.includes('menahan 500 pcs')));
  assert(!JSON.stringify(answer.blocks).includes('GELANG ANAK'));
  assert(answer.blocks.at(-1).title.includes('Jenis CN'));
  full=false; calls=0;
  const allocated=await agent.runChat({messages:[{role:'user',content:question}]},{sub:'test',role:'admin',branchId:null});
  assert.equal(allocated.blocks.at(-1).rows.reduce((sum,row)=>sum+Number(row.at(-1)),0),500);
  const followUpAgent=new AgentService();
  let persistedContinuation;
  followUpAgent.agentRunTraces={start:async()=>{},recordSkills:async()=>{},recordPlan:async()=>{},recordTool:async()=>{},complete:async()=>{},fail:async()=>{}};
  followUpAgent.gatewayAudit={resolveActorEmail:async()=>null};
  followUpAgent.agentSkills={match:async()=>[]};
  followUpAgent.agentSessions={
    assertOwner:async()=>{},
    getPromptContext:async()=>({summary:'',summaryThroughSequence:0,messages:[],continuation:xContext}),
    prepareAttachments:async()=>[],
    appendExchange:async(...args)=>{persistedContinuation=args.at(-1);},
  };
  followUpAgent.memoryLearning={enqueue:async()=>{}};
  const followUpResponse=await followUpAgent.chat({sessionId:'507f1f77bcf86cd799439011',messages:[{role:'user',content:followUpQuestion}]},{sub:'test',role:'admin',branchId:null});
  assert(followUpResponse.blocks.some(block=>block.type==='metric'&&block.value===7));
  assert.equal(followUpResponse.continuation,undefined,'internal continuation state is not exposed to the browser');
  assert.equal(persistedContinuation.kind,'offered-stock-allocation','follow-up keeps the prior result available for the next room turn');
  const branch=new AgentService({}, {}, service);
  const result=JSON.parse(await branch.executeTool({id:'forbidden',type:'function',function:{name:'suggest_network_restock',arguments:JSON.stringify(offeredOptions)}},sources,new Map(),'cabang',undefined,{sub:'branch',role:'cabang',branchId:'A'}));
  assert(result.error);
  console.log('PASS offered-stock allocation and follow-up: hard cap, X order, X-only Purchasing shortfall, B/XB eligible Cuci shortfall, legacy block recovery, persisted room continuation, category clarification, no-need remainder, cache isolation, validation, role scope and owner-facing blocks. No live DB/model.');
})().catch(error=>{console.error(error);process.exitCode=1});
