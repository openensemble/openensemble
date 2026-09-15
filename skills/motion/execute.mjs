import {randomUUID} from 'node:crypto';
import {motionRuntime} from '../../lib/motion-runtime.mjs';
import {direct,validatePlan,ACTIONS,DEFAULT_DURATIONS} from './plan.mjs';
import {directCharacter} from './director.mjs';
import {ENGINE} from './version.mjs';

export async function executeSkillTool(name, args, userId, agentId) {
  if(!['animation_capabilities','animate_character','inspect_animation','preview_animation','animation_result','direct_character'].includes(name))return null;
  if(args?.__validate)return '';
  try {
    if(typeof userId!=='string'||!userId)throw new Error('Animation requires an authenticated user.');
    if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('Animation arguments must be an object.');
    const fields=name==='animation_capabilities'?[]:name==='animation_result'?['request_id','wait_seconds']:name==='inspect_animation'?['request_id','client_id']:['direction','plan','request_id','expected_revision','expected_instance','client_id'];
    for(const key of Object.keys(args))if(!fields.includes(key))throw new Error(`Unknown animation argument: ${key}`);
    if(name==='direct_character') {
      if(args.plan!==undefined)throw new Error('The performance director takes a direction; use animate_character for a prepared plan.');
      return JSON.stringify(await directCharacter(args,userId,agentId));
    }
    if(name==='animation_capabilities')return JSON.stringify({engine:ENGINE,clients:motionRuntime.clients(userId),actions:ACTIONS,durations:DEFAULT_DURATIONS,
      workflow:['direct_character: generate, preview, review native rendered views when connected, revise and play from a user direction using the directing agent’s configured language model when needed','inspect_animation: current rig, landmarks, scene and revision','preview_animation: evaluate a proposed score without replacing the current performance','animate_character: start the validated take','animation_result: inspect acceptance, completion or cancellation'],
      format:{version:1,style:{energy:'0..1',tempo:'0.5..1.5'},beats:'1–24 beats: action, start, duration; optional side, count, distance (meters), angle (radians), target [x,y,z] or scene target ID, object (declared prop ID for grasp/place)'},
      limits:['Original motion generation; no general learned human-motion model.','Sitting needs scene seat geometry; stand before walking from a seated pose.','Grasp/place require a small upright cylinder, complete fingers, explicit hand and at least 5.6 real seconds. Placement requires a declared support. Occupied hands remain reserved across commands.','Numerical preview is not visual or artistic approval. Native image review currently uses the configured openai-oauth model; sampled model review is not independent animator approval.']});
    if(args.client_id!==undefined&&(typeof args.client_id!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(args.client_id)))throw new Error('Invalid rendering client ID.');
    if(name==='animation_result') {
      if(typeof args.request_id!=='string')throw new Error('A receipt needs its request_id.');
      const seconds=args.wait_seconds??0;if(!Number.isFinite(seconds)||seconds<0||seconds>10)throw new Error('Wait seconds must be between 0 and 10.');
      return JSON.stringify(await motionRuntime.wait(userId,args.request_id,{terminal:true,timeout:seconds*1000}));
    }
    const operation=name==='inspect_animation'?'inspect':name==='preview_animation'?'preview':'play';
    if(operation==='inspect'&&(args.direction!==undefined||args.plan!==undefined))throw new Error('An inspection does not take a performance.');
    if(operation!=='inspect'&&Boolean(args.direction)===Boolean(args.plan))throw new Error('Provide exactly one direction or performance plan.');
    const plan=operation==='inspect'?undefined:args.plan?validatePlan(args.plan):direct(args.direction);
    const id=args.request_id??randomUUID();if(typeof id!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(id))throw new Error('Invalid request ID.');
    if(args.expected_revision!==undefined&&(!Number.isInteger(args.expected_revision)||args.expected_revision<0))throw new Error('Expected revision must be a nonnegative integer.');
    if(args.expected_instance!==undefined&&(typeof args.expected_instance!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(args.expected_instance)))throw new Error('Invalid character instance ID.');
    const result=motionRuntime.submit(userId,{operation,plan,clientId:args.client_id,requestId:id,expectedRevision:args.expected_revision,expectedInstance:args.expected_instance,agent:agentId??null});
    if(result.status!=='dispatched')return JSON.stringify(result);
    return JSON.stringify(await motionRuntime.wait(userId,id,{terminal:operation!=='play',timeout:operation==='play'?5000:15000}));
  }catch(error){return JSON.stringify({status:'rejected',error:error.message});}
}
export default executeSkillTool;
