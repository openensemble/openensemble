/**
 * Holder for the primary browser/voice WebSocketServer.
 * Shared so delivery helpers and connection setup share one reference.
 */
let _wss = null;

export function getMainWss() {
  return _wss;
}

export function setMainWss(wss) {
  _wss = wss;
  return _wss;
}
