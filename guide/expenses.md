# Expenses

The Expenses drawer (sidebar wallet icon) is a personal-finance tracker tied into your agents. You don't have to type entries — drop a receipt or bank statement into chat and the expense agent extracts the line items.

## Concepts

- **Books** — your personal ledger. Each user gets their own.
- **Groups** — shared books across multiple users on the same install (e.g. household). Members see the same transactions.
- **Transactions** — individual entries with date, amount, category, notes, and (if applicable) the source receipt image.
- **Categories** — auto-suggested, editable.

## Receipt parsing

Drop a photo of a receipt, a PDF invoice, or a bank statement export into chat with your expenses agent. It will:

1. Run vision/OCR to read the document.
2. Extract date, total, vendor, and line items where possible.
3. Suggest a category based on prior transactions.
4. Save the entry to your active book or group.

Multi-page bank statements are parsed transaction-by-transaction.

## Views

Within the Expenses drawer:

- **Dashboard** — overview totals by category, time range.
- **Transactions** — searchable list, edit individual entries.
- **Reports** — month-over-month, by-category breakdowns, group splits.
- **Import Statement** — manual statement import flow.
- **Shared Group** — manage members and per-member totals.

## Sharing & groups

Owner/admin creates a group in Expenses → Shared Group → New Group. Add members. Anyone in the group can add transactions; the dashboard shows per-member contribution and split totals.

## Where it's stored

`users/{userId}/expenses/` for personal books; group state is shared and lives in `expenses/` at the install root. Each transaction now also carries a `sourceFileId` pointing back to the original receipt in your profile-files (`users/{userId}/documents/`). Receipts are kept indefinitely — tap a transaction to see (or re-export) the original image or PDF later. Backups capture both ledgers and receipts.

## Choosing the vision model

Receipt extraction needs a vision-capable model. Pick yours under **Settings → Profile → Vision model** — the dropdown is filtered to *only* models that accept image input, grouped by provider (Anthropic Claude 3+, ChatGPT, OpenAI GPT-4o/5, Gemini 1.5+, Llava / Qwen-VL / Gemma 3 on Ollama, vision-flagged LM Studio models, OpenRouter vision models). If the dropdown is empty, you don't have a vision-capable model available — pull one (`ollama pull llama3.2-vision`) or enable a cloud provider that has one (Anthropic / OpenAI). If your previously-saved pick disappears, the picker shows it with a warning so you know to re-pick.

## Tips

- Keep one expenses agent per user. Roles `expenses` is its default.
- Adding a category once is enough — the parser learns from your prior categorisations.
- For batch imports, drop the file directly into chat rather than uploading via the drawer; the agent's parsing is usually better than the bulk-import flow.
