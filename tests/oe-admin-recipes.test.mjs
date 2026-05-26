import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateRecipe } from '../lib/oe-admin-paths.mjs';

// lib/paths.mjs redirects BASE_DIR to a tmp under VITEST — but the shipped
// recipes we want to validate live in the real install. Derive that directly
// from this file's location.
const REAL_BASE   = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECIPES_DIR = path.join(REAL_BASE, 'skills', 'oe-admin', 'integrations');

describe('shipped recipes pass validation', () => {
  const files = fs.existsSync(RECIPES_DIR)
    ? fs.readdirSync(RECIPES_DIR).filter(n => n.endsWith('.json'))
    : [];

  it('found at least one recipe', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const f of files) {
    it(`recipe "${f}" validates`, () => {
      const raw = JSON.parse(fs.readFileSync(path.join(RECIPES_DIR, f), 'utf8'));
      expect(() => validateRecipe(raw)).not.toThrow();
    });
  }
});

describe('systemd-unit recipe specifics', () => {
  const recipePath = path.join(RECIPES_DIR, 'systemd-unit.json');
  const skipIfMissing = fs.existsSync(recipePath) ? it : it.skip;

  skipIfMissing('uses env templates for all install-specific values', () => {
    const raw = fs.readFileSync(recipePath, 'utf8');
    expect(raw).toMatch(/\{\{env\.OE_BASE_DIR\}\}/);
    expect(raw).toMatch(/\{\{env\.OE_NODE_BIN\}\}/);
    expect(raw).toMatch(/\{\{env\.OE_USER\}\}/);
    expect(raw).toMatch(/\{\{env\.OE_SUPERVISE\}\}/);
  });

  skipIfMissing('marks all systemctl + tee steps requiresRoot', () => {
    const recipe = JSON.parse(fs.readFileSync(recipePath, 'utf8'));
    for (const step of [...recipe.steps, ...recipe.rollback]) {
      const bin = step.cmd[0];
      if (['systemctl', 'tee', 'rm'].includes(bin)) {
        expect(step.requiresRoot, `step ${step.id} (cmd ${bin}) must require root`).toBe(true);
      }
    }
  });

  skipIfMissing('declares rollback steps', () => {
    const recipe = JSON.parse(fs.readFileSync(recipePath, 'utf8'));
    expect(recipe.rollback.length).toBeGreaterThan(0);
    // Must remove the unit file.
    const ids = recipe.rollback.map(s => s.id);
    expect(ids).toContain('remove-unit');
  });
});
