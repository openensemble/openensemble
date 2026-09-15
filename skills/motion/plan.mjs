import { finiteVector } from './math.mjs';

export const ACTIONS = Object.freeze(['idle','walk','turn','wave','nod','shake','look','point','reach','bow','squat','sit','stand','listen','think','speak','perform','express','grasp','place']);
export const FACE_CONTROLS=Object.freeze(['smile','blink','blinkLeft','blinkRight','jawOpen','brow']);
export const DEFAULT_DURATIONS = Object.freeze({idle:3,walk:4.8,turn:2,wave:3.6,nod:2.1,shake:2.6,look:2.4,point:3.5,reach:3.5,bow:3.2,squat:4,sit:3.5,stand:3.2,listen:4,think:4,speak:4,express:2.4,grasp:6,place:6});
// Conservative placement budget for timing and crowded-stance fallback.
export const turnStepCount=angle=>Math.max(2,2*Math.ceil(Math.abs(angle)/(Math.PI/4)-1e-10));
export const STYLE_DEFAULTS=Object.freeze({energy:.5,tempo:1,confidence:.6,warmth:.5,tension:.2});
const FIELDS = new Set(['action','start','duration','side','count','distance','angle','target','object','keyframes','style','timing']);
export const ANCHORS=Object.freeze(['hips','chest','head','leftUpperArm','rightUpperArm','world']);
export const HAND_EFFECTORS=Object.freeze(['wrist','thumbTip','indexTip','middleTip','ringTip','littleTip']);
const ROOT_ACTIONS = new Set(['walk','turn','bow','squat','sit','stand']);
export class DirectionError extends Error { constructor(message) { super(message); this.name='DirectionError'; } }
function object(value,label) {
  if (!value || typeof value!=='object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new DirectionError(`${label} must be an object.`);
}
function bounded(v,low,high,label) { if (!Number.isFinite(v) || v<low || v>high) throw new DirectionError(`${label} must be between ${low} and ${high}.`); }
export function channels(beat) {
  if(beat.action==='express')return Object.keys(beat.keyframes[0].face).flatMap(name=>name==='blink'?['face.blinkLeft','face.blinkRight']:['face.'+name]);
  if(['grasp','place'].includes(beat.action))return ['leftArm','rightArm','head','root','legs'];
  // A custom score reserves its coordinated arms and standing support, but
  // only explicit head keys own head direction. Independent gaze, nods and
  // shakes can accompany hand keys without replacing an authored head pose.
  if(beat.action==='perform')return ['leftArm','rightArm',...(beat.keyframes?.[0]?.head?['head']:[]),'root','legs'];
  if (ROOT_ACTIONS.has(beat.action)) return ['root','legs',...(beat.action==='bow'||beat.action==='squat'||beat.action==='sit'||beat.action==='stand'?['leftArm','rightArm']:[])];
  if (['wave','point','reach','think','speak'].includes(beat.action)) return [beat.side==='both'?'leftArm':(beat.side??'right')+'Arm',...(beat.side==='both'?['rightArm']:[])];
  if (['look','nod','shake'].includes(beat.action)) return ['head'];
  return [];
}
export function validatePlan(input) {
  object(input,'Performance');
  for (const k of Object.keys(input)) if (!['version','seed','style','beats','direction'].includes(k)) throw new DirectionError(`Unknown performance field: ${k}`);
  if (input.version!==1) throw new DirectionError('Performance version must be 1.');
  const seed=input.seed??1; bounded(seed,0,4294967295,'Seed'); if (!Number.isInteger(seed)) throw new DirectionError('Seed must be an integer.');
  if (input.direction!==undefined && (typeof input.direction!=='string'||input.direction.length>2000)) throw new DirectionError('Direction must be text under 2,000 characters.');
  const style={...STYLE_DEFAULTS,...(input.style??{})}; object(input.style??{},'Style');
  if (Object.keys(style).some(k=>!Object.hasOwn(STYLE_DEFAULTS,k))) throw new DirectionError('Unknown performance style field.');
  bounded(style.energy,0,1,'Energy'); bounded(style.tempo,.5,1.5,'Tempo');
  for(const field of ['confidence','warmth','tension'])bounded(style[field],0,1,field);
  if (!Array.isArray(input.beats)||!input.beats.length||input.beats.length>24) throw new DirectionError('A performance needs 1–24 beats.');
  const beats=input.beats.map((b,i)=>{
    object(b,`Beat ${i+1}`);
    for (const key of Object.keys(b)) if (!FIELDS.has(key)) throw new DirectionError(`Unknown beat field: ${key}`);
    if (!ACTIONS.includes(b.action)) throw new DirectionError(`Unsupported action: ${b.action}`);
    bounded(b.start,0,120,'Start'); bounded(b.duration,.6,30,'Duration');
    if ((b.start+b.duration)/style.tempo>120) throw new DirectionError('A performance can last at most 120 seconds at the selected tempo.');
    if (b.side!==undefined && !['left','right','both'].includes(b.side)) throw new DirectionError('Side must be left, right, or both.');
    if (b.side!==undefined && !['wave','point','reach','think','speak','turn','look','grasp','place'].includes(b.action)) throw new DirectionError(`A side is not supported for ${b.action}.`);
    if (b.side==='both' && !['wave','point','reach','speak'].includes(b.action)) throw new DirectionError('Both sides is only supported for hand gestures.');
    if(b.style!==undefined) {
      if(b.action==='express')throw new DirectionError('Expression beats use explicit facial values. Put body style on a body beat or the performance.');
      object(b.style,'Beat style');
      for(const [field,value] of Object.entries(b.style)) {
        if(!Object.hasOwn(STYLE_DEFAULTS,field)||field==='tempo')throw new DirectionError('Beat style supports energy, confidence, warmth and tension. Set its duration for tempo.');
        bounded(value,0,1,field);
      }
    }
    if(b.timing!==undefined) {
      object(b.timing,'Gesture timing');
      if(ROOT_ACTIONS.has(b.action)||['idle','grasp','place'].includes(b.action))throw new DirectionError('Gesture timing belongs to an upper-body action. Contact actions use their own staged timing.');
      for(const [field,value] of Object.entries(b.timing)) {
        if(['preparation','recovery'].includes(field))bounded(value,.08,.45,field);
        else if(field==='eyeLead')bounded(value,.03,.5,field);
        else if(field==='hold')bounded(value,0,b.duration*.5,field);
        else throw new DirectionError('Unknown gesture timing field.');
      }
      if((b.timing.preparation??.28)+(b.timing.recovery??.27)+(b.timing.hold??0)/b.duration>.9)throw new DirectionError('Allow time between preparation, hold and recovery for the action itself.');
    }
    if (b.count!==undefined) { bounded(b.count,1,12,'Count'); if (!Number.isInteger(b.count)||!['wave','nod','shake','walk','squat'].includes(b.action)) throw new DirectionError('Count is supported for waves, nods, head shakes, steps, and squats.'); }
    if (b.distance!==undefined) { bounded(b.distance,.05,8,'Distance'); if (b.action!=='walk') throw new DirectionError('Distance belongs to a walk.'); }
    if (b.angle!==undefined) { bounded(b.angle,-Math.PI,Math.PI,'Angle'); if (!['turn','look','point'].includes(b.action)) throw new DirectionError('Angle belongs to a turn, look, or point.'); }
    if (b.target!==undefined && (!((finiteVector(b.target)&&b.target.every(n=>Math.abs(n)<=10))||(typeof b.target==='string'&&/^[A-Za-z0-9_.:-]{1,64}$/.test(b.target)))||!['walk','reach','point','look','place'].includes(b.action))) throw new DirectionError('Target must be a bounded world position or scene target ID for walk, reach, point, look, or place.');
    if(b.object!==undefined&&(!['grasp','place'].includes(b.action)||typeof b.object!=='string'||!/^[A-Za-z0-9_.:-]{1,64}$/.test(b.object)))throw new DirectionError('Object must identify a declared scene prop for grasp or place.');
    if(['grasp','place'].includes(b.action)&&(!b.object||!['left','right'].includes(b.side)))throw new DirectionError('Grasp and place need an object ID and one explicit hand.');
    if(b.action==='place'&&b.target===undefined)throw new DirectionError('Place needs a supported surface position or scene target.');
    if(b.action==='walk'&&b.target!==undefined&&(b.distance!==undefined||b.count!==undefined))throw new DirectionError('A walk uses a scene destination or a distance/step count, not both.');
    if(b.keyframes!==undefined&&!['perform','express'].includes(b.action))throw new DirectionError('Custom target keyframes belong to a perform or express beat.');
    if(b.action==='perform')validateKeyframes(b);
    if(b.action==='express')validateExpressionKeys(b);
    if (b.action==='walk' && b.target===undefined&&b.duration/style.tempo < (b.count??Math.max(2,Math.ceil((b.distance??1.1)/.35)+1))*.4+.4) throw new DirectionError('Give the requested steps more time; the engine will not speed a walk into a run.');
    const minimum={wave:1.4+.42*(b.count??2),nod:.5+.45*(b.count??1),shake:.8+.75*(b.count??1),point:1.6,reach:1.6,bow:1.7,squat:1.7*(b.count??1),sit:2,stand:2,think:1.6,grasp:5.6,place:5.6}[b.action];
    if(minimum && b.duration/style.tempo<minimum) throw new DirectionError(`Give ${b.action} at least ${minimum.toFixed(1)} seconds at this tempo.`);
    if(b.action==='wave') {
      const stroke=(b.duration*(1-(b.timing?.preparation??.28)-(b.timing?.recovery??.27))-(b.timing?.hold??0))/style.tempo;
      if(stroke+1e-10<.55*(b.count??2))throw new DirectionError('Give each wave cycle at least 0.55 seconds of stroke time after preparation, hold, recovery and tempo.');
    }
    if(b.action==='shake') {
      if(b.timing?.eyeLead!==undefined)throw new DirectionError('A head shake counter-rotates the eyes; eyeLead belongs to an explicit look.');
      const stroke=(b.duration*(1-(b.timing?.preparation??.28)-(b.timing?.recovery??.27))-(b.timing?.hold??0))/style.tempo;
      if(stroke+1e-10<.65*(b.count??1))throw new DirectionError('Give each head-shake cycle at least 0.65 seconds of stroke time after preparation, hold, recovery and tempo.');
    }
    return structuredClone(b);
  }).sort((a,b)=>a.start-b.start);
  for (let i=0;i<beats.length;i++) for (let j=i+1;j<beats.length;j++) {
    if (beats[j].start>=beats[i].start+beats[i].duration) break;
    if (channels(beats[i]).some(c=>channels(beats[j]).includes(c))) throw new DirectionError(`Overlapping ${beats[i].action} and ${beats[j].action} control the same body part. Use “then”.`);
  }
  return {version:1,seed,style,beats,direction:input.direction??''};
}

function validateExpressionKeys(beat){
  const keys=beat.keyframes;
  if(!Array.isArray(keys)||keys.length<2||keys.length>32)throw new DirectionError('An expression needs 2–32 facial keyframes.');
  if(beat.timing&&(beat.timing.hold!==undefined||beat.timing.eyeLead!==undefined))throw new DirectionError('Expression holds use identical facial keys; eyeLead belongs to gaze.');
  let previous=-1,signature=null;
  for(const key of keys){
    object(key,'Expression keyframe');if(Object.keys(key).some(name=>!['time','face'].includes(name)))throw new DirectionError('An express keyframe controls only face values.');
    bounded(key.time,0,beat.duration,'Keyframe time');if(key.time<=previous)throw new DirectionError('Keyframe times must increase.');previous=key.time;
    object(key.face,'Facial controls');const names=Object.keys(key.face).sort();
    if(!names.length||names.some(name=>!FACE_CONTROLS.includes(name)))throw new DirectionError('Choose supported facial controls.');
    if(names.includes('blink')&&names.some(name=>['blinkLeft','blinkRight'].includes(name)))throw new DirectionError('Use a shared blink or independent eyelids in one expression, not both.');
    for(const value of Object.values(key.face))bounded(value,0,1,'Facial control');
    const next=JSON.stringify(names);if(signature!==null&&next!==signature)throw new DirectionError('Every expression keyframe must address the same facial controls.');signature=next;
  }
  if(keys[0].time!==0||keys.at(-1).time!==beat.duration)throw new DirectionError('Expression keyframes must cover zero through the beat duration.');
}

function validateKeyframes(beat) {
  const keys=beat.keyframes;
  if(!Array.isArray(keys)||keys.length<2||keys.length>32)throw new DirectionError('A custom performance needs 2–32 target keyframes.');
  if(beat.duration<2)throw new DirectionError('Give a custom performance at least two seconds.');
  let previous=-1,signature=null;
  for(const key of keys) {
    object(key,'Target keyframe');
    if(Object.keys(key).some(n=>!['time','hands','torso','head','pelvis'].includes(n)))throw new DirectionError('Unknown target keyframe field.');
    bounded(key.time,0,beat.duration,'Keyframe time');if(key.time<=previous)throw new DirectionError('Keyframe times must increase.');previous=key.time;
    object(key.hands??{},'Keyframe hands');
    if(Object.keys(key.hands??{}).some(s=>!['left','right'].includes(s)))throw new DirectionError('Hands must be left or right.');
    for(const [side,hand] of Object.entries(key.hands??{})) {
      object(hand,'Hand target');
      if(Object.keys(hand).some(k=>!['anchor','effector','offset','direction','normal','curl'].includes(k)))throw new DirectionError('Unknown hand target field.');
      if(!ANCHORS.includes(hand.anchor)||!finiteVector(hand.offset)||hand.offset.some(v=>Math.abs(v)>2))throw new DirectionError('A hand target needs a supported body anchor and bounded offset in meters.');
      if(hand.effector!==undefined&&!HAND_EFFECTORS.includes(hand.effector))throw new DirectionError('A hand effector must be the wrist or a supported fingertip.');
      for(const field of ['direction','normal'])if(!finiteVector(hand[field])||Math.hypot(...hand[field])<.1||hand[field].some(v=>Math.abs(v)>1))throw new DirectionError(`${field} needs a finite direction vector.`);
      const [d,n]=[hand.direction,hand.normal];const cosine=d.reduce((sum,v,i)=>sum+v*n[i],0)/Math.hypot(...d)/Math.hypot(...n);
      if(Math.abs(cosine)>.97)throw new DirectionError('Palm normal must be independent of finger direction.');
      if(!finiteVector(hand.curl,5)||hand.curl.some(v=>v<0||v>1.3))throw new DirectionError('Finger curl needs five values from 0 to 1.3: thumb, index, middle, ring, little.');
    }
    for(const field of ['torso','head','pelvis'])if(key[field]!==undefined&&(!finiteVector(key[field])||key[field].some(v=>Math.abs(v)>(field==='pelvis'?.35:field==='head'?.8:.5))))throw new DirectionError(`Custom ${field} controls exceed the supported range.`);
    const sig=JSON.stringify({hands:Object.entries(key.hands??{}).map(([s,h])=>[s,h.anchor,h.effector??'wrist']).sort(),fields:['torso','head','pelvis'].filter(k=>key[k]!==undefined)});
    if(signature!==null&&sig!==signature)throw new DirectionError('Every keyframe must address the same hands, anchors and body channels.');signature=sig;
    if(!Object.keys(key.hands??{}).length&&!['torso','head','pelvis'].some(k=>key[k]))throw new DirectionError('A custom keyframe needs a hand or body target.');
  }
  if(keys[0].time!==0||keys.at(-1).time!==beat.duration)throw new DirectionError('Custom keyframes must cover zero through the beat duration. Entry and recovery are added by the engine.');
}

const numberWords={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,once:1,twice:2};
function readNumber(text) { return numberWords[text]??Number(text); }
// Deliberately bounded grammar. A language agent can construct the same score
// via the schema; neither path evaluates code or silently drops unknown words.
export function direct(text,{seed=1,style={}}={}) {
  if (typeof text!=='string'||!text.trim()||text.length>2000) throw new DirectionError('Describe a performance in 1–2,000 characters.');
  const lower=text.toLowerCase().replace(/[!?]|\.(?!\d)/g,'').replace(/\bplease\b/g,'').trim();
  if (/\b(not|don't|dont|without|never|except)\b/.test(lower)) throw new DirectionError('Negative directions need an explicit performance plan; no motion was changed.');
  const beats=[]; let cursor=0;
  for (const group of lower.split(/\s*(?:,?\s+then\s+|;\s*|,?\s+and\s+)\s*/)) {
    let groupEnd=cursor;
    for (let phrase of group.split(/\s+while\s+/)) {
      let tempo=style.tempo??1;const beatStyle={};
      // Timing words affect this beat only. Global style is retained separately.
      if (/\b(slowly|gently|calmly)\b/.test(phrase)) tempo*=.8;
      if (/\b(quickly|briskly)\b/.test(phrase)) tempo*=1.2;
      if(/\b(gently|calmly|quietly)\b/.test(phrase))beatStyle.energy=.25;
      if(/\b(energetically|eagerly|excitedly)\b/.test(phrase))beatStyle.energy=.85;
      if(/\b(confidently|assuredly)\b/.test(phrase))beatStyle.confidence=.9;
      if(/\b(hesitantly|shyly)\b/.test(phrase))beatStyle.confidence=.2;
      if(/\b(warmly|kindly|friendly)\b/.test(phrase))beatStyle.warmth=.9;
      if(/\b(nervously|tensely)\b/.test(phrase)){beatStyle.tension=.85;beatStyle.confidence=.25;}
      let action;
      const aliases=[['stand',/\bstand(?:ing)?(?: up)?\b/],['sit',/\bsit(?:ting)?(?: down)?\b/],['wave',/\b(?:wave|waving|greet)\b/],['walk',/\bwalk(?:ing)?\b/],['turn',/\bturn(?:ing)?\b/],['nod',/\bnod(?:ding)?\b/],['shake',/\bshak(?:e|ing)\s+(?:(?:your|my|the)\s+)?head(?:\s+no)?\b/],['look',/\blook(?:ing)?\b/],['point',/\bpoint(?:ing)?\b/],['reach',/\breach(?:ing)?\b/],['bow',/\bbow(?:ing)?\b/],['squat',/\bsquat(?:ting)?\b/],['listen',/\blisten(?:ing)?\b/],['think',/\bthink(?:ing)?\b/],['speak',/\b(?:speak(?:ing)?|talk(?:ing)?|explain)\b/],['express',/\b(?:smil(?:e|ing)|blink(?:ing)?|wink(?:ing)?)\b/],['idle',/\b(?:idle|relax|rest|wait|pause)\b/],['grasp',/\b(?:pick(?:ing)? up|grasp(?:ing)?)\b/],['place',/\b(?:place|placing|put(?:ting)?)\b/]];
      const found=aliases.filter(([,re])=>re.test(phrase));
      if (found.length!==1) throw new DirectionError(`Cannot fully interpret “${phrase}”. Supported actions: ${ACTIONS.join(', ')}. Separate actions with “then” or “while”.`);
      action=found[0][0];const facial=action==='express'?phrase.match(found[0][1])[0]:null;phrase=phrase.replace(found[0][1],' ');
      const b={action,start:cursor,duration:DEFAULT_DURATIONS[action]/tempo};
      if(['grasp','place'].includes(action)){
        const object=phrase.match(/^\s*(?:the\s+)?([a-z0-9_.:-]{1,64})\b/);if(!object)throw new DirectionError('Name the declared prop after grasp or place.');
        b.object=object[1];phrase=phrase.replace(object[0],' ');
        if(action==='place'){const target=phrase.match(/\bon(?:to)?\s+(?:the\s+)?([a-z0-9_.:-]{1,64})\b/);if(!target)throw new DirectionError('Name the support after “on” for placement.');b.target=target[1];phrase=phrase.replace(target[0],' ');}
      }
      if(Object.keys(beatStyle).length&&action!=='express')b.style=beatStyle;
      if(/\bhesitantly\b/.test(phrase)&&!ROOT_ACTIONS.has(action)&&!['idle','grasp','place'].includes(action))b.timing={preparation:.4,recovery:.25};
      const duration=phrase.match(/\b(?:for\s+)?(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:seconds?|secs?|s)\b/);
      if (duration) { b.duration=readNumber(duration[1]); phrase=phrase.replace(duration[0],' '); }
      const dist=phrase.match(/\b(\d+(?:\.\d+)?)\s*(?:meters?|metres?|m)\b/);
      if (dist) { b.distance=Number(dist[1]); phrase=phrase.replace(dist[0],' '); }
      const counted=phrase.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:times?|steps?)\b|\b(once|twice)\b/);
      if (counted) { b.count=readNumber(counted[1]??counted[2]); phrase=phrase.replace(counted[0],' '); }
      // A pointing hand and the direction it indicates are independent.
      // In “point forward with your right hand”, right selects the limb; it
      // must not rotate the indicated direction away from forward.
      const handPattern=/\b(left|right|both)\s+(?:hands?|arms?)\b/g,handSides=action==='point'?[...new Set([...phrase.matchAll(handPattern)].map(match=>match[1]))]:[];
      if(handSides.length>1||action==='point'&&/\b(?:left\s+and\s+right|right\s+and\s+left)\s+(?:hands|arms)\b/.test(phrase))throw new DirectionError('Use separate beats for left and right, or say “both hands”.');
      const headingPhrase=action==='point'?phrase.replace(handPattern,' '):phrase;
      if (/\bleft\b/.test(headingPhrase)&&/\bright\b/.test(headingPhrase)) throw new DirectionError('Use separate beats for left and right, or say “both hands”.');
      const indicatedSide=/\bboth\b/.test(headingPhrase)?'both':/\bleft\b/.test(headingPhrase)?'left':/\bright\b/.test(headingPhrase)?'right':undefined;
      if(handSides[0]??indicatedSide)b.side=handSides[0]??indicatedSide;
      if(action==='express'){
        if(facial.startsWith('smil')){
          if(b.side)throw new DirectionError('A smile does not select a hand or side.');
          const face={smile:beatStyle.energy===.25?.3:beatStyle.warmth===.9?.7:.55};b.keyframes=[{time:0,face},{time:b.duration,face:{...face}}];
        }else{
          if(!duration)b.duration=1.1/tempo;
          const wink=facial.startsWith('wink')||b.side&&b.side!=='both',channel=wink?(b.side??'right')==='left'?'blinkLeft':'blinkRight':'blink';
          const open=wink?{blinkLeft:0,blinkRight:0}:{blink:0},closed={...open,[channel]:1};
          b.timing={preparation:.08,recovery:.08};b.keyframes=[{time:0,face:open},{time:b.duration*.22,face:closed},{time:b.duration*.32,face:{...closed}},{time:b.duration*.58,face:{...open}},{time:b.duration,face:{...open}}];delete b.side;
        }
      }
      if (['turn','look','point'].includes(action)) {
        if(action==='point'&&indicatedSide&&/\b(?:forward|ahead)\b/.test(headingPhrase))throw new DirectionError('Choose one pointing direction, or supply a structured angle.');
        const directionSide=action==='point'?indicatedSide:b.side;
        b.angle=directionSide==='left'?.6:directionSide==='right'?-.6:0;
        if (action==='turn') b.angle*=Math.PI/(2*.6);
        const degrees=phrase.match(/\b(?:by\s+)?(\d+(?:\.\d+)?)\s*degrees?\b/);
        if (degrees) { b.angle=(directionSide==='right'?-1:1)*Number(degrees[1])*Math.PI/180; phrase=phrase.replace(degrees[0],' '); }
      }
      if(action==='turn'&&!duration){const steps=turnStepCount(b.angle);b.duration=Math.max(b.duration,steps*.4+.4,(steps*.48+.6)/tempo);}
      if (action==='walk' && !duration) b.duration=Math.max(b.duration,(b.count??Math.max(2,Math.ceil((b.distance??1.1)/.35)+1))*.68+.7);
      if(action==='wave'&&!duration){
        const preparation=b.duration*(b.timing?.preparation??.28),recovery=b.duration*(b.timing?.recovery??.27),count=b.count??2;
        const stroke=Math.max(b.duration-preparation-recovery+Math.max(0,count-2)*.8/tempo,.56*count),next=preparation+stroke+recovery;
        if(Math.abs(next-b.duration)>1e-10){b.duration=next;b.timing={...b.timing,preparation:preparation/next,recovery:recovery/next};}
      }
      if(action==='shake'&&!duration)b.duration=Math.max(b.duration,((b.count??1)*.85+.3)/(1-(b.timing?.preparation??.28)-(b.timing?.recovery??.27))/tempo);
      const residue=phrase.replace(/\b(?:slowly|gently|calmly|quietly|quickly|briskly|energetically|eagerly|excitedly|confidently|assuredly|hesitantly|shyly|warmly|kindly|friendly|nervously|tensely|with|your|my|the|a|an|to|at|me|viewer|camera|hand|hands|arm|arms|eye|eyes|left|right|both|forward|ahead|hello|hi|up|down|in|place|for|and)\b/g,'').replace(/[,\s]+/g,'');
      if (residue) throw new DirectionError(`Unrecognized direction detail “${residue}”. Nothing was changed; use a structured plan for precise targets.`);
      if (/\bin place\b/.test(phrase) && action==='walk') throw new DirectionError('In-place walking is not implemented; specify a distance or steps.');
      beats.push(b); groupEnd=Math.max(groupEnd,b.start+b.duration);
    }
    cursor=groupEnd;
  }
  return validatePlan({version:1,seed,style:{...STYLE_DEFAULTS,...style,tempo:1},direction:text,beats});
}
