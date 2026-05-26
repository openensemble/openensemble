import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { BASE_DIR } from '../lib/paths.mjs';
import {
  loadUserProviders, saveUserProviders, setUserProvider, removeUserProvider,
  mergeProviders,
} from '../lib/user-providers.mjs';

const OVERLAY_PATH = path.join(BASE_DIR, 'config', 'user-providers.json');

function cleanup() {
  try { fs.unlinkSync(OVERLAY_PATH); } catch {}
}

const STATIC = {
  openai:  { baseUrl: 'https://api.openai.com/v1', keyField: 'openaiApiKey', displayName: 'OpenAI' },
  groq:    { baseUrl: 'https://api.groq.com/openai/v1', keyField: 'groqApiKey', displayName: 'Groq' },
};

describe('user-providers overlay', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('returns {} when no overlay file', () => {
    expect(loadUserProviders()).toEqual({});
  });

  it('setUserProvider writes to disk + read returns it', () => {
    setUserProvider('cerebras', {
      baseUrl: 'https://api.cerebras.ai/v1',
      keyField: 'cerebrasApiKey',
      displayName: 'Cerebras',
    });
    const m = loadUserProviders();
    expect(m.cerebras.baseUrl).toBe('https://api.cerebras.ai/v1');
    expect(m.cerebras.addedAt).toBeTruthy();
  });

  it('mergeProviders unions static + overlay, static wins on collision', () => {
    setUserProvider('cerebras', { baseUrl: 'https://api.cerebras.ai/v1', keyField: 'cerebrasApiKey' });
    setUserProvider('openai',   { baseUrl: 'https://evil.example.com/v1', keyField: 'evilKey' });
    const merged = mergeProviders(STATIC);
    expect(merged.cerebras.baseUrl).toBe('https://api.cerebras.ai/v1');
    // static OpenAI must win — the overlay cannot redirect a built-in.
    expect(merged.openai.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('removeUserProvider drops the entry', () => {
    setUserProvider('cerebras', { baseUrl: 'https://x/v1', keyField: 'cerebrasApiKey' });
    expect(loadUserProviders().cerebras).toBeTruthy();
    removeUserProvider('cerebras');
    expect(loadUserProviders().cerebras).toBeUndefined();
  });

  it('setUserProvider rejects missing required fields', () => {
    expect(() => setUserProvider('bad', { keyField: 'x' })).toThrow(/baseUrl/);
    expect(() => setUserProvider('bad', { baseUrl: 'http://x/' })).toThrow(/keyField/);
  });
});
