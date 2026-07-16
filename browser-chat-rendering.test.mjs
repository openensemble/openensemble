import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';

const chatSource = fs.readFileSync(new URL('./public/chat.js', import.meta.url), 'utf8');
const renderStart = chatSource.indexOf('function renderSessionInner(keepScroll) {');
const renderEnd = chatSource.indexOf('\nfunction orderSessionForRender(', renderStart);
const notificationStart = chatSource.indexOf('function appendNotification(msg) {');
const notificationEnd = chatSource.indexOf('\n// Render a direct report card', notificationStart);

if (renderStart < 0 || renderEnd < 0 || notificationStart < 0 || notificationEnd < 0) {
  throw new Error('Unable to locate browser rendering functions in public/chat.js');
}

const renderSessionInnerSource = chatSource.slice(renderStart, renderEnd);
const appendNotificationSource = chatSource.slice(notificationStart, notificationEnd);

function makeRenderer(rows, historyWindow = 150) {
  const appendUserBubble = vi.fn();
  const appendAssistantBubble = vi.fn();
  const renderDocumentSessionRequest = vi.fn(() => ({ hideAssistant: true }));
  const insertBefore = vi.fn();
  const scrollToBottom = vi.fn();
  const messagesElement = { children: [], scrollHeight: 0, scrollTop: 0 };
  const document = {
    createElement: vi.fn(() => ({ style: {}, addEventListener: vi.fn() })),
  };

  const factory = new Function('deps', [
    'let _historyWindow = deps.historyWindow;',
    "const activeAgent = 'primary';",
    'const sessions = { primary: deps.rows };',
    "const $ = () => deps.messagesElement;",
    'const orderSessionForRender = messages => messages;',
    'const insertBefore = deps.insertBefore;',
    'const document = deps.document;',
    'const renderDocumentSessionRequest = deps.renderDocumentSessionRequest;',
    'const documentOutcomeFromAssistant = () => null;',
    'const appendUserBubble = deps.appendUserBubble;',
    'const appendAssistantBubble = deps.appendAssistantBubble;',
    'const _legacyAgentReportMatch = () => null;',
    'const scrollToBottom = deps.scrollToBottom;',
    renderSessionInnerSource,
    'return renderSessionInner;',
  ].join('\n'));

  return {
    render: factory({
      historyWindow,
      rows,
      messagesElement,
      insertBefore,
      document,
      renderDocumentSessionRequest,
      appendUserBubble,
      appendAssistantBubble,
      scrollToBottom,
    }),
    appendUserBubble,
    appendAssistantBubble,
    renderDocumentSessionRequest,
    insertBefore,
  };
}

describe('browser chat session visibility', () => {
  it('removes hidden rows before calculating the history window', () => {
    const rows = [
      { role: 'user', content: 'visible user' },
      { role: 'assistant', content: 'visible assistant' },
      ...Array.from({ length: 5 }, (_, i) => ({
        role: 'assistant', content: `private ${i}`, hidden: true,
      })),
    ];
    const renderer = makeRenderer(rows, 2);

    renderer.render(false);

    expect(renderer.insertBefore).not.toHaveBeenCalled();
    expect(renderer.appendUserBubble).toHaveBeenCalledWith(
      'visible user', undefined, false, null,
    );
    expect(renderer.appendAssistantBubble).toHaveBeenCalledWith(
      'visible assistant', undefined, false,
    );
  });

  it('removes hidden assistants before document request pairing', () => {
    const visibleAssistant = { role: 'assistant', content: 'visible result' };
    const hiddenAssistant = {
      role: 'assistant',
      content: 'private worker result',
      documentRequestId: 'request-1',
      hidden: true,
    };
    const rows = [
      {
        role: 'user',
        content: 'make the document',
        documentRequest: { requestId: 'request-1' },
      },
      visibleAssistant,
      hiddenAssistant,
    ];
    const renderer = makeRenderer(rows);

    renderer.render(false);

    expect(renderer.renderDocumentSessionRequest).toHaveBeenCalledTimes(1);
    expect(renderer.renderDocumentSessionRequest.mock.calls[0][1]).toBe(visibleAssistant);
  });
});

describe('browser watcher notification routing', () => {
  it('renders a scoped notification inline for the raw active agent', () => {
    const insertBefore = vi.fn();
    const scrollToBottom = vi.fn();
    const showToast = vi.fn();
    const element = { className: '', innerHTML: '' };
    const factory = new Function('deps', [
      "const activeAgent = 'primary';",
      "const agents = [{ id: 'primary', name: 'Primary' }];",
      "const clientSessionAgentId = agent => agent === 'user_fixture_primary' ? 'primary' : agent;",
      "const document = { createElement: () => deps.element };",
      "const icon = () => 'icon';",
      'const escHtml = value => String(value);',
      'const insertBefore = deps.insertBefore;',
      'const scrollToBottom = deps.scrollToBottom;',
      'const showToast = deps.showToast;',
      appendNotificationSource,
      'return appendNotification;',
    ].join('\n'));
    const appendNotification = factory({ element, insertBefore, scrollToBottom, showToast });

    appendNotification({
      agent: 'user_fixture_primary',
      content: 'watch fired',
      from: { userName: 'Monitor' },
      ts: Date.now(),
    });

    expect(insertBefore).toHaveBeenCalledWith(element);
    expect(scrollToBottom).toHaveBeenCalledOnce();
    expect(showToast).not.toHaveBeenCalled();
  });
});
