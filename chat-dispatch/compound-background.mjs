// @ts-check
/**
 * Deterministic singleton compound-workflow fast path.
 *
 * This is server-owned admission, not prompt advice: when the routed tool
 * schemas show that a self-contained multi-capability chain will occupy the
 * foreground for long enough, start exactly one ordinary Jarvis worker and
 * finish the visible turn immediately. The worker lifecycle, task chip,
 * idempotency, stop/status controls, and completion notification remain the
 * existing singleton worker implementation.
 */

import { appendToSession, failPendingTurn } from '../sessions.mjs';
import { listRoles, getRoleManifest } from '../roles.mjs';
import { trimToolsForTurn } from '../lib/tool-router.mjs';
import {
  compoundWorkerExecutionTask,
  evaluateCompoundBackground,
} from '../lib/compound-background-policy.mjs';
import { buildCompoundWorkflowContract } from '../lib/compound-workflow-contract.mjs';
import { supportsImageGeneration } from '../lib/model-capabilities.mjs';
import { routingInstructionClauses } from '../lib/routing-clauses.mjs';

function toolName(tool) {
  return tool?.function?.name || tool?.name || '';
}

function routedEntries(tools, userId) {
  const ownerByTool = new Map();
  for (const listed of listRoles(userId)) {
    const manifest = getRoleManifest(listed.id, userId) || listed;
    for (const tool of (Array.isArray(manifest?.tools) ? manifest.tools : [])) {
      const name = toolName(tool);
      if (name && !ownerByTool.has(name)) ownerByTool.set(name, { ownerId: manifest.id, owner: manifest });
    }
  }
  return (tools || []).map(tool => ({
    tool,
    ...(ownerByTool.get(toolName(tool)) || {}),
  }));
}

function providerNativeEntries(agent, trim, userId) {
  if (!supportsImageGeneration(agent?.provider, agent?.model)) return [];
  const routedSkills = trim?.skillsKept instanceof Set
    ? trim.skillsKept
    : (trim?.initiallyIncludedSkills instanceof Set ? trim.initiallyIncludedSkills : new Set());
  for (const skillId of routedSkills) {
    const manifest = getRoleManifest(skillId, userId);
    if (!manifest) continue;
    const manifestText = [
      manifest.name, manifest.description, manifest.category,
      ...(Array.isArray(manifest.intent_examples) ? manifest.intent_examples : []),
    ].filter(Boolean).join(' ');
    // The provider capability is generic; the routed manifest decides whether
    // this turn requested it. This survives removal of an unusable local image
    // function without hard-coding a user's skill or wording into the policy.
    if (manifest.category !== 'image'
        && !/\b(?:create|draw|generate|render)\b[\s\S]{0,80}\b(?:image|illustration|photo|picture)\b/i.test(manifestText)) continue;
    return [{
      ownerId: manifest.id,
      owner: manifest,
      tool: {
        type: 'function',
        native: true,
        function: {
          name: 'image_generation',
          description: 'Generate or render an image, picture, photo, or illustration and return the produced image artifact for later workflow steps such as saving, attaching, or delivery.',
          parameters: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: 'Description of the image to generate.' },
            },
            required: ['prompt'],
          },
        },
      },
    }];
  }
  return [];
}

function workerTaskId(result) {
  return String(result || '').match(/\b(wkr_\d+_[a-z0-9]+)\b/i)?.[1] || null;
}

function abortedOutcome({ decision = null, taskId = null, admissionStarted = false, label = null, startedAt = null } = {}) {
  const durationMs = startedAt == null ? 0 : Date.now() - startedAt;
  return {
    handled: true,
    aborted: true,
    admitted: Boolean(taskId),
    admissionStarted,
    ...(admissionStarted && !taskId ? { admissionUncertain: true } : {}),
    ...(taskId ? { taskId } : {}),
    ...(decision ? { decision } : {}),
    ...(label ? {
      trace: {
        name: 'spawn_worker', args: { label },
        result: taskId ? `Worker ${taskId} admitted before foreground abort.` : 'Foreground aborted before worker admission was confirmed.',
        status: 'stopped', durationMs,
      },
    } : {}),
  };
}

