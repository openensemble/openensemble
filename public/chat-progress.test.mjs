import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { projectActiveTasksForWire } from '../lib/background-task-wire.mjs';

const indexSource = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const cssSource = fs.readFileSync(new URL('./css/04-chat.css', import.meta.url), 'utf8');
const websocketSource = fs.readFileSync(new URL('./websocket.js', import.meta.url), 'utf8');
const wsHandlerSource = fs.readFileSync(new URL('../ws-handler.mjs', import.meta.url), 'utf8');

function loadBrowserProgressReducer() {
  const sandbox = {
    console,
    document: { addEventListener() {} },
    window: { addEventListener() {} },
    sessions: { jarvis: [] },
    activeAgent: 'jarvis',
    agents: [{ id: 'jarvis', name: 'Jarvis' }],
    _currentUser: { id: 'user-1' },
  };
  vm.createContext(sandbox);
  vm.runInContext(websocketSource, sandbox, { filename: 'public/websocket.js' });
  return sandbox;
}

describe('chat progress feedback', () => {
  it('shows explicit, accessible waiting text instead of an unexplained ellipsis', () => {
    expect(indexSource).toMatch(
      /<div class="typing" id="typing" role="status" aria-live="polite" aria-label="Working on it">/,
    );
    expect(indexSource).toContain('<span class="typing-label">Working on it</span>');
    expect(indexSource.match(/class="typing-dot"/g)).toHaveLength(3);
    expect(cssSource).toContain('.typing-label');
    expect(cssSource).toContain('.typing-dot {');
    expect(cssSource).not.toMatch(/\.typing span \{/);
  });

  it('projects a cancellable task into a small user-facing reconnect snapshot', () => {
    const [snapshot] = projectActiveTasksForWire([{
      taskId: 'task-1',
      watcherId: 'watcher-1',
      rootWatcherId: 'watcher-1',
      rootTaskId: 'task-1',
      userId: 'user-1',
      visibleAgentId: 'user-1_jarvis',
      agentId: 'researcher',
      agentName: 'Researcher',
      agentEmoji: '🔎',
      summary: 'Check several sources and prepare a concise answer.',
      status: 'running',
      phase: 'tool',
      currentTool: 'web_search',
      toolsUsed: 2,
      startedAt: 1_000,
      lastActivityAt: 2_000,
      abort() {},
      originalTask: 'private full prompt',
      verifierLeaseToken: 'secret-verifier-lease',
      verifierAllowedTools: ['private_tool'],
      parentTurnContext: { private: true },
    }]);

    expect(snapshot).toMatchObject({
      taskId: 'task-1',
      watcherId: 'watcher-1',
      kind: 'task_proxy',
      visibleAgentId: 'user-1_jarvis',
      canCancel: true,
      text: 'Researcher is working on it with web_search…',
      state: {
        rootWatcherId: 'watcher-1',
        currentTool: 'web_search',
        canCancel: true,
      },
    });
    const json = JSON.stringify(snapshot);
    expect(json).not.toContain('private full prompt');
    expect(json).not.toContain('secret-verifier-lease');
    expect(json).not.toContain('private_tool');
    expect(json).not.toContain('parentTurnContext');
    expect(json).not.toContain('"userId"');
  });

  it('folds nested work into one root progress card on reconnect', () => {
    const snapshots = projectActiveTasksForWire([
      {
        taskId: 'root-task', watcherId: 'root-watcher', rootWatcherId: 'root-watcher',
        rootTaskId: 'root-task', visibleAgentId: 'user-1_jarvis', agentId: 'jarvis',
        agentName: 'Jarvis', summary: 'Build the report', status: 'running',
        phase: 'running', startedAt: 1_000, abort() {},
      },
      {
        taskId: 'child-task', watcherId: 'child-watcher', rootWatcherId: 'root-watcher',
        rootTaskId: 'root-task', visibleAgentId: 'user-1_jarvis', agentId: 'researcher',
        agentName: 'Researcher', summary: 'Gather evidence', status: 'running',
        phase: 'tool', currentTool: 'web_search', startedAt: 1_100, abort() {},
      },
    ]);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      watcherId: 'root-watcher',
      canCancel: true,
      text: 'Working on it — 2 background tasks are still running.',
      state: {
        rootWatcherId: 'root-watcher',
        childTasks: [{
          taskId: 'child-task', name: 'Researcher', currentTool: 'web_search',
        }],
      },
    });
  });

  it('does not offer a broken root Stop action when only nested children remain', () => {
    const [snapshot] = projectActiveTasksForWire([{
      taskId: 'child-task', watcherId: 'child-watcher', rootWatcherId: 'root-watcher',
      rootTaskId: 'root-task', visibleAgentId: 'user-1_jarvis', agentId: 'researcher',
      agentName: 'Researcher', summary: 'Gather evidence', status: 'running',
      phase: 'tool', currentTool: 'web_search', startedAt: 1_100, abort() {},
    }]);

    expect(snapshot.watcherId).toBe('root-watcher');
    expect(snapshot.canCancel).toBe(false);
    expect(snapshot.state.canCancel).toBe(false);
  });

  it('restores and later clears the running task row in browser session state', () => {
    const browser = loadBrowserProgressReducer();
    const [snapshot] = projectActiveTasksForWire([{
      taskId: 'task-1', watcherId: 'watcher-1', rootWatcherId: 'watcher-1',
      visibleAgentId: 'user-1_jarvis', agentId: 'researcher', agentName: 'Researcher',
      summary: 'Gather evidence', status: 'running', phase: 'running',
      startedAt: 1_000, lastActivityAt: 2_000, abort() {},
    }]);

    expect(browser.reconcileActiveBackgroundTasks([snapshot])).toBe(true);
    expect(browser.sessions.jarvis).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(browser.sessions.jarvis[0]))).toMatchObject({
      role: 'status',
      _activeTaskSnapshot: true,
      status: {
        kind: 'task_proxy', watcherId: 'watcher-1',
        text: 'Researcher is working on it…',
        state: { canCancel: true },
      },
    });

    expect(browser.reconcileActiveBackgroundTasks([])).toBe(true);
    expect(browser.sessions.jarvis).toEqual([]);
  });

  it('accepts the legacy active-task shape during a rolling server restart', () => {
    const browser = loadBrowserProgressReducer();
    expect(browser.reconcileActiveBackgroundTasks([{
      taskId: 'legacy-task', watcherId: 'legacy-watcher',
      visibleAgentId: 'user-1_jarvis', agentId: 'researcher', agentName: 'Researcher',
      summary: 'Legacy in-flight task', status: 'running', phase: 'tool',
      currentTool: 'web_search', startedAt: 1_000,
    }])).toBe(true);

    expect(JSON.parse(JSON.stringify(browser.sessions.jarvis[0]?.status))).toMatchObject({
      kind: 'task_proxy',
      watcherId: 'legacy-watcher',
      text: 'Researcher is working on it…',
      state: {
        targetAgentName: 'Researcher',
        currentTool: 'web_search',
        canCancel: false,
      },
    });
  });

  it('wires sanitized snapshots into the reconnect renderer', () => {
    expect(wsHandlerSource).toContain('projectActiveTasksForWire(');
    expect(websocketSource).toContain('function reconcileActiveBackgroundTasks(tasks)');
    expect(websocketSource).toContain('reconcileActiveBackgroundTasks(msg.tasks)');
    expect(websocketSource).toContain('_activeTaskSnapshot: true');
  });
});

