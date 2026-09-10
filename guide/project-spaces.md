# Project spaces

Project spaces keep ongoing work together: a shared brief, decisions, current state, a checklist, reference files, and a separate conversation with each agent.

Open **Project spaces** using the folder button in the sidebar, then choose **New project**. Give it a name, describe the goal and constraints in **Shared brief**, and save. Choose **Open chat** to start working inside the project. The project name above chat shows which space is active; **General chat** returns to your ordinary conversations.

## Shared context

Every agent answering inside a space receives its saved brief, decisions, next steps, checklist, and file references. Delegated workers inherit that context. Use **Details** to keep the project's decisions and current state up to date; saved changes apply to the next message. The notes and checklist are edited by you, rather than automatically inferred from replies.

### Automatic progress and clearing context

Use **Clear session** or type **`/clear`** by itself to clear the current agent's conversation. Inside a project, OE first saves the conversation and a handoff automatically, including available partial replies and tool results when work was interrupted. If saving fails, the conversation is kept and Clear reports an error. Other project chats stay intact.

The next project message includes saved handoffs so the agent can resume from previous findings, decisions, and remaining work. A compact summary is prepared using the same agent's configured model; saved excerpts remain available if that model is unavailable. Agents can read or search the full saved conversations with `read_project_progress`. Interrupted operations are not treated as completed work.

Open the project's **Progress** tab to review handoffs or download saved conversations. OE also saves a handoff before automatically trimming older project history. Your shared brief, decisions, next steps, and checklist remain your own editable notes. Clearing a project conversation preserves its saved progress; it is not a deletion of those archives. General chat clears without creating project handoffs.

Progress is stored under `users/<profile>/project-spaces/<projectId>/progress.json`, with the saved conversations alongside it, and is included in profile backups. Work already cleared or trimmed before this feature was enabled cannot be recovered through it.

Each agent has its own conversation within the project. **Chats** opens those conversations, including earlier messages after a reload. Switching projects opens a fresh view and leaves any running work in its original space. Different browser tabs can use different spaces.

Project conversation history and composer drafts are separate from general chat and other spaces. OE does not automatically learn project conversations into its general conversation memory. Your profile's standing preferences, explicitly saved memories, agents, connected services, and tool permissions remain available; a project is an organizational space within your profile, not a separate permissions sandbox.

## Files and tasks

Use the project's **Files** tab to upload reference files. They are stored in your profile and linked to the project, and agents can read them using the listed file references. Click a file to download it. **Remove link** removes it from the project while keeping the original profile file. Files uploaded only through the chat composer remain chat attachments; add them through the project's Files tab when they should be shared project references.

The **Checklist** is a manual list of project tasks. Add an item, mark it complete, then choose **Save changes**. It does not create a scheduled reminder. Agent tasks scheduled from project chat retain the project's context and conversation when they run, including after a server restart. Manage those schedules in the existing **Tasks** drawer.

**Goals and prepared work** tracks ongoing outcomes with next steps, blockers, deadlines, and completion conditions. Ask an agent to track a goal in project chat, or add one from this view. OE can prepare a meeting brief, reference summary, comparison, or proposed next steps using the project's notes and linked files. Review a proposal before applying its next steps and checklist. Background preparation is controlled separately in **Settings → Personalization**; see [Goals and prepared work](personalization.md#goals-and-prepared-work).

## Saving and archiving

Unsaved edits to an existing project are retained as a draft in this browser tab, including across reloads. Separate tabs keep separate drafts. If another tab saves first, OE rejects the stale save and keeps your draft visible. Copy any edits you want to preserve, then choose **Reload saved version** before combining the changes.

**Archive** keeps a finished project, its files, and its conversations available. Choose **Unarchive** to return it to active work. Archiving does not cancel scheduled tasks; pause those in **Tasks** if needed.

Project data lives inside your profile and is included in OE backups. Each profile can keep up to 64 spaces, with up to 100 file links and 100 checklist items per space. Each agent's project conversation follows OE's existing chat-history retention limits.
