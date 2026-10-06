# Project spaces

Project spaces keep ongoing work together: a shared brief, decisions, current state, assigned tasks, reference files, saved results, and independent chat histories.

Open **Project spaces** using the folder button in the sidebar, then choose **New project**. Give it a name, describe the goal and constraints in **Shared brief**, and save. Choose **Open chat** to start working inside the project. The project name above chat shows which space is active; **General chat** returns to your ordinary conversations.

## Shared context

Every agent answering inside a space receives its saved brief, decisions, next steps, checklist, and file references. Delegated workers inherit that context. Use **Details** to keep the project's decisions and current state up to date; saved changes apply to the next message. The notes and checklist are edited by you, rather than automatically inferred from replies.

### Automatic progress and clearing context

Use **Clear session** or type **`/clear`** by itself to clear the current agent's conversation. Inside a project, OE first saves the conversation and a handoff automatically, including available partial replies and tool results when work was interrupted. If saving fails, the conversation is kept and Clear reports an error. Other project chats stay intact.

The next project message includes saved handoffs so the agent can resume from previous findings, decisions, and remaining work. A compact summary is prepared using the same agent's configured model; saved excerpts remain available if that model is unavailable. Agents can read or search the full saved conversations with `read_project_progress`. Interrupted operations are not treated as completed work.

Open the project's **Progress** tab to review handoffs or download saved conversations. OE also saves a handoff before automatically trimming older project history. Your shared brief, decisions, next steps, and checklist remain your own editable notes. Clearing a project conversation preserves its saved progress; it is not a deletion of those archives. General chat clears without creating project handoffs.

Progress is stored under `users/<profile>/project-spaces/<projectId>/progress.json`, with the saved conversations alongside it, and is included in profile backups. Work already cleared or trimmed before this feature was enabled cannot be recovered through it.

Each agent has its own original conversation within the project. **Chats & activity** opens those conversations, including earlier messages after a reload. Switching chats or projects leaves running work in its original conversation. Different browser tabs can use different spaces.

Multiple chats can run at the same time, including chats with the same agent. Each response updates its originating chat's history. Reopen that chat to see its latest messages and running work. A shared model provider may queue requests even though OE keeps the conversations independent.

Use the **Saved chats** button beside Attach to keep additional conversations inside a project. **New chat** preserves the current conversation while starting a separate history. Project notes and progress remain shared. See [Saved chats](saved-chats.md).

### Chats, activity, and updates

Open **Chats & activity** to see the original conversations and named saved chats together, including each participating agent. Search by chat, agent, or the latest message. Status shows **Working**, **Needs your input**, **Finished**, **Failed**, or **Interrupted**, and includes active delegated workers. **Open chat** opens that exact conversation. The view refreshes every five seconds while visible.

The **Project updates** button appears when a reply finishes, work reports a result, or an agent needs attention in a project. Open an update to return to its chat, or dismiss it. Updates are stored in your profile and remain available after a reload. Reading the active conversation acknowledges its updates; looking at another project does not. A finished reply does not mean all project tasks are complete. Check the conversation's worker status for work still running.

Use **Save checkpoint** beside a conversation or under a reply to preserve its history immediately without clearing it. If it is still running, the checkpoint includes the available partial reply and identifies it as unfinished. Checkpoints appear in **Progress** and are available to future project turns.

### Save decisions, references, and outputs

Under a project reply, choose **Save as decision**, **Save as reference**, or **Save as output**. Give the result a title and review or edit the excerpt before saving. **Saved results** collects decisions and references with links to their source conversations. Recent saved decisions and references are included in future project messages; existing running turns keep the context with which they started.

**Outputs** collects generated documents, images, videos, and supported document or code links from project conversations, along with replies saved as outputs. Each entry identifies its source agent and conversation. Document versions record when the output was produced; downloading opens the current underlying file. Original files remain in their usual document or media storage. Reference uploads are still listed separately under **Files**. Older outputs are discovered from retained conversation history; outputs recorded after this feature was enabled also remain indexed after context is cleared.

Project conversation history and composer drafts are separate from general chat and other spaces. OE does not automatically learn project conversations into its general conversation memory. Your profile's standing preferences, explicitly saved memories, agents, connected services, and tool permissions remain available; a project is an organizational space within your profile, not a separate permissions sandbox.

## Files and tasks

Use the project's **Files** tab to upload reference files. They are stored in your profile and linked to the project, and agents can read them using the listed file references. Click a file to download it. **Remove link** removes it from the project while keeping the original profile file. Files uploaded only through the chat composer remain chat attachments; add them through the project's Files tab when they should be shared project references.

The **Tasks** section is a manual work list. Add an item, expand **Assignment, dependencies and result**, and choose an agent, conversation, status, prerequisites, relevant file paths, and a result link. Choose **Save changes** to share the updated tasks. An assignment does not start an agent or create a scheduled reminder; open the assigned chat to give the instruction. Existing checklist items remain available.

Prerequisites must be complete before a dependent task can be saved as working or done. Tasks marked working that claim the same file or overlapping directory display a warning. Use consistent workspace paths so the comparison is useful. These are coordination warnings based on the paths you record, not filesystem locks. Agents receive the saved assignments and dependencies as project context.

Agent tasks scheduled from project chat retain the project's context and conversation when they run, including after a server restart. Manage those schedules in the existing **Tasks** drawer.

**Goals and prepared work** tracks ongoing outcomes with next steps, blockers, deadlines, and completion conditions. Ask an agent to track a goal in project chat, or add one from this view. OE can prepare a meeting brief, reference summary, comparison, or proposed next steps using the project's notes and linked files. Review a proposal before applying its next steps and checklist. Background preparation is controlled separately in **Settings → Personalization**; see [Goals and prepared work](personalization.md#goals-and-prepared-work).

## Saving, archiving, and deleting

Unsaved edits to an existing project are retained as a draft in this browser tab, including across reloads. Separate tabs keep separate drafts. If another tab saves first, OE rejects the stale save and keeps your draft visible. Copy any edits you want to preserve, then choose **Reload saved version** before combining the changes.

Use **Archive** to set a finished project aside while keeping its files and conversations available. Mark completed tasks **Done** and choose **Save changes** before archiving if you want the checklist to reflect the result. Choose **Unarchive** to return the project to active work. Archiving does not stop running work or cancel scheduled tasks; pause those in **Tasks** if needed.

To permanently remove a project, open **Project spaces → your project → Overview**, scroll down, and choose **Delete project**. Review the project name and removal list in the dialog, then confirm. This removes its original and saved chats for every agent, shared notes and tasks, saved results, progress, project updates, goals, prepared work, and scheduled tasks. Files stored in your profile and files in external workspaces are kept. Deletion cannot be undone.

Deletion is blocked while replies are running in your profile or background tasks are running in that project. Wait for replies to finish, and stop or finish the project's background tasks before trying again. If another tab has edited the project, use **Reload saved version** before deleting. Open tabs for the deleted project return to general chat.

Project data lives inside your profile and is included in OE backups. Each profile can keep up to 64 spaces, with up to 100 file links and 100 checklist items per space. Each agent's project conversation follows OE's existing chat-history retention limits.
