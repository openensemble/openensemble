import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

function source(file) {
  return fs.readFileSync(new URL(file, import.meta.url), 'utf8');
}

describe('single-assistant browser wiring smoke', () => {
  it('ships the settings controls and wires mode changes to roster refresh', () => {
    const html = source('./public/index.html');
    const settings = source('./public/settings.js');

    expect(html).toContain('id="orchestrationModeCard"');
    expect(html).toContain('<option value="single">Single assistant</option>');
    expect(html).toContain('<option value="ensemble">Agent ensemble</option>');
    expect(html).toContain('id="orchestrationPrimarySelect"');
    expect(settings).toContain("fetch(`/api/users/${encodeURIComponent(userId)}/orchestration`");
    expect(settings).toContain("method: 'PUT'");
    expect(settings).toContain("fetch('/api/agents'");
    expect(settings).toContain("showToast(body.mode === 'single' ? 'Single-assistant mode enabled' : 'Agent ensemble restored')");
  });

  it('surfaces pending-first-primary and managed-child states', () => {
    const settings = source('./public/settings.js');
    const agents = source('./public/agents.js');
    const admin = source('./public/admin.js');

    expect(settings).toContain('Single-assistant setup is ready. Create and name the first assistant to finish setup.');
    expect(settings).toContain("const managed = data.managed === true || _currentUser?.role === 'child'");
    expect(settings).toContain('Your parent or administrator manages whether this account uses one assistant or an ensemble.');
    expect(agents).toContain('policy?.pendingPrimary === true');
    expect(agents).toContain("_currentUser.orchestration = { mode: 'single', primaryAgentId: created.id }");
    expect(admin).toContain('data-change-action="adminSetOrchestrationMode"');
    expect(admin).toContain('Single mode activates when the user creates their first assistant.');
  });
});
