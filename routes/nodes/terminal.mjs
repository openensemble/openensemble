/**
 * Browser terminal for node agents.
 *
 * Two surfaces:
 *  - GET /nodes/terminal?nodeId=…&ticket=… — HTML popup with xterm.js
 *  - WS  /ws/nodes/terminal?nodeId=…&ticket=… — PTY bridge to the node
 *
 * Tickets are single-use, scope-gated, 60-second TTL. The UI mints a page
 * ticket via POST /api/nodes/terminal-ticket, then window.open()s the popup.
 * The GET handler consumes that ticket and mints a fresh ws-scoped ticket
 * into the HTML for the WebSocket upgrade.
 *
 * The HTML page opens the WS and streams bytes both ways, with `resize` and
 * `exit` control messages framed as JSON.
 */

import { WebSocketServer } from 'ws';
import { randomBytes } from 'crypto';
import {
  getNode, sendPtyMessage, registerPtyCallback, unregisterPtyCallback,
} from '../../skills/nodes/node-registry.mjs';
import { consumeTicket, createTicket, getUser, requireAuth, readBody } from '../_helpers.mjs';

function escHtmlAttr(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let _termWss = null;

export function initTerminalWss() {
  _termWss = new WebSocketServer({ noServer: true });

  _termWss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://x');
    const ticket = url.searchParams.get('ticket');
    const nodeId = url.searchParams.get('nodeId');
    const consumed = consumeTicket(ticket, 'terminal-ws');
    const userId = consumed?.userId ?? null;

    if (!userId) { ws.close(4001, 'Unauthorized'); return; }
    if (!nodeId) { ws.close(4002, 'Missing nodeId'); return; }
    // The ticket is bound to a specific node at mint time — reject mismatches.
    if (consumed.meta?.nodeId && consumed.meta.nodeId !== nodeId) { ws.close(4004, 'Ticket node mismatch'); return; }

    // Child accounts cannot open a shell on any node, period.
    if (getUser(userId)?.role === 'child') { ws.close(4005, 'Not permitted'); return; }

    // Verify node ownership
    const node = getNode(nodeId, userId);
    if (!node) { ws.close(4003, 'Node not found'); return; }

    // Generate a unique PTY id
    const ptyId = `pty_${Date.now()}_${randomBytes(3).toString('hex')}`;
    ws._ptyId = ptyId;
    ws._nodeId = nodeId;
    ws._userId = userId;

    // Register callback to relay PTY output from node agent → browser
    registerPtyCallback(ptyId, (msg) => {
      if (ws.readyState !== ws.OPEN) return;
      if (msg.type === 'pty_output') {
        ws.send(msg.data); // send raw terminal data to xterm.js
      } else if (msg.type === 'pty_exit') {
        ws.send(JSON.stringify({ type: 'exit', exitCode: msg.exitCode }));
        ws.close(1000, 'PTY exited');
      } else if (msg.type === 'pty_started') {
        ws.send(JSON.stringify({ type: 'ready' }));
      } else if (msg.type === 'pty_error') {
        ws.send(JSON.stringify({ type: 'error', message: msg.message }));
        ws.close(1011, msg.message);
      }
    });

    // Wait for browser to send initial size, then start PTY
    let ptyStarted = false;

    ws.on('message', (raw) => {
      const data = raw.toString();

      // Try to parse as JSON (control messages)
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'resize') {
          if (!ptyStarted) {
            // First resize = start PTY with initial size
            ptyStarted = true;
            sendPtyMessage(nodeId, userId, {
              type: 'pty_start', ptyId,
              cols: msg.cols || 80, rows: msg.rows || 24,
            });
          } else {
            sendPtyMessage(nodeId, userId, {
              type: 'pty_resize', ptyId,
              cols: msg.cols, rows: msg.rows,
            });
          }
          return;
        }
      } catch {}

      // Plain text = terminal input
      if (ptyStarted) {
        sendPtyMessage(nodeId, userId, { type: 'pty_input', ptyId, data });
      }
    });

    ws.on('close', () => {
      unregisterPtyCallback(ptyId);
      sendPtyMessage(nodeId, userId, { type: 'pty_kill', ptyId });
    });

    ws.on('error', () => {
      unregisterPtyCallback(ptyId);
      sendPtyMessage(nodeId, userId, { type: 'pty_kill', ptyId });
    });
  });

  return _termWss;
}

export function getTerminalWss() { return _termWss; }

/**
 * POST /api/nodes/terminal-ticket — mint a single-use page ticket.
 *
 * The UI calls this with the user's session token in the Authorization header
 * (normal auth), gets back a short-lived ticket, and passes the ticket in the
 * popup URL instead of the session token itself. Returns true if handled.
 */
export async function handleTerminalTicket(req, res) {
  const userId = requireAuth(req, res);
  if (!userId) return true;
  let body;
  try { body = JSON.parse(await readBody(req) || '{}'); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return true;
  }
  const nodeId = body.nodeId;
  if (!nodeId) { res.writeHead(400); res.end(JSON.stringify({ error: 'nodeId required' })); return true; }
  if (getUser(userId)?.role === 'child') { res.writeHead(403); res.end(JSON.stringify({ error: 'Not permitted' })); return true; }
  if (!getNode(nodeId, userId)) { res.writeHead(404); res.end(JSON.stringify({ error: 'Node not found' })); return true; }
  const { token, expiresIn } = createTicket(userId, 'terminal-page', { nodeId });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ticket: token, expiresIn }));
  return true;
}

/**
 * Serve the /nodes/terminal HTML popup page. Returns true if handled.
 *
 * Auth note: window.open() cannot set an Authorization header, so a single-use
 * ticket travels in the URL instead. The GET consumes the page-scoped ticket,
 * then mints a ws-scoped ticket and embeds it in the HTML for the WebSocket
 * upgrade. Both tickets are single-use, scope-gated, and expire in 60 seconds.
 */
