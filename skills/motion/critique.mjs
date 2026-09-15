export function describeAuditFailures(audit) {
  const out=[];
  if(!audit?.finite)out.push('The take contains invalid transforms.');
  if(audit?.checks?.footSeparation===false)out.push(`The planted sole bounds overlap or lack valid geometry: ${Number(audit?.contacts?.settledSoles?.minSeparation??NaN).toFixed(4)} m separating margin. Use a stance and turn with clear foot placements.`);
  if(audit?.contacts?.evidence===false)out.push('The take lacks tracked ground-contact evidence. Restore serialized starting feet through the document-opening API or supply calibrated contact identities; unsupported airborne motion cannot pass this check.');
  else if(!audit?.checks?.contacts)out.push(`A planted contact moved: ${Number(audit?.contacts?.maxError??0).toFixed(4)} m maximum error.`);
  if(!audit?.checks?.reach)out.push(`A target is unreachable: hand ${Number(audit?.maxHandResidual??0).toFixed(4)} m, foot ${Number(audit?.maxFootResidual??0).toFixed(4)} m. Inspect worstReach.`);
  if(audit?.checks?.fingertipTargets===false){const worst=audit.fingertipTargets?.worst;out.push(worst?`The ${worst.side} ${worst.effector} misses its authored target by ${(worst.error*1000).toFixed(3)} mm at ${worst.time.toFixed(3)} s (score time ${worst.scoreTime.toFixed(3)} s). Preserve the requested finger and location while correcting reach, palm orientation or calibration.`:'The authored fingertip trajectory lacks finite target measurements.');}
  if(!audit?.checks?.boneLengths)out.push('The take changed a bone length.');
  if(audit?.checks?.sceneClearance===false)out.push(`The body enters scene geometry during locomotion (${Number(audit.scene?.minBodyClearance).toFixed(4)} m clearance). Replan the route.`);
  if(audit?.checks?.handClearance===false)out.push(`The ${audit.scene?.worstHandContact?.side??''} hand intersects “${audit.scene?.worstHandContact?.obstacle??'scene geometry'}” at ${Number(audit.scene?.worstHandContact?.time??0).toFixed(3)} s. Change the gesture path or staging.`);
  if(audit?.checks?.armClearance===false)out.push(`The ${audit.scene?.worstArmContact?.joint??'arm'} intersects “${audit.scene?.worstArmContact?.worst?.obstacle??'scene geometry'}” at ${Number(audit.scene?.worstArmContact?.time??0).toFixed(3)} s. Change the elbow route, hand target or staging.`);
  if(audit?.checks?.armSelfClearance===false)out.push(`The ${(audit.selfContact?.worst?.joints??['opposing arms']).join(' and ')} intersect at ${Number(audit.selfContact?.worst?.time??0).toFixed(3)} s. No checked elbow paths separate them; give the hand targets more room or change their timing.`);
  if(audit?.checks?.thumbPalmClearance===false){
    const hands=audit.selfContact?.hands;
    for(const [kind,worst] of [['fingers',hands?.worstThumb],['palm',hands?.worstPalm]])if(worst?.penetration>=.001){
      const contact=kind==='fingers'?worst.joints.join(' and '):worst.joint+' and its palm';
      out.push(`The ${contact} intersect by ${(worst.penetration*1000).toFixed(2)} mm at ${worst.time.toFixed(3)} s (score time ${worst.scoreTime.toFixed(3)} s). Revise the ${worst.side} finger/thumb curls while preserving the requested hand shape. Moving or rotating the whole hand, or adding time, cannot separate fingers within that same hand. Use the available calibrated point fit when it satisfies the direction; report an unsupported thumb pose explicitly if it cannot be preserved.`);
    }
    if(!hands?.finite)out.push('The custom hand lacks finite finger/palm contact measurements.');
  }
  if(audit?.checks?.headClearance===false){
    const head=audit.selfContact?.head,worst=head?.worst;
    out.push(worst?`The ${worst.joint??worst.side+' hand'} enters the measured head envelope by ${(head.maxPenetration*1000).toFixed(2)} mm at ${worst.time.toFixed(3)} s (score time ${worst.scoreTime.toFixed(3)} s). Move the hand path outside the head and hair, or revise its finger curl/palm orientation. Authored hand targets remain exact; adding time alone does not clear a penetrating held pose.`:'The measured head has incomplete hand-surface coverage. Supply hand skin or finger calibration before checking head contact.');
  }
  if(audit?.checks?.thighClearance===false){
    const thighs=audit.selfContact?.thighs,worst=thighs?.worst;
    out.push(worst?`The ${worst.joint??worst.side+' hand'} enters the measured ${worst.bodyJoint} envelope by ${(thighs.maxPenetration*1000).toFixed(2)} mm at ${worst.time.toFixed(3)} s (score time ${worst.scoreTime.toFixed(3)} s). Give the hand room around the passing thigh or revise its finger curl/palm orientation while preserving the action. Authored targets remain exact; adding time alone cannot clear a held intersection.`:'The measured thighs have incomplete hand-surface coverage. Supply hand skin or finger calibration before checking thigh contact.');
  }
  if(audit?.checks?.handTorsoClearance===false){
    const torso=audit.selfContact?.handTorso,worst=torso?.worst;
    out.push(worst?`The ${worst.joint} surface enters the measured ${worst.bodyJoint} envelope by ${(torso.maxPenetration*1000).toFixed(2)} mm at ${worst.time.toFixed(3)} s (score time ${worst.scoreTime.toFixed(3)} s). Give the hand and fingers room around the torso. Explicit held targets remain exact; revise the offset, palm facing or curl to clear a held intersection.`:'Measured hand/torso contact needs hand surface coverage.');
  }
  if(audit?.checks?.torsoClearance===false){
    const torso=audit.selfContact?.torso,worst=torso?.worst;
    out.push(worst?`The ${worst.joint} surface enters the measured ${worst.bodyJoint} envelope by ${(torso.maxPenetration*1000).toFixed(2)} mm at ${worst.time.toFixed(3)} s (score time ${worst.scoreTime.toFixed(3)} s). Give the elbow and arm room in front of or beside the torso. Exact authored wrist targets remain unchanged; adding time cannot clear a held intersection.`:'Measured torso contact requires complete arm skin coverage. Supply both arm bindings before accepting this take.');
  }
  if(audit?.checks?.hinges===false)out.push(`A calibrated joint constraint failed: ${audit.anatomy?.worst?.joint??'limb'} at ${Number(audit.anatomy?.worst?.time??0).toFixed(3)} s. Inspect anatomy for bend-plane deviation and range excess.`);
  if(audit?.checks?.wrists===false){
    const wrist=audit.anatomy?.worstWrist,limit=wrist?.limiting;
    const detail=limit?` Its ${limit.channel} is ${Number(limit.value).toFixed(3)} rad; the calibrated interval is [${Number(limit.minimum).toFixed(3)}, ${Number(limit.maximum).toFixed(3)}] rad.`:'';
    out.push(`The ${wrist?.joint??'wrist'} exceeds its calibrated range at ${Number(wrist?.time??0).toFixed(3)} s.${detail} Adjust the hand approach, palm orientation or body posture; adding time alone does not repair an out-of-range pose.`);
    for(const held of (audit.anatomy?.heldWristFailures??[]).slice(0,3)){
      const limit=held.limiting,detail=limit?` Its ${limit.channel} is ${Number(limit.value).toFixed(3)} rad, outside [${Number(limit.minimum).toFixed(3)}, ${Number(limit.maximum).toFixed(3)}] rad.`:'';
      out.push(`Beat ${held.beat+1} also fails while holding its authored ${held.joint} target at ${held.time.toFixed(3)} s (score time ${held.scoreTime.toFixed(3)} s).${detail} Revise the held hand position, palm or body posture; changing recovery timing alone leaves this held failure unchanged.`);
    }
  }
  if(audit?.checks?.grips===false)out.push(`The prop grip failed: ${audit.interactions?.worst?.object??'prop'} at ${Number(audit.interactions?.worst?.time??0).toFixed(3)} s. Inspect interaction reach, skin penetration and contact gaps.`);
  if(audit?.checks?.gaze===false){const eye=audit.gaze?.worst??audit.gaze?.worstRange;out.push(`The ${eye?.joint??'eye'} cannot maintain the requested focus at ${Number(eye?.time??0).toFixed(3)} s (ray error ${Number(audit.gaze?.maxError??0).toFixed(3)} rad, eye range excess ${Number(audit.gaze?.maxRangeExcess??0).toFixed(3)} rad). Turn the body toward the target, move the focus farther away, or revise calibrated eye limits from measured rig data. Do not describe clamped gaze as exact fixation.`);}
  for(const [name,passed] of Object.entries(audit?.checks??{}))if(passed===false&&!['finite','fingertipTargets','footSeparation','contacts','reach','boneLengths','jointSpeed','sceneClearance','handClearance','armClearance','armSelfClearance','thumbPalmClearance','headClearance','thighClearance','torsoClearance','handTorsoClearance','hinges','wrists','grips','gaze'].includes(name))out.push(`The ${name} constraint check failed.`);
  if(audit?.maxJointSpeed>18)out.push(`Review the rapid ${audit.worstJoint.name} rotation at ${audit.worstJoint.time.toFixed(3)} s (${audit.maxJointSpeed.toFixed(2)} rad/s).`);
  return out;
}
