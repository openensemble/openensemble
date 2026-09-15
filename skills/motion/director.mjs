import {randomUUID} from 'node:crypto';
import {DirectionLoop} from './direction-loop.mjs';
import {motionRuntime} from '../../lib/motion-runtime.mjs';
import {directorInstructions} from './prompt.mjs';
import {DRAFT_SCHEMA,draftToPlan} from './draft.mjs';
import {completeVisualReview} from './visual-provider.mjs';

const requests=new Map();

async function configuredModel(userId,agentId) {
  const [{getAgentsForUser,getUserCoordinatorAgentId},{canUseExecutionProvider},{completeJSON,isReflectionModelAllowed,isReflectionTextModel}]=await Promise.all([
    import('../../routes/_helpers.mjs'),import('../../lib/execution-model-policy.mjs'),import('../../lib/personalization/providers.mjs'),
  ]);
  const selected=agentId??getUserCoordinatorAgentId(userId),agent=getAgentsForUser(userId).find(a=>a.id===selected);
  if(!agent?.provider||!agent?.model)throw new Error('The directing agent has no configured language model.');
  if(!canUseExecutionProvider(userId,agent.provider).ok||!isReflectionModelAllowed(userId,agent.model)||!isReflectionTextModel(agent.provider,agent.model))throw new Error('The directing agent’s language model is unavailable under this account’s model settings.');
  return {agent,completeJSON};
}

async function planWithOE(userId,agentId,request) {
  const {agent,completeJSON}=await configuredModel(userId,agentId);
  const result=await completeJSON({userId,providerId:agent.provider,model:agent.model,maxTokens:6000,
    system:directorInstructions,
    user:JSON.stringify({direction:request.direction,state:request.state,rig:request.capabilities,feedback:request.feedback,previousAttempts:request.history}),
    schema:JSON.stringify(DRAFT_SCHEMA)});
  if(Array.isArray(result.json?.unsupported)&&result.json.unsupported.length)return {plan:null,unsupported:result.json.unsupported};
  return {plan:draftToPlan(result.json,{handShapes:request.capabilities.handShapes}),unsupported:[]};
}