export function handleTerminalPage(req, res, url) {
  const ticket = url.searchParams.get('ticket') || '';
  const consumed = consumeTicket(ticket, 'terminal-page');
  const userId = consumed?.userId ?? null;
  if (!userId) { res.writeHead(401); res.end('Unauthorized'); return true; }
  if (getUser(userId)?.role === 'child') { res.writeHead(403); res.end('Not permitted'); return true; }
  const nodeId = url.searchParams.get('nodeId');
  if (!nodeId) { res.writeHead(400); res.end('Missing nodeId'); return true; }
  if (consumed.meta?.nodeId && consumed.meta.nodeId !== nodeId) { res.writeHead(403); res.end('Ticket node mismatch'); return true; }
  const node = getNode(nodeId, userId);
  if (!node) { res.writeHead(404); res.end('Node not found'); return true; }
  const autoCmd = url.searchParams.get('cmd') || '';
  const { token: wsTicket } = createTicket(userId, 'terminal-ws', { nodeId });
  const html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<title>${escHtmlAttr(node.hostname)} — Terminal</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#0d1117; display:flex; flex-direction:column; height:100vh; overflow:hidden; }
  #header { background:#161b22; padding:8px 14px; border-bottom:1px solid #30363d; display:flex; align-items:center; gap:10px; flex-shrink:0; }
  #header .host { font-weight:700; color:#58a6ff; font-family:'SF Mono','Cascadia Code','Consolas',monospace; font-size:13px; }
  #header .info { font-size:11px; color:#8b949e; font-family:sans-serif; }
  #header .dot { width:8px; height:8px; border-radius:50%; display:inline-block; }
  #header .dot.on { background:#3fb950; }
  #header .dot.off { background:#f85149; }
  #terminal { flex:1; }
  #status { background:#161b22; padding:4px 14px; border-top:1px solid #30363d; font-size:11px; color:#8b949e; font-family:sans-serif; flex-shrink:0; }
</style>
</head><body>
<div id="header">
  <span class="dot on" id="statusDot"></span>
  <span class="host">${escHtmlAttr(node.hostname)}</span>
  <span class="info">${escHtmlAttr(node.distro)} &middot; ${escHtmlAttr(node.arch)} ${node.ip ? '&middot; ' + escHtmlAttr(node.ip) : ''}</span>
</div>
<div id="terminal"></div>
<div id="status" id="statusBar">Connecting...</div>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0.11.0/lib/addon-web-links.min.js"></script>
<script>
const nodeId = ${JSON.stringify(nodeId)};
const wsTicket = ${JSON.stringify(wsTicket)};
const autoCmd = ${JSON.stringify(autoCmd)};
const statusBar = document.getElementById('status');
const statusDot = document.getElementById('statusDot');

const term = new Terminal({
  cursorBlink: true,
  fontSize: 13,
  fontFamily: "'SF Mono', 'Cascadia Code', 'Consolas', 'Liberation Mono', monospace",
  theme: {
    background: '#0d1117',
    foreground: '#c9d1d9',
    cursor: '#58a6ff',
    selectionBackground: '#264f78',
    black:   '#484f58', red:     '#ff7b72', green:   '#3fb950', yellow:  '#d29922',
    blue:    '#58a6ff', magenta: '#bc8cff', cyan:    '#39c5cf', white:   '#b1bac4',
    brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341',
    brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
  },
  allowProposedApi: true,
});

const fitAddon = new FitAddon.FitAddon();
const webLinksAddon = new WebLinksAddon.WebLinksAddon();
term.loadAddon(fitAddon);
term.loadAddon(webLinksAddon);
term.open(document.getElementById('terminal'));
fitAddon.fit();

// Connect WebSocket
const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = wsProto + '//' + location.host + '/ws/nodes/terminal?nodeId=' + encodeURIComponent(nodeId) + '&ticket=' + encodeURIComponent(wsTicket);
const ws = new WebSocket(wsUrl);

ws.onopen = () => {
  statusBar.textContent = 'Connected — starting shell...';
  // Send initial terminal size to trigger PTY creation
  ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
};

ws.onmessage = (evt) => {
  // Try JSON control messages first
  try {
    const msg = JSON.parse(evt.data);
    if (msg.type === 'ready') {
      statusBar.textContent = 'Connected';
      statusDot.className = 'dot on';
      // Auto-run command if specified
      if (autoCmd) {
        setTimeout(() => ws.send(autoCmd + '\\n'), 300);
      }
      return;
    }
    if (msg.type === 'exit') {
      statusBar.textContent = 'Shell exited (code ' + msg.exitCode + ')';
      statusDot.className = 'dot off';
      term.write('\\r\\n\\x1b[90m[Shell exited with code ' + msg.exitCode + ']\\x1b[0m\\r\\n');
      return;
    }
    if (msg.type === 'error') {
      statusBar.textContent = 'Error: ' + msg.message;
      statusDot.className = 'dot off';
      return;
    }
  } catch {}
  // Raw terminal data
  term.write(evt.data);
};

ws.onclose = () => {
  statusBar.textContent = 'Disconnected';
  statusDot.className = 'dot off';
  term.write('\\r\\n\\x1b[90m[Connection closed]\\x1b[0m\\r\\n');
};

ws.onerror = () => {
  statusBar.textContent = 'Connection error';
  statusDot.className = 'dot off';
};

// Terminal input → WebSocket
term.onData((data) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(data);
});

// Handle window resize
window.addEventListener('resize', () => {
  fitAddon.fit();
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  }
});

// Expose WS for parent window command injection
window._oeWs = ws;
term.focus();
</script>
</body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
  return true;
}
