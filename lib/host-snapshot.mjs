/**
 * Host-level snapshot wrapper — sledgehammer rollback for high-risk ops on
 * services that live in a Proxmox container/VM (or, future, a ZFS dataset).
 *
 * Why it exists:
 *   The per-mechanism snapshots (http/cli/config_file) capture only what we
 *   know we changed. A host snapshot captures the entire guest state. If
 *   something we didn't track gets corrupted (database mid-write, kernel
 *   panic, package manager left half-installed), the surgical rollback
 *   can't fix it but the host snapshot can.
 *
 * Trigger:
 *   The op-dispatcher takes a host snapshot BEFORE the inner mechanism runs
 *   when:  effective_risk === 'high' && input.parent_host is provided.
 *   Failure to capture is logged but doesn't abort — the inner snapshot still
 *   provides surgical rollback.
 *
 * Restore:
 *   `rollbackOperationHostLevel()` (in lib/rollback.mjs) reads
 *   record.pre_state.host_snapshot and calls into the matching driver.
 *   Surgical and host-level rollback are independent paths — caller chooses.
 *
 * parent_host shape:
 *   {
 *     type: 'proxmox',
 *     api_url: 'https://pve01.local:8006',
 *     api_token: 'PVEAPIToken=root@pam!oe-tok=<uuid>',  // OR a token-storage ref
 *     node: 'pve01', vmid: 102, kind: 'lxc' | 'qemu'
 *   }
 *   Future: { type: 'zfs', host: 'truenas.local', dataset: 'tank/services/x', ... }
 *
 * Snapshot naming: we want short, sortable, no special chars (Proxmox allows
 * `^[A-Za-z0-9_-]+$` and caps name at 40 chars).
 *   op_2026-05-07T04-02-00-000Z_abcdef → oe_20260507_040200_abcdef (24 chars)
 */

import * as proxmox from './proxmox-api.mjs';

export function snapshotNameFromOpId(opId) {
  const s = String(opId);
  const m = s.match(/^op_(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2}).*?_([0-9a-f]+)$/i);
  if (m) return `oe_${m[1]}${m[2]}${m[3]}_${m[4]}${m[5]}${m[6]}_${m[7]}`;
  return `oe_${s.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 30) || 'unknown'}`;
}

function proxmoxOpts(parent_host, ctx = {}) {
  return {
    api_url:   parent_host.api_url,
    api_token: ctx.proxmox_token ?? parent_host.api_token,
    node:      parent_host.node,
    vmid:      parent_host.vmid,
    kind:      parent_host.kind,
    // vmstate flows through for qemu VMs. Default false (disk-only) — the
    // user opts in for VMs whose in-flight state matters (Home Assistant,
    // MQTT brokers, anything with mid-execution radio/network state).
    // Memory snapshots are noticeably slower + bigger than disk-only, so
    // we don't default-on even for qemu.
    vmstate:   parent_host.vmstate ?? false,
    fetchFn:   ctx.fetchFn,
    waitForCompletion: parent_host.waitForCompletion ?? true,
  };
}

/**
 * Take a host-level snapshot before a high-risk op runs.
 *
 * @returns {Promise<object>} `host_snapshot` field shape:
 *   { type, api_url, node, vmid, kind, snapname, captured_at, upid }
 */
export async function captureHostSnapshot(parent_host, opId, ctx = {}) {
  if (!parent_host?.type) throw new Error('parent_host.type required');

  if (parent_host.type === 'proxmox') {
    const opts = proxmoxOpts(parent_host, ctx);
    const snapname = snapshotNameFromOpId(opId);
    const result = await proxmox.createSnapshot(opts, snapname,
      `OE pre-op snapshot for ${opId}`);
    return {
      type:        'proxmox',
      api_url:     parent_host.api_url,
      node:        parent_host.node,
      vmid:        parent_host.vmid,
      kind:        parent_host.kind,
      snapname:    result.snapname,
      upid:        result.upid,
      captured_at: new Date().toISOString(),
    };
  }

  if (parent_host.type === 'zfs') {
    if (!ctx.execFn) throw new Error('zfs parent_host requires ctx.execFn (typically an SSH wrapper to ssh_host)');
    const snapname = snapshotNameFromOpId(opId);
    // Tag = dataset@snapname. ZFS allows up to 256 chars for the snap name part.
    const tag = `${parent_host.dataset}@${snapname}`;
    const r = await ctx.execFn(`zfs snapshot ${tag}`);
    if (r.exitCode !== 0) {
      throw new Error(`zfs snapshot ${tag} failed: ${(r.stderr || '').slice(0, 200)}`);
    }
    return {
      type:        'zfs',
      ssh_host:    parent_host.ssh_host,
      dataset:     parent_host.dataset,
      snapname,
      tag,
      captured_at: new Date().toISOString(),
    };
  }

  if (parent_host.type === 'btrfs') {
    if (!ctx.execFn) throw new Error('btrfs parent_host requires ctx.execFn (the node\'s own shell)');
    const snapname = snapshotNameFromOpId(opId);
    const dir = String(parent_host.snapshot_dir).replace(/\/+$/, '');
    const snapPath = `${dir}/${snapname}`;
    // -r = read-only snapshot (immutable). The snapshot_dir must already
    // exist as a btrfs subvolume on the same filesystem as `subvolume`.
    const r = await ctx.execFn(`btrfs subvolume snapshot -r ${parent_host.subvolume} ${snapPath}`);
    if (r.exitCode !== 0) {
      throw new Error(`btrfs snapshot ${parent_host.subvolume} → ${snapPath} failed: ${(r.stderr || '').slice(0, 200)}`);
    }
    return {
      type:          'btrfs',
      subvolume:     parent_host.subvolume,
      snapshot_dir:  dir,
      snapshot_path: snapPath,
      snapname,
      captured_at:   new Date().toISOString(),
    };
  }

  throw new Error(`unsupported parent_host.type: ${parent_host.type}`);
}

