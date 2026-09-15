import {validatePlan,DirectionError} from './plan.mjs';

export const RENDERED_REVIEW_LIMITS=Object.freeze({frames:48,sheets:4,samplesPerSheet:12,columns:4,rows:6,width:1024,height:1536,characters:2000000,sheetCharacters:600000,fps:6});

export function reviewSampleTimes(duration) {
  if(!Number.isFinite(duration)||duration<=0||duration>1200)throw new DirectionError('A rendered review needs a bounded positive duration.');
  const count=Math.min(RENDERED_REVIEW_LIMITS.frames,Math.ceil(duration*RENDERED_REVIEW_LIMITS.fps)+1);
  return Array.from({length:count},(_,i)=>duration*i/(count-1));
}

// Image bytes never enter history, planning prompts, saved takes or progress.
export function renderedReviewSummary(evidence) {
  const {sheets,...metadata}=evidence;
  return {...structuredClone(metadata),sheets:sheets.map(({image,...sheet})=>structuredClone(sheet))};
}

export function validateRenderedReview(input,{plan,revision,instanceId}={}) {
  if(!input||JSON.stringify(input).length>RENDERED_REVIEW_LIMITS.characters)throw new DirectionError('Rendered review evidence is missing or too large.');
  const e=structuredClone(input),limits=RENDERED_REVIEW_LIMITS;
  only(e,['version','scope','source','instanceId','revision','plan','duration','entryAt','frames','sheets','camera','detailCamera','limitations']);
  if(e.version!==1||e.scope!=='sampled-proposal'||!Number.isInteger(e.revision)||e.revision<0||typeof e.instanceId!=='string'||!(/^[A-Za-z0-9_.:-]{1,128}$/).test(e.instanceId))throw new DirectionError('Invalid rendered review identity.');
  if(revision!==undefined&&revision!==e.revision||instanceId!==undefined&&instanceId!==e.instanceId)throw new DirectionError('The character or performance changed before rendered review.');
  const checked=validatePlan(e.plan);
  if(plan&&JSON.stringify(validatePlan(plan))!==JSON.stringify(checked))throw new DirectionError('Rendered evidence belongs to a different proposed performance.');
  e.plan=checked;
  const times=reviewSampleTimes(e.duration);
  if(!Array.isArray(e.frames)||e.frames.length!==times.length||!Array.isArray(e.sheets)||e.sheets.length!==Math.ceil(times.length/(limits.samplesPerSheet)))throw new DirectionError('Rendered review is missing part of its sample sequence.');
  for(const [i,frame] of e.frames.entries())if(!frame||!Number.isFinite(frame.time)||Math.abs(frame.time-times[i])>1e-8||frame.sheet!==Math.floor(i/limits.samplesPerSheet)||frame.tile!==i%limits.samplesPerSheet*2)throw new DirectionError('Rendered review timestamps or tile order are invalid.');
  for(const frame of e.frames){
    only(frame,['time','sheet','tile','detailFocus','detailCamera']);
    if(frame.detailFocus!==undefined||frame.detailCamera!==undefined){
      if(!['left-hand','right-hand','hands'].includes(frame.detailFocus))throw new DirectionError('Invalid rendered detail focus.');
      only(frame.detailCamera,['position','target','fov']);
      if(!['position','target'].every(k=>Array.isArray(frame.detailCamera[k])&&frame.detailCamera[k].length===3&&frame.detailCamera[k].every(v=>Number.isFinite(v)&&Math.abs(v)<=200))||frame.detailCamera.fov!==e.camera?.fov)throw new DirectionError('Invalid tracked detail camera.');
    }
  }
  if(!Number.isFinite(e.entryAt)||e.entryAt<0||e.entryAt>1200||!e.camera||!['position','target'].every(k=>Array.isArray(e.camera[k])&&e.camera[k].length===3&&e.camera[k].every(v=>Number.isFinite(v)&&Math.abs(v)<=200))||!Number.isFinite(e.camera.fov)||e.camera.fov<15||e.camera.fov>90)throw new DirectionError('Invalid rendered review camera or entry.');
  only(e.camera,['position','target','fov']);
  only(e.detailCamera,['position','target','fov']);if(!['position','target'].every(k=>Array.isArray(e.detailCamera[k])&&e.detailCamera[k].length===3&&e.detailCamera[k].every(v=>Number.isFinite(v)&&Math.abs(v)<=200))||e.detailCamera.fov!==e.camera.fov)throw new DirectionError('Invalid rendered detail camera.');
  for(const sheet of e.sheets) {
    only(sheet,['width','height','image']);
    if(!sheet||sheet.width!==limits.width||sheet.height!==limits.height||typeof sheet.image!=='string'||sheet.image.length>limits.sheetCharacters||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(sheet.image))throw new DirectionError('Rendered review needs bounded JPEG contact sheets.');
    let bytes;try{bytes=atob(sheet.image.slice(23));}catch{throw new DirectionError('A rendered review image has invalid base64.');}
    if(bytes.length<4||bytes.charCodeAt(0)!==255||bytes.charCodeAt(1)!==216||bytes.charCodeAt(bytes.length-2)!==255||bytes.charCodeAt(bytes.length-1)!==217)throw new DirectionError('A rendered review image is incomplete.');
    const dimensions=jpegDimensions(bytes);if(!dimensions||dimensions.width!==sheet.width||dimensions.height!==sheet.height)throw new DirectionError('A review image does not match its declared dimensions.');
  }
  if(e.source!=='native-bound-copy'||!Array.isArray(e.limitations)||e.limitations.length>8||e.limitations.some(v=>typeof v!=='string'||v.length>500))throw new DirectionError('Rendered review needs its source and sampling limitations.');
  return e;
}

