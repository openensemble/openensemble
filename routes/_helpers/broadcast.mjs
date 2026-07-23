/**
 * Broadcast hooks — thin shims whose implementations are injected at startup
 * by server.mjs, so this module stays leaf (no _helpers.mjs dependency).
 */

// broadcastAgentList needs wss — injected at startup via setBroadcastFn
let _broadcastAgentListFn = () => {};
export function setBroadcastFn(fn) { _broadcastAgentListFn = fn; }
export function broadcastAgentList() { _broadcastAgentListFn(); }

// broadcastToUsers — send a WS message to specific user IDs; impl injected at startup
let _broadcastToUsersFn = () => {};
export function setUserBroadcastFn(fn) { _broadcastToUsersFn = fn; }
export function broadcastToUsers(userIds, msg) { _broadcastToUsersFn(userIds, msg); }

// sendToUser — same user scoping as broadcastToUsers, plus chat-revision
// stamping so a live continuation cannot be erased by an older session load.
let _sendToUserFn = () => 0;
export function setUserSendFn(fn) { _sendToUserFn = fn; }
export function sendToUser(userId, msg) { return _sendToUserFn(userId, msg); }
