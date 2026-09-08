import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { USERS_DIR } from './paths.mjs';
import { atomicWriteSync, withLock } from '../routes/_helpers/io-lock.mjs';

const RETENTION_MS = 2 * 60 * 60 * 1000;
export const SCHEDULED_ALARM_CAPABILITY = 'scheduled_alarms';

export function scheduledAlarmId(task, deadline) {
  return 'sa_' + createHash('sha256').update(JSON.stringify([
    task.ownerId, task.id, Number(deadline), task.deviceAlarmRevision || 0,
  ])).digest('hex').slice(0, 32);
}

function eligible(task) {
  return !!(task?.ownerId && task.id && (task.voiceTimer || task.alarm));
}

function revision(task) { return Number(task.deviceAlarmRevision) || 0; }

export function scheduledAlarmTargets(task, user, devices) {
  if (!user || user.id !== task.ownerId || user.locked) return [];
  // Profiles store blockedFrom/blockedUntil, not an enabled flag. These
  // accounts require the server's access check at the deadline.
  if (!['owner', 'admin'].includes(user.role)
    && user.accessSchedule?.blockedFrom && user.accessSchedule?.blockedUntil) return [];
  const channel = user.reminderChannel || 'websocket';
  const ids = task.voiceDeviceId ? [task.voiceDeviceId]
    : channel === 'all' ? devices.map(device => device.id)
      : channel === 'voice' && user.reminderVoiceDeviceId ? [user.reminderVoiceDeviceId] : [];
  const owned = new Set(devices.filter(device => device.caps?.includes(SCHEDULED_ALARM_CAPABILITY)).map(device => device.id));
  return [...new Set(ids)].filter(id => owned.has(id));
}

function allowedDay(task, deadline) {
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: task.timezone || undefined, weekday: 'short',
  }).format(new Date(deadline));
  const index = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(day);
  if (task.dow && task.dow !== '*') {
    const days = new Set();
    for (const part of String(task.dow).split(',')) {
      const m = part.trim().match(/^(\d)(?:-(\d))?$/);
      if (!m) return false;
      const start = Number(m[1]), end = Number(m[2] ?? m[1]);
      for (let n = Math.min(start, end); n <= Math.max(start, end); n++) days.add(n % 7);
    }
    return days.has(index);
  }
  return (!task.weekdaysOnly || (index > 0 && index < 6))
    && (!task.weekendsOnly || index === 0 || index === 6);
}

