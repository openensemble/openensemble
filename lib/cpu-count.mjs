/**
 * Effective CPU count for compute-heavy in-process work (GGUF inference etc.).
 *
 * node-llama-cpp reads CPUID directly and defaults to the host's physical core
 * count — which oversubscribes any container/VM with a CPU limit and causes
 * catastrophic thread thrashing (we saw a 400x slowdown in an LXC). This
 * helper resolves the limit through every mechanism we've seen in the wild:
 *
 *   bare metal / VM            — os.availableParallelism() (honors guest kernel)
 *   Proxmox LXC + lxcfs        — /proc/cpuinfo is filtered, os.cpus() works
 *   Docker --cpuset-cpus       — sched_getaffinity mask, honored by os.availableParallelism()
 *   Docker --cpus / K8s limits — CFS quota in /sys/fs/cgroup/cpu.max (v2)
 *                                or cpu.cfs_quota_us (v1); we read + min-cap
 *
 * Always returns >= 1.
 */

import os from 'os';
import fs from 'fs';

function readCgroupQuota() {
  // cgroup v2: "QUOTA PERIOD" (or "max PERIOD" when unlimited).
  try {
    const v2 = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim();
    if (v2 && !v2.startsWith('max')) {
      const [quota, period] = v2.split(/\s+/).map(Number);
      if (quota > 0 && period > 0) return quota / period;
    }
  } catch {}

  // cgroup v1: separate files; quota=-1 means unlimited.
  try {
    const quota = parseInt(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf8'), 10);
    const period = parseInt(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf8'), 10);
    if (quota > 0 && period > 0) return quota / period;
  } catch {}

  return null;
}

export function effectiveCpuCount() {
  // Affinity-aware count. os.availableParallelism() (Node 19+) uses
  // sched_getaffinity; os.cpus().length is the fallback for older runtimes.
  const affinity = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;

  const quota = readCgroupQuota();
  if (quota == null) return Math.max(1, affinity);

  // CFS quota is fractional (e.g. --cpus=1.5). Ceil so a 1.5-cpu allotment
  // uses 2 threads rather than 1 — threads run on 2 physical cores and CFS
  // throttles the cumulative time; better than stranding half a core.
  const quotaCores = Math.max(1, Math.ceil(quota));
  return Math.max(1, Math.min(affinity, quotaCores));
}
