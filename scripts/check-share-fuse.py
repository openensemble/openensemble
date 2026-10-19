#!/usr/bin/env python3
"""Check FUSE as the OE service user, including a bounded, local mount probe."""
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time


def container_kind():
    for filename, kind in [('/.dockerenv', 'docker'), ('/run/.containerenv', 'podman')]:
        if Path(filename).exists():
            return kind
    try:
        value = Path('/run/systemd/container').read_text().strip()
        if value:
            return value
    except OSError:
        pass
    try:
        result = subprocess.run(['systemd-detect-virt', '--container'], capture_output=True, text=True, timeout=3)
        if result.returncode == 0:
            return result.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        pass
    return None


def mounted(target):
    # mkdtemp names contain no mountinfo escapes.
    return any(line.split(' ')[4] == str(target)
               for line in Path('/proc/self/mountinfo').read_text().splitlines())


def probe(rclone, helper):
    root = Path(tempfile.mkdtemp(prefix='oe-fuse-check-'))
    source, target = root / 'source', root / 'mount'
    source.mkdir(mode=0o700)
    target.mkdir(mode=0o700)
    marker = source / 'ready'
    marker.write_text('oe-fuse-ready\n')
    child = None
    success = False
    cleaned = False
    try:
        # No remote server, credentials, user data, or recursive cleanup.
        child = subprocess.Popen([rclone, 'mount', str(source), str(target),
                                  '--config', '/dev/null', '--read-only', '--log-level', 'ERROR',
                                  '--umask', '077', '--vfs-cache-mode', 'off'],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 start_new_session=True)
        deadline = time.monotonic() + 8
        while child.poll() is None and time.monotonic() < deadline:
            if mounted(target):
                # Bound reads too: a broken FUSE process can strand filesystem I/O.
                result = subprocess.run(['/bin/cat', str(target / 'ready')], capture_output=True, timeout=3)
                success = result.returncode == 0 and result.stdout == b'oe-fuse-ready\n'
                break
            time.sleep(0.1)
    except (OSError, subprocess.TimeoutExpired):
        pass
    finally:
        try:
            if mounted(target):
                subprocess.run([helper, '-u', '-z', str(target)], stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=3)
        except (OSError, subprocess.TimeoutExpired):
            pass
        if child and child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
                child.wait(timeout=2)
            except (OSError, subprocess.TimeoutExpired):
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=2)
                except (OSError, subprocess.TimeoutExpired):
                    pass
        try:
            if not mounted(target):
                target.rmdir()
                marker.unlink()
                source.rmdir()
                root.rmdir()
                cleaned = True
        except OSError:
            pass
    return success and cleaned


def check():
    result = {'ready': False, 'container': container_kind(), 'device': False,
              'device_access': False, 'helper': bool(shutil.which('fusermount3') or shutil.which('fusermount')),
              'mount_test': 'not_run'}
    if not sys.platform.startswith('linux'):
        result['issue'] = 'unsupported_platform'
        return result
    try:
        result['device'] = stat.S_ISCHR(os.stat('/dev/fuse').st_mode)
        if result['device']:
            fd = os.open('/dev/fuse', os.O_RDWR | os.O_CLOEXEC)
            os.close(fd)
            result['device_access'] = True
    except OSError:
        pass
    if not result['device_access']:
        result['issue'] = 'device_missing' if not result['device'] else 'device_denied'
    elif not result['helper']:
        result['issue'] = 'helper_missing'
    elif not shutil.which('rclone'):
        result['issue'] = 'clients_missing'
    else:
        result['ready'] = probe(shutil.which('rclone'), shutil.which('fusermount3') or shutil.which('fusermount'))
        result['mount_test'] = 'passed' if result['ready'] else 'failed'
        result['issue'] = None if result['ready'] else 'mount_denied'
    return result


if __name__ == '__main__':
    os.umask(0o077)
    print(json.dumps(check()))