/**
 * Policy misses fail open to the ordinary foreground model path. Once the
 * foreground turn is aborted or worker admission begins, return {handled:true}
 * so the caller cannot duplicate the detached work in its normal model path.
 */
export async function trySingletonCompoundBackground({
  userId,
  agentId,
  agent,
  userText,
  source = null,
  attachments = [],
  toolPlan = null,
  documentRequest = null,
  hiddenUser = false,
  backgroundContinuation = false,
  isolatedTaskRun = false,
  readOnlyTurn = false,
  labVerifierTurn = false,
  signal = null,
  onEvent,
}) {
  if (!agent?._rosterSolo || agent?.skillCategory !== 'coordinator' || agent?.ephemeral) return null;
  if (hiddenUser || backgroundContinuation || isolatedTaskRun || readOnlyTurn || labVerifierTurn) return null;
  if (documentRequest || (Array.isArray(attachments) && attachments.length > 0)) return null;
  if (toolPlan?.mode === 'selected' || toolPlan?.mode === 'none') return null;
  if (!(agent.tools || []).some(tool => toolName(tool) === 'spawn_worker')) return null;
  // Avoid both router work and any router-side environmental dependency for
  // the overwhelmingly common one-step chat turn. Full schema routing is only
  // useful after the conservative clause splitter proves a compound request.
  if (routingInstructionClauses(userText, { max: 8 }).length < 2) return null;
  if (signal?.aborted) return abortedOutcome();

  let trim;
  try {
    trim = await trimToolsForTurn({ agent, userText, userId, source });
  } catch (error) {
    console.warn('[compound-background] routing preview failed; keeping foreground:', error?.message || error);
    return null;
  }
  // trimToolsForTurn is asynchronous. Stop/Clear may have landed while it was
  // routing schemas, so do not continue from that stale preview into any
  // side-effectful worker admission.
  if (signal?.aborted) return abortedOutcome();
  const decision = evaluateCompoundBackground({
    userText,
    entries: [
      ...routedEntries(trim?.trimmedTools || [], userId),
      ...providerNativeEntries(agent, trim, userId),
    ],
  });
  if (!decision.shouldBackground) return null;

  const label = `Complete ${decision.matchedSteps.length}-step workflow`;
  // Server-only evidence contract. It is passed outside the model-visible tool
  // arguments and travels atomically with worker admission, so a fast worker
  // cannot finish before its required-step gate is attached.
  const completionContract = buildCompoundWorkflowContract(decision);
  // If the user explicitly told the foreground manager to call spawn_worker,
  // that part is already satisfied here. Give the leaf worker an execution-only
  // prompt so it performs the underlying steps instead of requesting another
  // worker. The original text remains the durable task/idempotency identity.
  const executionTask = compoundWorkerExecutionTask(userText);
  let result = '';
  const startedAt = Date.now();
  let admissionStarted = false;
  try {
    const { executeSkillTool } = await import('../skills/delegate/execute.mjs');
    const iterator = executeSkillTool(
      'spawn_worker', { task: userText, label }, userId, `${userId}_${agentId}`,
      {
        completionContract,
        ...(executionTask ? { executionTask } : {}),
      },
    )[Symbol.asyncIterator]();
    // This is the final check immediately before iterator.next() enters the
    // delegate's idempotent admission path. There is deliberately no await
    // between this check and admissionStarted/next().
    if (signal?.aborted) {
      return abortedOutcome({ decision, label, startedAt });
    }
    admissionStarted = true;
    while (true) {
      const step = await iterator.next();
      if (step.done) break;
      const event = step.value;
      if (event?.type === 'result' && event.text) result = String(event.text);
    }
  } catch (error) {
    if (signal?.aborted) {
      // Admission may already have crossed its durable at-most-once boundary.
      // Suppress foreground error/ack output and never fall through to a
      // second execution; the outer turn finalizer owns the stopped terminal.
      return abortedOutcome({
        decision,
        taskId: workerTaskId(result),
        admissionStarted,
        label,
        startedAt,
      });
    }
    // Worker admission is fail-closed because a durable idempotency tombstone
    // may mean the detached job started even if the caller did not receive its
    // id. Never fall through and repeat the side effects in the foreground.
    const message = `I couldn't confirm whether the background workflow started: ${error?.message || error}. Check the task list before retrying.`;
    await failPendingTurn(`${userId}_${agentId}`, message, { retryable: false }).catch(() => {});
    onEvent?.({ type: 'error', agent: agentId, code: 'background_admission_uncertain', retryable: false, message });
    return {
      handled: true,
      aborted: false,
      admitted: false,
      admissionStarted,
      admissionUncertain: true,
      trace: { name: 'spawn_worker', args: { label }, result: message, status: 'error', durationMs: Date.now() - startedAt },
      decision,
    };
  }

  const taskId = workerTaskId(result);
  if (signal?.aborted) {
    // A confirmed worker remains detached and owns its own AbortController.
    // The browser turn's abort only stops foreground acknowledgement; retries
    // remain coalesced by the existing durable worker admission record.
    return abortedOutcome({ decision, taskId, admissionStarted, label, startedAt });
  }
  // Capacity/no-owner/malformed-task declines did not start anything. Let the
  // normal model path decide whether to work foreground or explain the block.
  if (!taskId) return null;

  const args = { task: userText, label };
  const durationMs = Date.now() - startedAt;
  onEvent?.({ type: 'tool_call', agent: agentId, name: 'spawn_worker', args });
  if (signal?.aborted) return abortedOutcome({ decision, taskId, admissionStarted, label, startedAt });
  onEvent?.({ type: 'tool_result', agent: agentId, name: 'spawn_worker', text: result, durationMs });
  if (signal?.aborted) return abortedOutcome({ decision, taskId, admissionStarted, label, startedAt });
  const ack = `I started that ${decision.matchedSteps.length}-step workflow in the background (task ${taskId}). You can keep chatting; I’ll post the completed result here.`;
  try {
    await appendToSession(`${userId}_${agentId}`,
      { role: 'user', content: userText, ts: Date.now() },
      {
        role: 'assistant', content: ack, ts: Date.now(),
        toolsUsed: [`spawn_worker(${JSON.stringify({ label })})`],
        toolResults: [{ name: 'spawn_worker', text: result }],
        toolEvents: [{
          name: 'spawn_worker', args: { label }, status: 'done',
          startedAt, endedAt: Date.now(), durationMs,
        }],
      });
  } catch (error) {
    if (signal?.aborted) {
      return abortedOutcome({ decision, taskId, admissionStarted, label, startedAt });
    }
    const message = `The background task ${taskId} started, but its chat acknowledgement could not be saved. Do not retry it automatically.`;
    console.warn('[compound-background] acknowledgement persist failed:', error?.message || error);
    await failPendingTurn(`${userId}_${agentId}`, message, { retryable: false }).catch(() => {});
    onEvent?.({ type: 'error', agent: agentId, code: 'persistence_failed', retryable: false, message });
    return {
      handled: true,
      aborted: false,
      admitted: true,
      admissionStarted,
      taskId,
      decision,
      trace: { name: 'spawn_worker', args: { label }, result, status: 'error', durationMs },
    };
  }

  if (signal?.aborted) return abortedOutcome({ decision, taskId, admissionStarted, label, startedAt });
  onEvent?.({ type: 'token', agent: agentId, text: ack });
  if (signal?.aborted) return abortedOutcome({ decision, taskId, admissionStarted, label, startedAt });
  onEvent?.({ type: 'done', agent: agentId });
  if (signal?.aborted) return abortedOutcome({ decision, taskId, admissionStarted, label, startedAt });
  return {
    handled: true,
    aborted: false,
    admitted: true,
    admissionStarted,
    taskId,
    decision,
    trace: { name: 'spawn_worker', args: { label }, result, status: 'done', durationMs },
  };
}

export const _internal = { providerNativeEntries, routedEntries, workerTaskId };
