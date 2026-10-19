import { parentPort, workerData } from 'node:worker_threads';
import { buildBackupSnapshot } from './backup-state.mjs';

try {
  const data = buildBackupSnapshot(workerData.base, workerData.workspace);
  parentPort.postMessage({ data });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