// The injected store lets disconnect/restart tests exercise the real protocol
// without opening sockets, reading profiles, or invoking reminder delivery.
export function createScheduledAlarmManager({ load, save, send, targets, isCurrent = () => true, now = Date.now, lock = withLock }) {
  const transact = (userId, fn) => lock(`scheduled-alarms:${userId}`, async () => {
    const records = (await load(userId)).filter(r => now() < r.deadline + RETENTION_MS);
    const result = await fn(records);
    await save(userId, records);
    return result;
  });
  function push(record, deviceId) {
    if (record.cancelled || record.retiredDeviceIds?.includes(deviceId)) {
      return send(deviceId, { type: 'alarm_disarm', id: record.id });
    }
    if (record.ackedDeviceIds.includes(deviceId) || record.firedDeviceIds.includes(deviceId)) return false;
    // Never resurrect a missed alarm hours later. An already armed offline
    // device owns its deadline; reconnect only reconciles the current window.
    if (now() > record.deadline + 10 * 60 * 1000) return false;
    return send(deviceId, {
      type: 'alarm_arm', id: record.id, label: record.label,
      triggerAtMs: record.deadline,
      delayMs: Math.max(0, record.deadline - now()),
      alarmType: record.type, audioMarker: null,
    });
  }
  return {
    async sync(task, deadlineIso) {
      if (!eligible(task)) return null;
      if (task.enabled === false) return this.cancel(task);
      const deadline = Date.parse(deadlineIso || task.datetime || task.nextRunAt || '');
      if (!Number.isFinite(deadline) || !allowedDay(task, deadline)) return null;
      const deviceIds = [...new Set(await targets(task))];
      return transact(task.ownerId, async records => {
        if (!await isCurrent(task, deadline)) return null;
        const taskRevision = revision(task);
        const barrier = records.find(r => r.taskId === task.id
          && (r.taskRevision || 0) >= taskRevision && r.cancellation);
        if (barrier) return structuredClone(barrier);
        if (records.some(r => r.taskId === task.id && (r.taskRevision || 0) > taskRevision)) return null;
        const id = scheduledAlarmId(task, deadline);
        for (const old of records.filter(r => r.taskId === task.id && r.id !== id && !r.completed && !r.cancellation)) {
          old.cancelled = true;
          await save(task.ownerId, records);
          for (const deviceId of old.deviceIds) push(old, deviceId);
        }
        let record = records.find(r => r.id === id);
        if (!record && !deviceIds.length) return null;
        if (!record) {
          record = { id, taskId: task.id, taskRevision, deadline, label: String(task.label || 'Timer').slice(0, 63),
            type: task.voiceTimer ? 'timer' : 'wallclock', deviceIds,
            armedDeviceIds: [], firedDeviceIds: [], ackedDeviceIds: [], retiredDeviceIds: [],
            cancelled: false, completed: false };
          records.push(record);
        }
        // Cancellation is terminal for an occurrence. A delayed async arm
        // must never recreate a timer removed while scheduling was in flight.
        if (record.cancelled) return { ...record };
        for (const deviceId of record.deviceIds) {
          if (!deviceIds.includes(deviceId) && !record.retiredDeviceIds.includes(deviceId)) record.retiredDeviceIds.push(deviceId);
        }
        record.deviceIds = [...new Set([...record.deviceIds, ...deviceIds])];
        record.label = String(task.label || 'Timer').slice(0, 63);
        await save(task.ownerId, records); // durable intent before device effects
        for (const deviceId of record.deviceIds) push(record, deviceId);
        return structuredClone(record);
      });
    },
    async cancel(task) {
      if (!eligible(task)) return null;
      return transact(task.ownerId, async records => {
        // A task revision tombstone also covers a daily task whose initial
        // nextRunAt write/target lookup has not finished when deletion wins.
        const taskRevision = revision(task);
        const deadline = Date.parse(task.datetime || task.nextRunAt || '');
        const cancellationId = 'sc_' + createHash('sha256').update(JSON.stringify([task.ownerId, task.id, taskRevision])).digest('hex').slice(0, 32);
        if (!records.some(r => r.id === cancellationId)) {
          records.push({ id: cancellationId, taskId: task.id, taskRevision,
            deadline: Math.max(now(), Number.isFinite(deadline) ? deadline : now()), cancellation: true,
            deviceIds: [], armedDeviceIds: [], firedDeviceIds: [], ackedDeviceIds: [], retiredDeviceIds: [], cancelled: true });
        }
        const matches = records.filter(r => r.taskId === task.id && (r.taskRevision || 0) <= taskRevision && !r.completed);
        for (const record of matches) record.cancelled = true;
        await save(task.ownerId, records);
        for (const record of matches) for (const deviceId of record.deviceIds) push(record, deviceId);
      });
    },
    async complete(task) {
      if (!eligible(task)) return;
      return transact(task.ownerId, records => {
        for (const record of records) if (record.taskId === task.id && (record.taskRevision || 0) === revision(task) && !record.cancellation) record.completed = true;
      });
    },
    async receipt(userId, deviceId, message) {
      if (!userId || !deviceId || typeof message?.id !== 'string') return null;
      return transact(userId, records => {
        const record = records.find(r => r.id === message.id && r.deviceIds.includes(deviceId));
        if (!record) return null;
        const field = message.type === 'alarm_armed' && message.ok === true ? 'armedDeviceIds'
          : message.type === 'alarm_fired' ? 'firedDeviceIds'
            : message.type === 'alarm_acked' ? 'ackedDeviceIds' : null;
        if (field && !(field === 'armedDeviceIds' && (record.cancelled || record.retiredDeviceIds?.includes(deviceId)))
          && !record[field].includes(deviceId)) record[field].push(deviceId);
        if (message.type === 'alarm_armed' && message.ok !== true) {
          record.armedDeviceIds = record.armedDeviceIds.filter(id => id !== deviceId);
        }
        return structuredClone(record);
      });
    },
    async reconnect(userId, deviceId) {
      if (!userId || !deviceId) return;
      return transact(userId, records => {
        for (const record of records) if (record.deviceIds.includes(deviceId)) push(record, deviceId);
      });
    },
    async get(task, deadlineIso) {
      if (!eligible(task)) return null;
      const deadline = Date.parse(deadlineIso || task.datetime || task.nextRunAt || '');
      return transact(task.ownerId, records => structuredClone(records.find(r => r.id === scheduledAlarmId(task, deadline)) || null));
    },
  };
}

