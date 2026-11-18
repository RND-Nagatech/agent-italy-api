import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

async function main() {
  const suffix = Date.now().toString();
  const databaseName = `pantes_knowledge_qa_${suffix}`;
  const collectionName = `pantes_knowledge_qa_${suffix}`;
  process.env.HINDSIGHT_AUTO_LEARN = 'false';
  process.env.SYSTEM_DATABASE_NAME = databaseName;
  process.env.QDRANT_COLLECTION = collectionName;
  process.env.HINDSIGHT_API_KEY = 'offline-qa-credential';
  process.env.HINDSIGHT_BASE_URL = 'http://127.0.0.1:18888';
  process.env.HINDSIGHT_BANK_ID = 'pantes-qa-shared';
  const [{ NestFactory }, { FastifyAdapter }, { ValidationPipe }, { JwtService }, { AppModule }, { MongoService }, { KnowledgeWorker }, { KnowledgeService }, { SharedMemoryService }, { env }, { EmbeddingService }, { extractDocument, chunkPages }] = await Promise.all([
    import('@nestjs/core'), import('@nestjs/platform-fastify'), import('@nestjs/common'), import('@nestjs/jwt'), import('../src/app.module'), import('../src/database/mongo.service'), import('../src/knowledge/knowledge.worker'), import('../src/knowledge/knowledge.service'), import('../src/knowledge/memory.service'), import('../src/config/env'), import('../src/knowledge/embedding.service'), import('../src/knowledge/document-parser'),
  ]);
  const fetchOriginal = globalThis.fetch;
  const retained = new Map<string, string>();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith('http://127.0.0.1:18888')) return fetchOriginal(input, init);
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer offline-qa-credential');
    if (url.endsWith('/memories') && init?.method === 'POST') { const body = JSON.parse(String(init.body)); for (const item of body.items) retained.set(item.document_id,item.content); return Response.json({success:true}); }
    if (url.endsWith('/memories/recall')) return Response.json({results:[...retained].map(([document_id,text])=>({document_id,text,id:randomUUID()}))});
    if (url.includes('/documents/') && init?.method === 'DELETE') { retained.delete(decodeURIComponent(url.split('/').at(-1)!)); return Response.json({success:true}); }
    return Response.json({bank_id:'pantes-qa-shared'});
  }) as typeof fetch;
  const adapter = new FastifyAdapter({bodyLimit:25*1024*1024});
  const app = await NestFactory.create(AppModule,adapter,{logger:['error'],abortOnError:false});
  const multipart = (await import('@fastify/multipart')).default;
  await adapter.getInstance().register(multipart,{limits:{fileSize:20*1024*1024,files:1,fields:1,parts:2}});
  app.setGlobalPrefix('api/v1'); app.useGlobalPipes(new ValidationPipe({transform:true,whitelist:true,forbidNonWhitelisted:true}));
  await app.init(); await adapter.getInstance().ready();
  const mongo=app.get(MongoService),worker=app.get(KnowledgeWorker),knowledge=app.get(KnowledgeService),memory=app.get(SharedMemoryService);
  clearInterval((worker as any).timer);
  const jwt=new JwtService();
  const token=(role:string,branchId:string|null)=>jwt.sign({sub:`qa-${role}-${branchId}`,role,branchId,type:'access'},{secret:env.jwtAccessSecret,issuer:'pantes-tracking-api',audience:'pantes-tracking-client',expiresIn:600});
  const admin={authorization:`Bearer ${token('admin',null)}`},central={authorization:`Bearer ${token('pusat',null)}`},fcl={authorization:`Bearer ${token('cabang','FCL')}`},cwk={authorization:`Bearer ${token('cabang','CWK')}`};
  const api=(method:string,path:string,headers: Record<string,string>=admin,payload?:any)=>adapter.getInstance().inject({method:method as any,url:'/api/v1'+path,headers,payload});
  const upload=async(text:string,title:string,visibility='global',branchIds:string[]=[],headers=admin,replacesId?:string)=>{
    const boundary='qa-'+randomUUID();
    const metadata=JSON.stringify({title,description:'QA fixture',category:'QA',visibility,branchIds,...(replacesId?{replacesId}:{})});
    const payload=Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="qa.txt"\r\nContent-Type: text/plain\r\n\r\n${text}\r\n--${boundary}--\r\n`);
    return api('POST','/knowledge',{...headers,'content-type':`multipart/form-data; boundary=${boundary}`},payload);
  };
  try {
    assert.equal((await api('GET','/knowledge',{} as any)).statusCode,401);
    await mongo.db.collection('shipment_sources').insertMany([{alias:'QA FCL',branchId:'FCL',databaseName:'qa_fcl',active:true,sourceType:'branch'},{alias:'QA CWK',branchId:'CWK',databaseName:'qa_cwk',active:true,sourceType:'branch'}]);
    const forbidden=await upload('Tidak boleh mengunggah oleh akun cabang.','Forbidden','global',[],fcl);assert.equal(forbidden.statusCode,403);
    const text='SOP distribusi perhiasan emas Pantes. Safety stock cincin dihitung dalam gram. Sebelum mengirim stok, periksa kebutuhan cabang dan kiriman yang masih OPEN. Dokumen ini adalah fixture QA.';
    const response=await upload(text,'QA SOP distribusi');assert.equal(response.statusCode,201,response.body);const id=response.json().id;
    assert.equal((await api('GET',`/knowledge/${id}`,fcl)).statusCode,404,'Draft must be invisible to branches');
    await worker.tick();
    assert.equal((await api('GET',`/knowledge/${id}`)).json().status,'ready');
    assert.equal((await api('PATCH',`/knowledge/${id}`,admin,{active:true})).statusCode,200);
    const search=await api('POST','/knowledge/search',fcl,{query:'SOP distribusi perhiasan emas safety stock cincin'});assert.equal(search.statusCode,201);assert(search.json().references.some((r:any)=>r.documentId===id),search.body);
    const download=await api('GET',`/knowledge/${id}/file`,fcl);assert.equal(download.statusCode,200);assert.equal(download.body,text);assert.match(download.headers['content-disposition'] as string,/attachment/);
    assert.equal((await upload(text,'Duplicate')).statusCode,400);
    await api('PATCH',`/knowledge/${id}`,admin,{title:'QA SOP diperbarui',visibility:'branches',branchIds:['FCL']});assert.equal((await api('GET',`/knowledge/${id}`,cwk)).statusCode,404);assert.equal((await api('GET',`/knowledge/${id}`,fcl)).statusCode,200);await api('PATCH',`/knowledge/${id}`,admin,{visibility:'global',branchIds:[]});
    const restricted=await upload('Khusus FCL: SOP rahasia QA cabang Festival City Link. Pemeriksaan tray cincin dilakukan sebelum pengiriman. Hanya FCL boleh membaca dokumen ini.','QA FCL terbatas','branches',['FCL'],central);assert.equal(restricted.statusCode,201,restricted.body);const rid=restricted.json().id;
    await worker.tick();await api('PATCH',`/knowledge/${rid}`,central,{active:true});
    assert.equal((await api('GET',`/knowledge/${rid}`,fcl)).statusCode,200);
    assert.equal((await api('GET',`/knowledge/${rid}`,cwk)).statusCode,404);
    assert.equal((await api('GET',`/knowledge/${rid}/file`,cwk)).statusCode,404);
    const denied=await api('POST','/knowledge/search',cwk,{query:'SOP rahasia FCL pemeriksaan tray cincin'});assert(!denied.json().references.some((r:any)=>r.documentId===rid));
    await api('PATCH',`/knowledge/${id}`,admin,{active:false});
    const disabled=await api('POST','/knowledge/search',fcl,{query:'SOP distribusi perhiasan emas'});assert(!disabled.json().references.some((r:any)=>r.documentId===id));
    const newer=await upload(text+' Versi kedua yang sudah diperbarui.','QA SOP v2','global',[],admin,id);assert.equal(newer.statusCode,201,newer.body);await worker.tick();const nid=newer.json().id;await api('PATCH',`/knowledge/${nid}`,admin,{active:true});assert.equal((await api('GET',`/knowledge/${id}`)).json().active,false);
    const proposal=await api('POST','/knowledge/memories',fcl,{title:'Istilah Jenis',text:'Kode dept pada database Pantes berarti jenis perhiasan, bukan departemen organisasi.'});assert.equal(proposal.statusCode,201,proposal.body);const mid=proposal.json()._id;
    assert.equal((await api('POST',`/knowledge/memories/${mid}/approve`,fcl)).statusCode,403);
    assert.equal((await api('GET','/knowledge/memories',cwk)).json().items.length,0,'Pending private to proposer and managers');
    await api('POST',`/knowledge/memories/${mid}/approve`,admin);await worker.tick();
    assert.equal((await api('GET','/knowledge/memories',cwk)).json().items[0].status,'ready');
    assert.equal((await memory.recall('Arti dept di Pantes')).items.length,1);
    await api('DELETE',`/knowledge/memories/${mid}`,admin);
    assert.equal((await memory.recall('Arti dept di Pantes')).items.length,0,'Retired memory blocked even before remote purge');await worker.tick();assert.equal(retained.size,0);
    await api('DELETE',`/knowledge/${rid}`,admin);assert.equal((await api('GET',`/knowledge/${rid}/file`,fcl)).statusCode,404);await worker.tick();
    const { AgentService } = await import('../src/agent/agent.service');
    const agent = app.get(AgentService);
    let systemContext = '';
    (agent as any).requestModel = async (messages: any[]) => {
      systemContext = messages[0].content;
      return { choices: [{ message: { role: 'assistant', content: JSON.stringify({ blocks: [{ type: 'text', text: 'Ringkasan berdasarkan referensi yang diizinkan.' }] }) }, finish_reason: 'stop' }] };
    };
    const room = (await api('POST','/agent/sessions',cwk)).json();
    const chat = await api('POST','/agent/chat',cwk,{sessionId:room.id,requestId:randomUUID(),messages:[{role:'user',content:'Jelaskan SOP distribusi perhiasan emas dan safety stock cincin.'}]});
    assert.equal(chat.statusCode,201,chat.body);assert.match(systemContext,/REFERENSI_TERBATAS_JSON/);assert(!systemContext.includes('SOP rahasia QA'));
    assert(chat.json().knowledgeReferences.some((ref:any)=>ref.documentId===nid),chat.body);
    const roomDetail = (await api('GET',`/agent/sessions/${room.id}`,cwk)).json();assert(roomDetail.messages[1].knowledgeReferences.some((ref:any)=>ref.documentId===nid));
    const memoryRequest=randomUUID();
    const memoryChat={sessionId:room.id,requestId:memoryRequest,messages:[{role:'user',content:'Ingat bahwa kode dept pada Pantes merupakan jenis perhiasan, bukan departemen organisasi.'}]};
    const proposed = await api('POST','/agent/chat',cwk,memoryChat);assert.equal(proposed.statusCode,201,proposed.body);assert.equal(proposed.json().memoryProposal,undefined);
    await api('POST','/agent/chat',cwk,memoryChat);assert.equal(await mongo.db.collection('shared_memories').countDocuments({requestId:memoryRequest}),0);
    assert.equal((await api('DELETE',`/agent/sessions/${room.id}?forgetMemories=1`,cwk)).statusCode,403);
    const adminRoom=(await api('POST','/agent/sessions',admin)).json();
    const principal={sub:'qa-admin-null',role:'admin' as any,branchId:null};
    const linked = await memory.proposeFromChat('Ingat bahwa catatan QA ini hanya fixture pengujian memory.',principal,adminRoom.id,randomUUID());assert(linked);
    assert.equal((await api('DELETE',`/agent/sessions/${adminRoom.id}?forgetMemories=1`,admin)).statusCode,204);
    assert.equal((await mongo.db.collection('shared_memories').findOne({_id:linked!._id}))?.status,'deleted');
    const { ObjectId } = await import('mongodb');
    const staleId = new ObjectId();
    await mongo.db.collection('knowledge_documents').insertOne({_id:staleId,status:'processing',deleted:false,active:false,hash:'stale-test'});
    await mongo.db.collection('knowledge_jobs').insertOne({_id:new ObjectId(),kind:'index',targetId:staleId,status:'processing',attempts:3,availableAt:new Date(0),leaseUntil:new Date(0)});
    await worker.tick();assert.equal((await mongo.db.collection('knowledge_documents').findOne({_id:staleId}))?.status,'failed','Exhausted crashed leases must not stay stuck processing');
    // Check PDF extraction and docx ZIP validation/extraction without sending files outside this machine.
    const pdfText='QA PDF safety stock guidance for gold jewellery.';
    const objs=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];const stream=`BT /F1 12 Tf 50 750 Td (${pdfText}) Tj ET`;objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);let pdf='%PDF-1.4\n',offsets=[0];for(let i=0;i<objs.length;i++){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${objs[i]}\nendobj\n`;}const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    assert.match((await extractDocument(Buffer.from(pdf),'.pdf'))[0].text,/QA PDF/);
    const docx=execFileSync('python3',['-c',`import io,zipfile,sys\nb=io.BytesIO()\nwith zipfile.ZipFile(b,'w') as z:\n z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')\n z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>QA DOCX aturan distribusi perhiasan emas dan stok aman.</w:t></w:r></w:p></w:body></w:document>')\nsys.stdout.buffer.write(b.getvalue())`]);assert.match((await extractDocument(docx,'.docx'))[0].text,/QA DOCX/);
    assert(chunkPages([{page:1,text:'a '.repeat(1500)},{page:2,text:'Halaman kedua'}]).every(part=>part.text.length<=1200));
    await assert.rejects(extractDocument(Buffer.from('binary\0payload'),'.txt'));
    await assert.rejects(extractDocument(Buffer.from('not a PDF'),'.pdf'));
    console.log('PASS: real MongoDB/GridFS + local 384d embeddings + Qdrant; multipart roles, draft/publication/version, per-branch isolation, search, downloads, retirement; mocked Hindsight approve/recall/delete; Agent context/citation persistence, manual memory proposal and chat cleanup; PDF/DOCX/TXT validation.');
  } finally {
    try {
      assert(databaseName.startsWith('pantes_knowledge_qa_')); await mongo.db.dropDatabase();
      try { await fetchOriginal(`${env.qdrantUrl}/collections/${collectionName}`,{method:'DELETE',signal:AbortSignal.timeout(5000)}); }
      catch { console.warn(`QA vector cleanup pending: ${collectionName}`); }
    } finally { globalThis.fetch=fetchOriginal; await app.close(); }
  }
}
void main().catch(error=>{console.error(error instanceof Error?error.message:error);process.exitCode=1;});
