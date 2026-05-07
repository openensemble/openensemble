/**
 * Mechanism handler registry.
 *
 * Built-in handlers are registered at module load. External callers can
 * register additional mechanisms via registerHandler() — used by tests and
 * by future skill-supplied mechanisms (none planned yet).
 *
 * Each handler exports an object with: name, minimumRisk(opSpec)?,
 * capture(opSpec, ctx), execute(opSpec, ctx), restore(record, ctx),
 * validate(record, ctx).
 */

import { http }        from './http.mjs';
import { noop }        from './noop.mjs';
import { cli }         from './cli.mjs';
import { config_file } from './config_file.mjs';

const handlers = new Map();

function register(handler) {
  if (!handler?.name) throw new Error('handler missing name');
  handlers.set(handler.name, handler);
}

register(http);
register(noop);
register(cli);
register(config_file);

export function resolveHandler(mechanism) {
  return handlers.get(mechanism) || null;
}

export function registerHandler(handler) {
  register(handler);
}

export function listMechanisms() {
  return [...handlers.keys()];
}
