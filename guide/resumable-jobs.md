# Resumable agent jobs

Background workers and single-stage agent delegations now save progress while they work. After an OE restart, a supported job continues in its original chat or project space. Its task card shows **Resuming**, and the finished result appears in the usual place.

## What gets saved

OE saves the task, agent and model selection, originating chat, tool arguments, completed tool results, and saved media references. Each tool call is recorded before it executes; its result is saved before the agent continues. Completed actions from the previous process are supplied to the resumed agent. If it requests the same completed action again with the same arguments, OE returns the saved result without executing it again. Read tools can run again to check current state.

Recovery starts a new model turn with this saved progress. It does not preserve a provider's unfinished token stream or hidden reasoning. Reworded tool arguments are a different call, so the saved history also tells the agent which work is already complete.

## When a job pauses

A restart can happen after an action takes effect but before its result reaches OE. For example, a command might write a file before its connection closes. OE cannot infer whether that action completed, so the task card shows **Paused** and **Review & resume**.

Open the review dialog and check the listed action and arguments. For each uncertain action, choose one of these outcomes:

- **It completed:** enter the result you verified. OE passes that result to the agent and prevents the identical action from running again.
- **Authorize this action to run again:** use this after checking the outcome and deciding a retry is appropriate.

Then select **Resume job**. Your choices are saved with the job. Another browser tab cannot submit a stale review or start a second copy.

Use **Stop** to cancel either a running or paused job. Cancellation is saved before the job is interrupted, so it stays stopped across another restart. Paused jobs remain available until you resume or stop them.

## Recovery checks and limits

OE checks current account access, the agent's available tools, the project, and the original chat's clear history before starting recovery. A cleared chat cannot be revived by an old job. If access hours or tool assignments prevent continuation, the job pauses for review. After three automatic restart recoveries, it also pauses instead of repeatedly restarting without your attention.

This recovery covers detached workers and standalone, single-stage delegations. Scheduled jobs, live agent teams, multi-stage handoffs, tools that transfer execution into another job, and verification jobs with temporary capabilities retain the existing interrupted-job handling. Requests offering provider-hosted image generation also retain that handling because OE cannot track the hosted action before it executes. Ordinary foreground chat turns use their existing interruption handling.

Each job keeps at most 256 local tool actions and 8 MB of checkpoint data. Restoring more than 96,000 characters of completed results pauses for manual review. OE keeps complete saved results rather than silently dropping evidence to fit the model prompt. Checkpoints use the existing private restart journal and are removed after completion has been delivered.