let manager;
async function productionManager() {
  if (manager) return manager;
  const [{ loadUsers }, { listDevices }, { sendToDevice }, { findTaskById }] = await Promise.all([
    import('../routes/_helpers.mjs'), import('./voice-devices.mjs'),
    import('../ws-handler.mjs'), import('../scheduler.mjs'),
  ]);
  manager ??= createScheduledAlarmManager({
    load(userId) {
      const file = path.join(USERS_DIR, userId, 'scheduled-device-alarms.json');
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    },
    save(userId, records) {
      const file = path.join(USERS_DIR, userId, 'scheduled-device-alarms.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      atomicWriteSync(file, JSON.stringify(records), { mode: 0o600 });
    },
    send(deviceId, message) {
      // Stored records survive firmware changes. Only the current socket's
      // advertisement permits replay of an idempotent scheduled arm.
      return sendToDevice(deviceId, message, message.type === 'alarm_arm'
        ? { requiredCapability: SCHEDULED_ALARM_CAPABILITY } : {});
    },
    isCurrent(task, deadline) {
      const current = findTaskById(task.id, task.ownerId);
      const currentDeadline = current?.repeat === 'once' ? current.datetime : current?.nextRunAt;
      return !!current && current.enabled !== false && revision(current) === revision(task)
        && (!currentDeadline || Date.parse(currentDeadline) === deadline);
    },
    targets(task) {
      const user = loadUsers().find(u => u.id === task.ownerId);
      return scheduledAlarmTargets(task, user, listDevices(task.ownerId));
    },
  });
  return manager;
}

export async function syncScheduledDeviceAlarm(task, deadlineIso) {
  if (!eligible(task)) return null;
  return (await productionManager()).sync(task, deadlineIso);
}
export async function cancelScheduledDeviceAlarm(task) {
  if (!eligible(task)) return null;
  return (await productionManager()).cancel(task);
}
export async function completeScheduledDeviceAlarm(task) {
  if (!eligible(task)) return;
  return (await productionManager()).complete(task);
}
export async function getScheduledDeviceAlarm(task, deadlineIso) {
  if (!eligible(task)) return null;
  return (await productionManager()).get(task, deadlineIso);
}
export async function waitForScheduledDeviceAlarm(task, timeoutMs = 1000) {
  const end = Date.now() + timeoutMs;
  let record;
  do {
    record = await getScheduledDeviceAlarm(task);
    if (!record || record.cancelled || record.deviceIds.every(id => record.armedDeviceIds.includes(id))) return record;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < end);
  return record;
}
export async function recordScheduledAlarmReceipt(userId, deviceId, message) {
  return (await productionManager()).receipt(userId, deviceId, message);
}
export async function reconcileScheduledDeviceAlarms(userId, deviceId) {
  return (await productionManager()).reconnect(userId, deviceId);
}