export function validateVisualAssessment(input,evidence) {
  if(!input||JSON.stringify(input).length>16000)throw new DirectionError('The visual reviewer returned missing or oversized findings.');
  const r=structuredClone(input);only(r,['verdict','summary','findings','limitations','reviewer','usage']);
  if(!['accept','revise','unreviewable'].includes(r.verdict)||typeof r.summary!=='string'||!r.summary.trim()||r.summary.length>1200||!Array.isArray(r.findings)||r.findings.length>12||!Array.isArray(r.limitations)||r.limitations.length>8||r.limitations.some(s=>typeof s!=='string'||s.length>500))throw new DirectionError('The visual reviewer returned an invalid assessment.');
  for(const f of r.findings)if(!f||!Number.isFinite(f.time)||f.time<0||f.time>evidence.duration||typeof f.description!=='string'||!f.description.trim()||f.description.length>600||typeof f.suggestion!=='string'||f.suggestion.length>600||!['motion','asset','framing'].includes(f.kind))throw new DirectionError('Visual findings need a valid time, cause and bounded correction.');
  for(const f of r.findings)only(f,['time','kind','description','suggestion']);
  if(r.reviewer){only(r.reviewer,['kind','provider','model']);if(!['model','host'].includes(r.reviewer.kind)||['provider','model'].some(k=>r.reviewer[k]!==undefined&&(typeof r.reviewer[k]!=='string'||r.reviewer[k].length>160)))throw new DirectionError('Invalid visual reviewer identity.');}
  if(r.usage){only(r.usage,['inputTokens','outputTokens']);if(Object.values(r.usage).some(n=>n!==null&&(!Number.isFinite(n)||n<0||n>1e9)))throw new DirectionError('Invalid visual review usage.');}
  if(r.verdict==='accept'&&r.findings.length||r.verdict==='revise'&&!r.findings.length)throw new DirectionError('The visual verdict contradicts its findings.');
  return r;
}

function only(value,keys) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw new DirectionError('Unexpected rendered review fields.');
}
function jpegDimensions(bytes) {
  const byte=i=>bytes.charCodeAt(i);let at=2;
  while(at+4<bytes.length){
    if(byte(at++)!==255)return null;while(byte(at)===255)at++;
    const marker=byte(at++);if(marker===218||marker===217)return null;
    const size=byte(at)*256+byte(at+1);if(size<2||at+size>bytes.length)return null;
    if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker))return size>=8?{height:byte(at+3)*256+byte(at+4),width:byte(at+5)*256+byte(at+6)}:null;
    at+=size;
  }
  return null;
}
