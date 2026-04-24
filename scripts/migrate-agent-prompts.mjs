#!/usr/bin/env node
/**
 * One-time migration: shrink per-user agent systemPrompts down to identity-only
 * templates. All role/capability rules now live in skill manifests'
 * systemPromptAddition and are injected at runtime by
 * routes/_helpers.mjs:getAgentsForUser based on which tools resolve for the agent.
 *
 * Idempotent: an agent is only rewritten if its current systemPrompt contains
 * the literal agent name (meaning it is still the old non-template version).
 * Once rewritten, the prompt contains {{AGENT_NAME}} and subsequent runs skip it.
 *
 * Backup: each user's agents.json is copied to agents.json.pre-prompt-migration
 * before being rewritten. To roll back, replace agents.json with the backup.
 * Delete the backup once you've confirmed stability.
 *
 * Usage:
 *   node scripts/migrate-agent-prompts.mjs            # rewrite all users
 *   node scripts/migrate-agent-prompts.mjs --dry-run  # report only, no writes
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = path.dirname(__dirname);
const USERS_DIR = path.join(BASE_DIR, 'users');
const DRY_RUN = process.argv.includes('--dry-run');

function buildIdentityPrompt(description) {
  const desc = (description ?? '').trim() || 'AI assistant';
  return `You are {{AGENT_NAME}} {{AGENT_EMOJI}}, {{USER_NAME}}'s AI assistant. ${desc}\n\nBe concise and direct.`;
}

function migrateUserFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  let agents;
  try { agents = JSON.parse(raw); }
  catch (e) { console.warn(`[skip] ${file}: invalid JSON — ${e.message}`); return { touched: 0, skipped: 0 }; }
  if (!Array.isArray(agents)) { console.warn(`[skip] ${file}: not an array`); return { touched: 0, skipped: 0 }; }

  let touched = 0, skipped = 0;
  for (const a of agents) {
    const current = a.systemPrompt ?? '';
    // Already migrated — prompt uses the template form.
    if (current.includes('{{AGENT_NAME}}')) { skipped++; continue; }
    // Safety: only rewrite prompts that actually reference the agent's name
    // (hardcoded identity). Leaves manually-authored or unusual prompts alone.
    if (!a.name || !current.includes(a.name)) { skipped++; continue; }
    a.systemPrompt = buildIdentityPrompt(a.description);
    touched++;
    console.log(`  - ${a.id} (${a.name}): ${current.length} → ${a.systemPrompt.length} chars`);
  }

  if (touched > 0 && !DRY_RUN) {
    const backup = file + '.pre-prompt-migration';
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
    fs.writeFileSync(file, JSON.stringify(agents, null, 2) + '\n');
  }
  return { touched, skipped };
}

function main() {
  if (!fs.existsSync(USERS_DIR)) {
    console.error(`users dir not found: ${USERS_DIR}`);
    process.exit(1);
  }
  const entries = fs.readdirSync(USERS_DIR, { withFileTypes: true });
  let totalTouched = 0, totalSkipped = 0, filesRewritten = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(USERS_DIR, entry.name, 'agents.json');
    if (!fs.existsSync(file)) continue;
    console.log(`\nUser: ${entry.name}`);
    const { touched, skipped } = migrateUserFile(file);
    console.log(`  touched=${touched} skipped=${skipped}`);
    totalTouched += touched;
    totalSkipped += skipped;
    if (touched > 0) filesRewritten++;
  }
  console.log(`\n${DRY_RUN ? '[dry-run] ' : ''}done. ${totalTouched} agents migrated across ${filesRewritten} file(s); ${totalSkipped} already-migrated or skipped.`);
}

main();
