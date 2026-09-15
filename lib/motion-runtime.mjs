import {randomUUID} from 'node:crypto';

const ID=/^[A-Za-z0-9_.:-]{1,128}$/;
const validId=value=>typeof value==='string'&&ID.test(value);
const TERMINAL=new Set(['completed','cancelled','rejected','previewed','rendered','inspected','disconnected']);
const ACCEPTED=new Set(['started','paused','queued_until_foot_lands','queued_until_contact_settles','queued_until_motion_settles',...TERMINAL]);
const boundedJSON=(value,limit=120000)=>{
  const text=JSON.stringify(value);if(text.length>limit)throw new Error('Animation feedback is too large.');
  return JSON.parse(text);
};

// Per-user rendering clients and correlated receipts. The WebSocket handler
// supplies authenticated identity; no user ID supplied by a client is used.
export function createMotionRuntime({now=()=>Date.now(),id=()=>randomUUID(),direct=null,directionTimeout=300000}={}) {
  const users=new Map(),watched=new WeakSet();
  function userState(userId) {
    if(typeof userId!=='string'||!userId)throw new Error('Animation requires an authenticated user.');
    if(!users.has(userId))users.set(userId,{clients:new Map(),commands:new Map(),directions:new Map()});
    const user=users.get(userId);
    for(const [key,command] of user.commands)if(command.updatedAt<now()-600000&&TERMINAL.has(command.status))user.commands.delete(key);
    for(const [key,request] of user.directions)if(request.done&&request.at<now()-600000)user.directions.delete(key);
    return user;
  }
  function notify(command) {for(const wake of [...command.waiters])wake();}
  function close(ws) {
    for(const [userId,user] of users) {
      for(const [clientId,client] of user.clients)if(client.ws===ws)user.clients.delete(clientId);
      for(const command of user.commands.values())if(command.ws===ws&&!TERMINAL.has(command.status)) {
        command.status='disconnected';command.updatedAt=now();command.result={message:'The rendering client disconnected before confirming completion.'};notify(command);
      }
      for(const request of user.directions.values())if(request.ws===ws&&!request.done){request.abort.abort();request.finish({status:'cancelled',message:'The directing connection closed.'});}
      if(!user.clients.size&&!user.commands.size)users.delete(userId);
    }
  }
  function handleDirection(ws,message,user) {
    const client=user.clients.get(message.clientId);
    if(!client||client.ws!==ws)throw new Error('Direction requires a renderer registered on this connection.');
    if(!validId(message.id))throw new Error('Invalid direction request ID.');
    const previous=user.directions.get(message.id);
    if(message.type==='oe_motion_cancel_direction') {
      if(!previous||previous.ws!==ws||previous.clientId!==message.clientId)throw new Error('This direction does not belong to this connection.');
      if(previous.committing&&!previous.done)ws.send(JSON.stringify({type:'oe_motion_direct_progress',version:1,id:message.id,status:'committing',message:'The take is being accepted. Use Stop to end accepted playback.'}));
      else if(!previous.done){previous.abort.abort();previous.finish({status:'cancelled',message:'Direction cancelled before playback.'});}
      else ws.send(JSON.stringify(previous.result));
      return;
    }
    if(typeof direct!=='function')throw new Error('No language director is connected.');
    if(typeof message.direction!=='string'||!message.direction.trim()||message.direction.length>2000)throw new Error('A direction must contain 1–2,000 characters.');
    if(message.expectedRevision!==undefined&&(!Number.isInteger(message.expectedRevision)||message.expectedRevision<0))throw new Error('Invalid performance revision.');
    if(message.expectedInstance!==undefined&&!validId(message.expectedInstance))throw new Error('Invalid character instance ID.');
    const fingerprint=JSON.stringify({clientId:message.clientId,direction:message.direction,expectedRevision:message.expectedRevision,expectedInstance:message.expectedInstance});
    if(previous) {
      if(previous.ws!==ws||previous.fingerprint!==fingerprint)throw new Error('This request ID already identifies another direction.');
      if(previous.done)ws.send(JSON.stringify({...previous.result,duplicate:true}));
      else ws.send(JSON.stringify({type:'oe_motion_direct_progress',version:1,id:message.id,status:'planning',duplicate:true}));
      return;
    }
    if([...user.directions.values()].some(r=>r.clientId===message.clientId&&!r.settled))throw new Error('This avatar already has a direction being planned.');
    if(user.directions.size>=64) {
      const oldest=[...user.directions].find(([,r])=>r.settled);if(!oldest)throw new Error('The director is busy.');
      user.directions.delete(oldest[0]);
    }
    const request={fingerprint,clientId:message.clientId,ws,abort:new AbortController(),done:false,settled:false,at:now(),result:null};let timer;
    const send=message=>{if(ws.readyState===1)try{ws.send(JSON.stringify(message));}catch{/* The close path cancels disconnected work. */}};
    request.finish=result=>{
      if(request.done)return;request.done=true;request.at=now();clearTimeout(timer);
      let payload;
      try{payload=boundedJSON(result);}catch{
        payload={id:result.id,status:result.status,clientId:result.clientId,directionRequestId:result.directionRequestId,artisticReview:result.artisticReview,reviewAvailability:result.reviewAvailability,visualReview:result.history?.at(-1)?.visualReview,message:'Detailed planning history exceeded the reply limit. Inspect the accepted take for its score.'};
      }
      request.result={type:'oe_motion_direct_result',version:1,requestId:message.id,...payload};send(request.result);
    };
    user.directions.set(message.id,request);
    timer=setTimeout(()=>{request.abort.abort();request.finish({status:'cancelled',message:'The direction exceeded its planning time limit.'});},Math.max(1000,Math.min(300000,directionTimeout)));timer.unref?.();
    send({type:'oe_motion_direct_progress',version:1,id:message.id,status:'planning'});
    Promise.resolve().then(()=>direct({args:{direction:message.direction,client_id:message.clientId,request_id:message.id,expected_revision:message.expectedRevision,expected_instance:message.expectedInstance},userId:ws._userId,signal:request.abort.signal,onCommit:()=>{if(request.abort.signal.aborted)throw new Error('Direction cancelled.');request.committing=true;clearTimeout(timer);},onProgress:attempt=>{
      if(!request.done)send({type:'oe_motion_direct_progress',version:1,id:message.id,status:'previewed',attempt:attempt.attempt,findings:attempt.findings});
    }})).then(result=>request.finish(result),error=>request.finish({status:request.abort.signal.aborted?'cancelled':'rejected',message:error.message})).finally(()=>{request.settled=true;});
  }
  function clients(userId) {
    const user=userState(userId);
    return [...user.clients.values()].filter(c=>c.ws.readyState===1).map(({ws,...client})=>structuredClone(client));
  }
  function receipt(command) {
    return boundedJSON({...command.result,id:command.id,clientId:command.clientId,operation:command.operation,status:command.status,
      createdAt:command.createdAt,updatedAt:command.updatedAt},command.operation==='render'?2120000:120000);
  }
  function inspect(userId,requestId) {
    const command=userState(userId).commands.get(requestId);return command?receipt(command):{id:requestId,status:'unknown_request'};
  }
  function submit(userId,{operation='play',plan,clientId,requestId=id(),expectedRevision,expectedInstance,agent=null}={}) {
    if(!validId(requestId))throw new Error('Invalid animation request ID.');
    if(!['play','preview','render','inspect'].includes(operation))throw new Error('Unknown animation operation.');
    const user=userState(userId),fingerprint=JSON.stringify({operation,plan,clientId,expectedRevision,expectedInstance});
    if(user.commands.has(requestId)) {
      const existing=user.commands.get(requestId);if(existing.fingerprint!==fingerprint)throw new Error('This request ID already identifies a different animation command.');
      return {...receipt(existing),duplicate:true};
    }
    const available=[...user.clients.values()].filter(c=>c.ws.readyState===1);
    const selected=clientId?available.find(c=>c.clientId===clientId):available.length===1?available[0]:null;
    if(!selected)return {id:requestId,status:available.length?'choose_client':'no_connected_client',clients:clients(userId),message:available.length?'Choose a clientId from animation_capabilities.':'Open the OE avatar client.'};
    if(operation==='render'){const retained=[...user.commands].filter(([,c])=>c.operation==='render');if(retained.length>=4){const old=retained.find(([,c])=>TERMINAL.has(c.status));if(!old)throw new Error('Too many rendered reviews are awaiting completion.');user.commands.delete(old[0]);}}
    while(user.commands.size>=128) {
      const oldest=[...user.commands].find(([,c])=>TERMINAL.has(c.status)||c.updatedAt<now()-180000);
      if(!oldest)throw new Error('Too many animation requests are awaiting a client reply.');
      user.commands.delete(oldest[0]);
    }
    const command={id:requestId,clientId:selected.clientId,ws:selected.ws,operation,fingerprint,status:'dispatched',createdAt:now(),updatedAt:now(),sequence:0,result:{},waiters:new Set()};
    user.commands.set(requestId,command);
    const message={type:'oe_motion_command',version:1,id:requestId,operation,agent};
    if(plan)message.plan=plan;if(expectedRevision!==undefined)message.expectedRevision=expectedRevision;if(expectedInstance!==undefined)message.expectedInstance=expectedInstance;
    try{selected.ws.send(JSON.stringify(message));}
    catch(error){command.status='disconnected';command.result={message:error.message};notify(command);}
    return receipt(command);
  }
  async function wait(userId,requestId,{terminal=false,timeout=5000}={}) {
    const command=userState(userId).commands.get(requestId);if(!command)return {id:requestId,status:'unknown_request'};
    const done=()=>terminal?TERMINAL.has(command.status):ACCEPTED.has(command.status);
    if(!done()&&timeout>0)await new Promise(resolve=>{
      let timer;
      const wake=()=>{if(done()){clearTimeout(timer);command.waiters.delete(wake);resolve();}};
      command.waiters.add(wake);
      timer=setTimeout(()=>{command.waiters.delete(wake);resolve();},Math.min(15000,timeout));
    });
    return receipt(command);
  }
  function handle(ws,message) {
    if(!['oe_motion_hello','oe_motion_feedback','oe_motion_bye','oe_motion_direct','oe_motion_cancel_direction'].includes(message?.type))return false;
    try {
      if(!ws._authenticated||typeof ws._userId!=='string')throw new Error('Animation feedback requires authentication.');
      if(message.version!==1||!validId(message.clientId))throw new Error('Invalid animation client envelope.');
      const user=userState(ws._userId);
      if(['oe_motion_direct','oe_motion_cancel_direction'].includes(message.type)){handleDirection(ws,message,user);return true;}
      if(message.type==='oe_motion_bye') {
        if(user.clients.get(message.clientId)?.ws===ws)close(ws);
        return true;
      }
      if(message.type==='oe_motion_hello') {
        const previous=user.clients.get(message.clientId);
        if(previous&&previous.ws!==ws&&previous.ws.readyState===1)throw new Error('This rendering client ID is already connected.');
        if(!previous&&user.clients.size>=8)throw new Error('At most eight animation clients can register for a user.');
        const snapshot=boundedJSON({capabilities:message.capabilities??null,state:message.state??null});
        user.clients.set(message.clientId,{clientId:message.clientId,ws,visible:message.visible!==false,updatedAt:now(),...snapshot});
        if(!watched.has(ws)){watched.add(ws);ws.once?.('close',()=>close(ws));}
        return true;
      }
      const client=user.clients.get(message.clientId),command=user.commands.get(message.id);
      if(!client||client.ws!==ws||!command||command.ws!==ws||command.clientId!==message.clientId)throw new Error('Feedback does not belong to this rendering connection.');
      if(TERMINAL.has(command.status))return true;
      if(!Number.isInteger(message.sequence)||message.sequence<=command.sequence)return true;
      if(!ACCEPTED.has(message.status))throw new Error('Unknown animation receipt status.');
      if(command.operation==='inspect'&&!['inspected','rejected','cancelled'].includes(message.status))throw new Error('Invalid inspection receipt.');
      if(command.operation==='render'&&!['rendered','rejected','cancelled'].includes(message.status))throw new Error('Invalid rendered review receipt.');
      if(command.operation==='preview'&&!['previewed','rejected','cancelled'].includes(message.status))throw new Error('Invalid preview receipt.');
      if(command.operation==='play'&&['inspected','previewed','rendered'].includes(message.status))throw new Error('Invalid playback receipt.');
      const {type,version,clientId,id:requestId,sequence,status,...payload}=message;
      const next=boundedJSON(payload,command.operation==='render'?2120000:120000),nextState=payload.state?boundedJSON(payload.state):null,nextCapabilities=payload.capabilities?boundedJSON(payload.capabilities):null;
      command.result=next;command.sequence=sequence;command.status=status;command.updatedAt=now();
      client.updatedAt=now();if(nextState)client.state=nextState;if(nextCapabilities)client.capabilities=nextCapabilities;
      notify(command);return true;
    }catch(error){ws.send(JSON.stringify({type:'oe_motion_protocol_error',id:message?.id,message:error.message}));return true;}
  }
  function cancel(userId,requestId) {
    const command=userState(userId).commands.get(requestId);
    if(!command||command.status!=='dispatched'||!['preview','render'].includes(command.operation))return false;
    command.status='cancelled';command.result={message:'The direction was cancelled.'};command.updatedAt=now();
    try{command.ws.send(JSON.stringify({type:'oe_motion_cancel_command',version:1,id:command.id}));}catch{/* Receipt is already cancelled. */}
    notify(command);return true;
  }
  return {clients,submit,inspect,wait,handle,close,cancel};
}

export const motionRuntime=createMotionRuntime({direct:async({args,userId,signal,onProgress,onCommit})=>{
  const {directCharacter}=await import('../skills/motion/director.mjs');
  return directCharacter(args,userId,null,{signal,onProgress,onCommit});
}});
export const handleMotionMessage=(ws,message)=>motionRuntime.handle(ws,message);
