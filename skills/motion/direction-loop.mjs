import {direct,validatePlan,DirectionError} from './plan.mjs';
import {describeAuditFailures} from './critique.mjs';
import {validateRenderedReview,renderedReviewSummary,validateVisualAssessment} from './rendered-review.mjs';

// Transport-neutral direction for a renderer running in another process.
// The host supplies four asynchronous operations; the motion vocabulary and
// validation stay identical to the local director.
export class DirectionLoop {
  constructor({inspect,preview,perform,planner=null,render=null,reviewer=null,maxAttempts=3}) {
    if([inspect,preview,perform].some(fn=>typeof fn!=='function')||(planner!==null&&typeof planner!=='function'))throw new DirectionError('A remote director needs inspect, preview and perform operations.');
    if(render!==null&&typeof render!=='function'||reviewer!==null&&typeof reviewer!=='function'||reviewer&&!render)throw new DirectionError('A visual reviewer needs a rendered-preview operation.');
    if(!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>5)throw new DirectionError('Use one to five director attempts.');
    Object.assign(this,{inspect,preview,perform,planner,render,reviewer,maxAttempts});
  }
  async run(direction,{signal,expectedRevision,expectedInstance,onProgress=()=>{},onCommit=()=>{}}={}) {
    if(typeof direction!=='string'||!direction.trim()||direction.length>2000)throw new DirectionError('Describe a performance in 1–2,000 characters.');
    const cancelled=()=>{if(signal?.aborted)throw new DirectionError('The direction was cancelled.');};
    const snapshot=await this.inspect();cancelled();
    if(snapshot.status!=='inspected')return snapshot;
    const revision=snapshot.state.revision,instance=snapshot.state.instanceId;
    if(expectedInstance!==undefined&&expectedInstance!==instance)throw new DirectionError('The character changed before planning began.');
    if(expectedRevision!==undefined&&expectedRevision!==revision)throw new DirectionError('The performance changed before planning began.');
    let candidate=null,feedback=[],history=[];
    try{candidate=direct(direction);}catch(error){feedback=[error.message];}
    for(let attempt=1;attempt<=this.maxAttempts;attempt++) {
      cancelled();
      if(!candidate) {
        if(!this.planner)throw new DirectionError(feedback.join(' ')||'No language planner is connected.');
        let proposal;
        try{proposal=await this.planner({direction,state:snapshot.state,capabilities:snapshot.capabilities,feedback,history:structuredClone(history),attempt,signal});cancelled();}
        catch(error) {
          if(!error.correctable||signal?.aborted)throw error;
          feedback=[error.message];history.push({attempt,plan:null,proposal:error.proposal??null,audit:null,findings:[...feedback]});
          try{onProgress(structuredClone(history.at(-1)));}catch{/* Feedback observers cannot approve a proposal. */}
          continue;
        }
        if(proposal?.unsupported!==undefined&&(!Array.isArray(proposal.unsupported)||proposal.unsupported.some(v=>typeof v!=='string')))throw new DirectionError('The planner returned an invalid unsupported-requirements list.');
        if(proposal?.unsupported?.length)throw new DirectionError(`Unimplemented requirements: ${proposal.unsupported.join('; ')}`);
        candidate=proposal?.plan??proposal;
      }
      let preview=null,rendered=null,visualReview=null;
      try {
        candidate=validatePlan({...candidate,direction});
        preview=await this.preview(candidate,revision,instance);cancelled();
        if(preview.status!=='previewed') {
          if(['disconnected','no_connected_client','unknown_request','dispatched'].includes(preview.status))return preview;
          feedback=[preview.message??preview.error??'The rendering client rejected this preview.'];
        }else feedback=describeAuditFailures(preview.audit);
        if(!feedback.length&&this.reviewer) {
          const receipt=await this.render(structuredClone(candidate),revision,instance,{signal});cancelled();
          if(receipt?.status!=='rendered')throw new DirectionError(receipt?.message??'The rendering client could not provide visual evidence.');
          const evidence=validateRenderedReview(receipt.evidence,{plan:candidate,revision,instanceId:instance});rendered=renderedReviewSummary(evidence);
          const assessment=await this.reviewer({direction,plan:structuredClone(candidate),state:structuredClone(snapshot.state),capabilities:structuredClone(snapshot.capabilities),evidence:structuredClone(evidence),audit:structuredClone(preview.audit),history:structuredClone(history),attempt,signal});cancelled();
          visualReview=validateVisualAssessment(assessment,evidence);
          if(visualReview.verdict==='revise')feedback=visualReview.findings.map(f=>`Visual ${f.kind} at ${f.time.toFixed(3)} s: ${f.description} ${f.suggestion}`);
          else if(visualReview.verdict==='unreviewable')throw new DirectionError(`The proposed performance could not be visually reviewed: ${visualReview.summary}`);
        }
      }catch(error){if(signal?.aborted)throw error;feedback=[error.message];}
      history.push({attempt,plan:structuredClone(candidate),audit:preview?.audit??null,...(rendered?{rendered,visualReview}:{}),findings:[...feedback]});
      try{onProgress(structuredClone(history.at(-1)));}catch{/* Observers cannot approve a failed take. */}
      if(!feedback.length) {
        cancelled();
        onCommit();cancelled();
        const result=await this.perform(candidate,revision,instance);
        return {...result,plan:candidate,history,artisticReview:visualReview?.verdict==='accept'?'sampled_visual_review':'not_reviewed'};
      }
      if(/(?:performance|character) changed/i.test(feedback.join(' ')))throw new DirectionError('The character or performance changed while planning. Inspect it again.');
      candidate=null;
    }
    const error=new DirectionError(`No performance was committed: ${feedback.join(' ')}`);error.attempts=history;throw error;
  }
}