/**
 * Roll back to a previously-captured host snapshot.
 * @param {object} parent_host  Current parent_host config (api_url + token + node)
 * @param {object} hostSnapshot The saved record.pre_state.host_snapshot
 * @returns {Promise<{outcome, message}>}
 */
export async function rollbackToHostSnapshot(parent_host, hostSnapshot, ctx = {}) {
  if (!hostSnapshot?.type) return { outcome: 'failure', message: 'host_snapshot.type missing' };
  if (!hostSnapshot.snapname) return { outcome: 'failure', message: 'host_snapshot.snapname missing' };

  if (hostSnapshot.type === 'proxmox') {
    // Use parent_host for current api_url + token (fresh) but the snapshot's
    // own vmid/kind/node for *which* guest to roll back. They normally match
    // but the snapshot record is the authoritative target.
    const opts = proxmoxOpts({
      ...parent_host,
      node: hostSnapshot.node,
      vmid: hostSnapshot.vmid,
      kind: hostSnapshot.kind,
    }, ctx);
    try {
      await proxmox.rollbackSnapshot(opts, hostSnapshot.snapname);
      return {
        outcome: 'success',
        message: `rolled back ${hostSnapshot.kind}/${hostSnapshot.vmid} to snapshot "${hostSnapshot.snapname}"`,
      };
    } catch (e) {
      return { outcome: 'failure', message: e.message };
    }
  }
  if (hostSnapshot.type === 'zfs') {
    if (!ctx.execFn) return { outcome: 'failure', message: 'zfs rollback requires ctx.execFn' };
    const tag = hostSnapshot.tag || `${hostSnapshot.dataset}@${hostSnapshot.snapname}`;
    // -r recursive (in case of child datasets); -R also destroys later snapshots
    // which is what we want for "go back in time" semantics.
    const r = await ctx.execFn(`zfs rollback -r ${tag}`);
    if (r.exitCode !== 0) {
      return { outcome: 'failure', message: `zfs rollback ${tag} failed: ${(r.stderr || '').slice(0, 200)}` };
    }
    return {
      outcome: 'success',
      message: `rolled back zfs dataset ${hostSnapshot.dataset} to snapshot "${hostSnapshot.snapname}"`,
    };
  }

  if (hostSnapshot.type === 'btrfs') {
    // Btrfs rollback is non-trivial: deleting + replacing a live subvolume
    // requires it to be unmounted, and root subvolumes need a default-subvol
    // change + reboot. OE will not perform this automatically — the snapshot
    // is preserved as documentation of pre-op state and the user can restore
    // manually with the included recipe.
    return {
      outcome: 'failure',
      message:
        `btrfs auto-rollback is not safe to perform without human intervention. ` +
        `Snapshot exists read-only at ${hostSnapshot.snapshot_path}. ` +
        `Manual recovery on the node (idle/unmounted subvolumes only): ` +
        `\`btrfs subvolume delete ${hostSnapshot.subvolume} && btrfs subvolume snapshot ${hostSnapshot.snapshot_path} ${hostSnapshot.subvolume}\`. ` +
        `For root subvolume restore: change default subvolume + reboot.`,
    };
  }

  return { outcome: 'failure', message: `unsupported host_snapshot.type: ${hostSnapshot.type}` };
}

/**
 * Delete a host snapshot (used by the pruner to clean up old PVE/ZFS snaps
 * when the corresponding op record's local snapshot ages out).
 */
export async function deleteHostSnapshot(parent_host, hostSnapshot, ctx = {}) {
  if (hostSnapshot?.type === 'proxmox') {
    const opts = proxmoxOpts({
      ...parent_host,
      node: hostSnapshot.node,
      vmid: hostSnapshot.vmid,
      kind: hostSnapshot.kind,
    }, ctx);
    try {
      await proxmox.deleteSnapshot(opts, hostSnapshot.snapname);
      return { deleted: true };
    } catch (e) {
      return { deleted: false, reason: e.message };
    }
  }
  if (hostSnapshot?.type === 'zfs') {
    if (!ctx.execFn) return { deleted: false, reason: 'zfs delete requires ctx.execFn' };
    const tag = hostSnapshot.tag || `${hostSnapshot.dataset}@${hostSnapshot.snapname}`;
    const r = await ctx.execFn(`zfs destroy ${tag}`);
    return r.exitCode === 0 ? { deleted: true } : { deleted: false, reason: r.stderr };
  }
  if (hostSnapshot?.type === 'btrfs') {
    if (!ctx.execFn) return { deleted: false, reason: 'btrfs delete requires ctx.execFn' };
    const r = await ctx.execFn(`btrfs subvolume delete ${hostSnapshot.snapshot_path}`);
    return r.exitCode === 0 ? { deleted: true } : { deleted: false, reason: r.stderr };
  }
  return { deleted: false, reason: `unsupported type: ${hostSnapshot?.type}` };
}
