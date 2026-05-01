# Roles

A **role** is the persona, workflow rules, and default skill set an agent uses. Roles are separate from agents on purpose — you can swap an agent's role at any time without rebuilding it or losing chat history.

## Why roles exist

Without roles, every agent's "personality" would have to be hand-written into its system prompt and re-pasted whenever you wanted a different specialist. With roles:

- The Coordinator can reassign the right role to the right work.
- Workflow rules ("always confirm before sending email", "summarise after every research step") live with the role, not the agent — so reassignment is clean.
- Built-in roles can be updated by OpenEnsemble updates without touching your custom agents.

## Built-in roles

| Role | Purpose |
|---|---|
| **Coordinator** | Front-door agent; reads incoming messages and delegates to a specialist |
| **Coder** | Writes, edits, runs code in a sandboxed project |
| **Researcher** | Multi-step web research, persists output as a research document |
| **Email** | Manages Gmail, Microsoft Exchange, IMAP — read, search, draft, send |
| **Calendar** | Reads and writes Google Calendar events |
| **Expenses** | Parses receipts/invoices, tracks spending across groups |
| **Tutor** | Adaptive subject tutor with progress tracking |
| **Image Generator** | Text-to-image — works with any image-capable provider (Fireworks Flux, Grok, OpenAI image, …) |
| **Video Generator** | Text-to-video |
| **Notes** | Personal note-taking and recall |

(The set you see may differ if your owner has hidden some.)

## Switching role on an existing agent

In the agent's edit panel, change **Role**. The role's system prompt addition replaces the previous one; tool defaults are reapplied; chat history stays. The agent's name, emoji, and personal system prompt are untouched.

## Role defaults vs. per-agent overrides

A role provides:
- A `systemPromptAddition` block prepended to every chat
- A `defaultToolIds` list — which skills/tools are unlocked

Per-agent you can:
- Add to the system prompt (your own line)
- Toggle individual tools on or off relative to the role's defaults

If you find yourself making the same change to many agents with the same role, that's a hint the change belongs in a custom role instead. Custom roles are managed in **Settings → Skills → Roles**.
