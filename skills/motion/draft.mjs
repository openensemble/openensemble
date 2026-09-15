import {ACTIONS,ANCHORS,HAND_EFFECTORS,FACE_CONTROLS,DEFAULT_DURATIONS,DirectionError,validatePlan} from './plan.mjs';

const vector=length=>({type:'array',minItems:length,maxItems:length,items:{type:'number'}});
const hand={anyOf:[vector(9),vector(14)]};
const face={type:'object',properties:Object.fromEntries(FACE_CONTROLS.map(name=>[name,{type:'number',minimum:0,maximum:1}])),additionalProperties:false};
const style={type:'object',properties:Object.fromEntries(['energy','tempo','confidence','warmth','tension'].map(name=>[name,{type:'number'}])),additionalProperties:false};
const timing={type:'object',properties:Object.fromEntries(['preparation','recovery','hold','eyeLead'].map(name=>[name,{type:'number'}])),additionalProperties:false};
export const DRAFT_SCHEMA=Object.freeze({
  type:'object',properties:{seed:{type:'integer'},style,unsupported:{type:'array',items:{type:'string'}},beats:{type:'array',maxItems:24,items:{
    type:'object',properties:{action:{enum:ACTIONS},start:{type:'number'},duration:{type:'number'},repeat:{type:'integer',minimum:1,maximum:12},side:{enum:['left','right','both']},count:{type:'integer'},distance:{type:'number'},angle:{type:'number'},target:{anyOf:[vector(3),{type:'string',maxLength:64}]},object:{type:'string',maxLength:64},style,timing,
      leftAnchor:{enum:ANCHORS},rightAnchor:{enum:ANCHORS},leftEffector:{enum:HAND_EFFECTORS},rightEffector:{enum:HAND_EFFECTORS},leftShape:{enum:['point']},rightShape:{enum:['point']},keys:{type:'array',minItems:2,maxItems:32,items:{type:'object',properties:{t:{type:'number'},left:hand,right:hand,torso:vector(3),head:vector(3),pelvis:vector(3),face},required:['t'],additionalProperties:false}}},
    required:['action','duration'],additionalProperties:false,
  }}},required:['beats','unsupported'],additionalProperties:false,
});

// The language model writes a shallow draft. A requested named hand selects
// supplied character calibration. Incomplete keys are rejected, not repaired.
export function draftToPlan(draft,{handShapes=null}={}) {
  const fail=message=>{const error=new DirectionError(message);error.correctable=true;error.proposal=structuredClone(draft);throw error;};
  if(!draft||typeof draft!=='object'||Array.isArray(draft))fail('Return a performance draft object.');
  for(const key of Object.keys(draft))if(!['seed','style','beats','unsupported'].includes(key))fail(`Unknown draft field: ${key}`);
  if(!Array.isArray(draft.unsupported)||draft.unsupported.some(s=>typeof s!=='string'))fail('Return an unsupported-requirements list.');
  if(draft.unsupported.length)fail(`Unimplemented requirements: ${draft.unsupported.join('; ')}`);
  if(!Array.isArray(draft.beats)||!draft.beats.length)fail('Return at least one complete performance beat.');
  let cursor=0;
  const beats=draft.beats.flatMap((source,index)=>{
    if(!source||typeof source!=='object'||Array.isArray(source))fail(`Beat ${index+1} must be an object.`);
    const {leftAnchor,rightAnchor,leftEffector,rightEffector,leftShape,rightShape,keys,repeat=1,...beat}=structuredClone(source);
    for(const [side,anchor,effector] of [['left',leftAnchor,leftEffector],['right',rightAnchor,rightEffector]])if(effector!==undefined&&(beat.action!=='perform'||anchor===undefined))fail(`A ${side} effector requires a custom hand target and anchor.`);
    const shaped={};
    for(const [side,anchor,shape] of [['left',leftAnchor,leftShape],['right',rightAnchor,rightShape]])if(shape!==undefined){
      if(beat.action!=='perform'||anchor===undefined)fail(`A ${side} hand shape requires a custom perform hand and anchor.`);
      if(shape!=='point')fail(`Unsupported ${side} hand shape: ${String(shape)}. Available named shape: point.`);
      const fit=handShapes?.[side]?.[shape];
      if(fit?.available!==true||!Array.isArray(fit.curl)||fit.curl.length!==5||Array.from(fit.curl).some(value=>!Number.isFinite(value)||value<0||value>1.3))fail(`The ${side} pointing hand is unavailable in the supplied character's handShapes. Inspect its calibration before directing a named shape.`);
      shaped[side]=fit.curl.slice();
    }
    if(!Number.isInteger(repeat)||repeat<1||repeat>12)fail('A custom repeat count must be an integer from one to twelve.');
    if(source.repeat!==undefined&&!['perform','express'].includes(beat.action))fail('Draft repeat belongs to a custom perform or express beat. Named waves, nods, head shakes, walks and squats use count.');
    beat.start??=cursor;beat.duration??=DEFAULT_DURATIONS[beat.action];cursor=Math.max(cursor,beat.start+beat.duration*repeat);
    if(keys!==undefined||leftAnchor!==undefined||rightAnchor!==undefined) {
      if(!['perform','express'].includes(beat.action)||!Array.isArray(keys))fail('Custom anchors and keys require a perform or express beat.');
      beat.keyframes=keys.map(key=>{
        if(!key||typeof key!=='object'||Array.isArray(key))fail('A draft key must be an object.');
        for(const field of Object.keys(key))if(!['t','left','right','torso','head','pelvis','face'].includes(field))fail(`Unknown draft key field: ${field}`);
        const frame={time:key.t};
        for(const [side,anchor] of [['left',leftAnchor],['right',rightAnchor]]) {
          const values=key[side];
          if((values!==undefined)!==(anchor!==undefined))fail(`Every ${side} hand key needs its beat's ${side}Anchor.`);
          if(values!==undefined) {
            const count=shaped[side]?9:14;
            if(!Array.isArray(values)||values.length!==count||Array.from(values).some(v=>!Number.isFinite(v)))fail(shaped[side]?`A ${side} hand with a named shape needs 9 numbers: offset XYZ, finger direction XYZ and palm normal XYZ. Its calibrated shape supplies the five curls.`:`A ${side} hand key needs 14 numbers: offset XYZ, finger direction XYZ, palm normal XYZ, five curls.`);
            const effector=side==='left'?leftEffector:rightEffector;
            frame.hands??={};frame.hands[side]={anchor,...(effector!==undefined?{effector}:{}),offset:values.slice(0,3),direction:values.slice(3,6),normal:values.slice(6,9),curl:shaped[side]?.slice()??values.slice(9,14)};
          }
        }
        for(const name of ['torso','head','pelvis','face'])if(key[name]!==undefined)frame[name]=key[name];
        return frame;
      });
    }
    // Expand repeated authored targets into independent, ordinary beats.
    // Each gets its own approach/recovery planning and editable key arrays.
    return Array.from({length:repeat},(_,i)=>({...structuredClone(beat),start:beat.start+i*beat.duration}));
  });
  try{return validatePlan({version:1,seed:draft.seed??1,style:draft.style??{},beats});}catch(error){fail(error.message);}
}