export async function directCharacter(args,userId,agentId,{planner,reviewer,signal,onProgress,onCommit}={}) {
  if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('Direction arguments must be an object.');
  for(const key of Object.keys(args))if(!['direction','request_id','client_id','expected_revision','expected_instance'].includes(key))throw new Error(`Unknown director argument: ${key}`);
  if(typeof args.direction!=='string'||!args.direction.trim()||args.direction.length>2000)throw new Error('A direction must contain 1–2,000 characters.');
  if(args.client_id!==undefined&&(typeof args.client_id!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(args.client_id)))throw new Error('Invalid rendering client ID.');
  if(args.expected_revision!==undefined&&(!Number.isInteger(args.expected_revision)||args.expected_revision<0))throw new Error('Expected revision must be a nonnegative integer.');
  if(args.expected_instance!==undefined&&(typeof args.expected_instance!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(args.expected_instance)))throw new Error('Invalid character instance ID.');
  const id=args.request_id??randomUUID();if(typeof id!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(id))throw new Error('Invalid direction request ID.');
  const key=JSON.stringify([userId,id]),fingerprint=JSON.stringify({direction:args.direction,client:args.client_id,revision:args.expected_revision,instance:args.expected_instance});
  const previous=requests.get(key);
  if(previous) {
    if(previous.fingerprint!==fingerprint)throw new Error('This request ID already identifies another direction.');
    const result=await previous.promise;return {...result,...(result.id?motionRuntime.inspect(userId,result.id):{}),duplicate:true};
  }
  const clients=motionRuntime.clients(userId),client=args.client_id?clients.find(c=>c.clientId===args.client_id):clients.length===1?clients[0]:null;
  if(!client)return {id,status:clients.length?'choose_client':'no_connected_client',clients};
  if([...requests.values()].some(r=>r.userId===userId&&r.clientId===client.clientId&&!r.done))return {id,status:'director_busy',message:'This avatar already has a direction being planned.'};
  for(const [old,value] of requests)if(value.done&&Date.now()-value.at>600000)requests.delete(old);
  if(requests.size>=128){const oldest=[...requests].find(([,value])=>value.done);if(oldest)requests.delete(oldest[0]);else throw new Error('The director is busy.');}
  const record={fingerprint,userId,clientId:client.clientId,at:Date.now(),done:false};
  requests.set(key,record);
  const request=async(operation,plan,revision,instance)=>{
    const sent=motionRuntime.submit(userId,{operation,plan,clientId:client.clientId,requestId:randomUUID(),expectedRevision:revision,expectedInstance:instance,agent:agentId});
    if(sent.status!=='dispatched')return sent;
    // A worker may still be preparing a cold rig after the first receipt.
    // Keep the directing operation alive until actual feedback, with bounded
    // waits so cancellation is observed while the renderer stays responsive.
    // The worker expires after 120 seconds. Allow its terminal receipt to
    // cross the transport; rendered evidence also needs time to draw after
    // preparation. Matching the worker deadline can lose its actual error.
    const seconds={inspect:15,preview:125,render:150,play:125}[operation],deadline=Date.now()+seconds*1000;let result=sent;
    const cancel=()=>motionRuntime.cancel(userId,sent.id);signal?.addEventListener('abort',cancel,{once:true});
    try{
    while(result.status==='dispatched'&&Date.now()<deadline){
      if(signal?.aborted)throw new Error('The direction was cancelled.');
      result=await motionRuntime.wait(userId,sent.id,{terminal:operation!=='play',timeout:Math.min(1000,deadline-Date.now())});
    }
    if(signal?.aborted)throw new Error('The direction was cancelled.');
    if(result.status==='dispatched'&&operation!=='play'){
      result=motionRuntime.inspect(userId,sent.id);
      if(result.status==='dispatched'){
        const cancelled=motionRuntime.cancel(userId,sent.id);
        throw new Error(`The rendering client did not finish ${operation} within ${seconds} seconds.${cancelled?' The pending proposal was cancelled.':''}`);
      }
    }
    // Missing playback feedback is ambiguous: the renderer may already be
    // moving. Retain its command ID and unconfirmed receipt without retrying.
    return result;
    }finally{signal?.removeEventListener('abort',cancel);}
  };
  record.promise=(async()=>{
    let review=reviewer??null,reviewAvailability=review?'host_reviewer':'not_connected';
    // Injected planners remain self-contained unless a reviewer is injected too.
    if(reviewer===undefined&&!planner&&client.capabilities?.renderedReview?.available){
      const {agent}=await configuredModel(userId,agentId);
      if(agent.provider==='openai-oauth'){
        reviewAvailability='configured_model';
        review=async input=>{const current=await configuredModel(userId,agentId);if(current.agent.provider!==agent.provider||current.agent.model!==agent.model)throw new Error('The directing model changed during visual review.');return completeVisualReview({model:agent.model,userId,request:input,signal});};
      }else reviewAvailability='provider_not_connected_for_images';
    }
    // Geometry and visual acting can need separate corrections. Keep the
    // complete history through a bounded five proposals when images are
    // reviewed; every revised take still passes both gates before playback.
    const loop=new DirectionLoop({maxAttempts:review?5:3,inspect:()=>request('inspect'),preview:(plan,revision,instance)=>request('preview',plan,revision,instance),render:(plan,revision,instance)=>request('render',plan,revision,instance),reviewer:review,perform:(plan,revision,instance)=>request('play',plan,revision,instance),planner:planner??(input=>planWithOE(userId,agentId,input))});
    return loop.run(args.direction,{signal,onProgress,onCommit,expectedRevision:args.expected_revision,expectedInstance:args.expected_instance}).then(result=>({...result,directionRequestId:id,reviewAvailability}));
  })().finally(()=>{record.done=true;record.at=Date.now();});
  return record.promise;
}
