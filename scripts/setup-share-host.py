#!/usr/bin/env python3
"""Bounded host-side FUSE setup, dispatched only to an authorized paired node.

Input/output are JSON. Never print Docker inspect/config output (it has secrets).
Container restarts run on the host, independently of the guest's connection.
"""
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import subprocess
import sys
import time
import uuid


class SetupError(Exception):
    pass


def run(argv, timeout=30):
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        raise SetupError('Host command unavailable or timed out: ' + argv[0])
    if result.returncode:
        raise SetupError('Host command failed: ' + argv[0] + '. Check the host service logs.')
    return result.stdout


def private_dir(target):
    target.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = target.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise SetupError('Host setup storage must be a private root-owned directory.')
    return target


def write_private(target, data):
    fd = os.open(str(target), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def host_fuse():
    if not Path('/dev/fuse').exists():
        run(['modprobe', 'fuse'])
        if shutil.which('udevadm'):
            run(['udevadm', 'settle', '--timeout=5'])
    try:
        if not stat.S_ISCHR(os.stat('/dev/fuse').st_mode):
            raise OSError()
        fd = os.open('/dev/fuse', os.O_RDWR | os.O_CLOEXEC)
        os.close(fd)
    except OSError:
        raise SetupError('The parent host itself cannot open /dev/fuse. Configure its kernel/device first.')


def schedule(folder, command, recovery=None, cwd=None):
    if not shutil.which('systemd-run'):
        raise SetupError('This host needs systemd-run to apply a container restart safely.')
    # This file survives the guest shutdown. A failed restart records failure,
    # and Proxmox always attempts to start a guest left stopped by shutdown.
    job = """import json, pathlib, subprocess
p = json.loads(pathlib.Path(__file__).with_suffix('.json').read_text())
ok = False
recovered = False
try:
    ok = subprocess.run(p['command'], cwd=p['cwd'], timeout=180, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
finally:
    if p['recovery']:
        try:
            recovered = subprocess.run(p['recovery'], cwd=p['cwd'], timeout=120, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            pass
    pathlib.Path(__file__).with_suffix('.result.json').write_text(json.dumps({'command_ok': ok, 'recovery_ok': recovered}))
    pending = pathlib.Path(__file__).parent.parent / 'pending-restart.json'
    try:
        if json.loads(pending.read_text()).get('folder') == str(pathlib.Path(__file__).parent):
            pending.unlink()
    except (OSError, ValueError):
        pass
"""
    jobfile = folder / 'restart.py'
    write_private(jobfile, job)
    write_private(jobfile.with_suffix('.json'), json.dumps({'command': command, 'recovery': recovery, 'cwd': cwd}))
    unit = 'oe-share-setup-' + uuid.uuid4().hex[:12]
    pending = folder.parent / 'pending-restart.json'
    write_private(pending, json.dumps({'folder': str(folder), 'unit': unit, 'expires': time.time() + 600}))
    try:
        run(['systemd-run', '--quiet', '--unit=' + unit, '--on-active=5s', '--timer-property=AccuracySec=1s',
             sys.executable, str(jobfile)])
    except SetupError:
        pending.unlink()
        raise
    return unit


def proxmox(data, folder):
    target = data['container_id']
    if not re.fullmatch(r'[1-9][0-9]{2,8}', target):
        raise SetupError('Choose an exact numeric Proxmox CTID.')
    identity = run(['pct', 'exec', target, '--', 'cat', '/etc/machine-id']).strip()
    namespace = run(['pct', 'exec', target, '--', 'stat', '-Lc', '%i', '/proc/self/ns/uts']).strip()
    if not data.get('machine_id') or identity != data['machine_id'] or namespace != data.get('uts_inode'):
        raise SetupError('This CTID is not the running OE container. No configuration changed.')
    node = socket.gethostname().split('.')[0]
    endpoint = '/nodes/' + node + '/lxc/' + target + '/config'
    config = json.loads(run(['pvesh', 'get', endpoint, '--output-format', 'json']))
    features = dict(item.split('=', 1) for item in config.get('features', '').split(',') if '=' in item)
    if not config.get('digest'):
        raise SetupError('Proxmox did not return a configuration digest; cannot safely merge features.')
    original = config.get('features', '')
    features['fuse'] = '1'
    merged = ','.join(key + '=' + value for key, value in features.items())
    write_private(folder / 'before.json', json.dumps({'features': original, 'digest': config['digest']}))
    host_fuse()
    if features != dict(item.split('=', 1) for item in original.split(',') if '=' in item):
        run(['pct', 'set', target, '--features', merged, '--digest', config['digest']])
    verified = json.loads(run(['pvesh', 'get', endpoint, '--output-format', 'json']))
    if 'fuse=1' not in verified.get('features', '').split(','):
        raise SetupError('Proxmox did not retain the FUSE feature. Container was not restarted.')
    result = {'ready': False, 'configured': True, 'restart_required': True,
              'message': 'FUSE is enabled for this Proxmox container. Restart it, then verify network-share support.',
              'backup_note': 'Proxmox documents FUSE limitations with freezer-based snapshot/suspend backups; use a compatible backup mode.'}
    if data.get('restart_container'):
        # Always try to start after shutdown, including a non-zero shutdown result.
        result['restart_job'] = schedule(folder, ['pct', 'shutdown', target, '--timeout', '60'], ['pct', 'start', target])
    return result


def verify_compose_storage(config, service, inspect, project):
    volumes = []
    for item in service.get('volumes', []):
        if not isinstance(item, dict) or item.get('type') not in ('bind', 'volume') or not item.get('source'):
            raise SetupError('Automatic setup requires explicit bind or named volumes; anonymous/special mounts need administrator review.')
        source = item['source']
        if item['type'] == 'volume':
            source = config.get('volumes', {}).get(source, {}).get('name') or project + '_' + source
        volumes.append((item['type'], source, item['target'], not item.get('read_only', False)))
    actual = [(item['Type'], item.get('Name') if item['Type'] == 'volume' else item['Source'], item['Destination'], item['RW'])
              for item in inspect.get('Mounts', [])]
    if sorted(volumes) != sorted(actual):
        raise SetupError('Compose mounts differ from the running container. Reconcile the Compose file before automatic recreation.')
    expected = []
    for item in service.get('ports', []):
        if not isinstance(item, dict) or not str(item.get('published', '')).isdigit():
            raise SetupError('Automatic setup requires explicit published ports.')
        expected.append((str(item['target']) + '/' + item.get('protocol', 'tcp'), item.get('host_ip') or '', str(item['published'])))
    actual_ports = [(key, binding.get('HostIp') or '', binding['HostPort'])
                    for key, bindings in (inspect.get('HostConfig', {}).get('PortBindings') or {}).items() for binding in bindings or []]
    if sorted(expected) != sorted(actual_ports):
        raise SetupError('Compose ports differ from the running container. Reconcile the Compose file before automatic recreation.')


def verify_durable_state(data, inspect):
    paths = data.get('state_paths', [])
    mounts = [item['Destination'].rstrip('/') for item in inspect.get('Mounts', []) if item.get('RW') and item.get('Type') in ('volume', 'bind')]
    if len(paths) != 3 or any(not isinstance(name, str) or not name.startswith('/') or
                             not any(name == mount or name.startswith(mount + '/') for mount in mounts) for name in paths):
        raise SetupError('OE config, profiles, and restart checkpoint must live on persistent writable mounts before container recreation. Move that state to volumes first.')


def docker_compose(data, folder):
    target = data['container_id']
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}', target):
        raise SetupError('Choose an exact Docker container name or ID.')
    inspect = json.loads(run(['docker', 'inspect', '--type', 'container', target]))[0]
    pid = inspect.get('State', {}).get('Pid')
    namespace = str(os.stat('/proc/' + str(pid) + '/ns/uts').st_ino) if isinstance(pid, int) and pid > 0 else ''
    if not data.get('uts_inode') or namespace != data['uts_inode'] or inspect['Config'].get('Hostname') != data.get('hostname'):
        raise SetupError('This Docker container is not the running OE container. No configuration changed.')
    verify_durable_state(data, inspect)
    labels = inspect['Config'].get('Labels') or {}
    project = labels.get('com.docker.compose.project', '')
    service_name = labels.get('com.docker.compose.service', '')
    cwd = labels.get('com.docker.compose.project.working_dir', '')
    files = labels.get('com.docker.compose.project.config_files', '').split(',')
    if not project or not service_name or not Path(cwd).is_absolute() or not all(Path(p).is_absolute() and Path(p).is_file() for p in files):
        raise SetupError('This container needs its original Docker Compose files on the host. Standalone docker-run containers require administrator configuration.')
    security = json.loads(run(['docker', 'info', '--format', '{{json .SecurityOptions}}'])) or []
    if any('rootless' in item for item in security):
        raise SetupError('Rootless Docker needs host-specific FUSE configuration by its administrator.')
    if inspect.get('AppArmorProfile') not in ('', 'docker-default', 'openensemble-shares'):
        raise SetupError('This container has a custom AppArmor policy. Its administrator must add FUSE permissions to that policy.')
    command = ['docker', 'compose', '--project-name', project, '--project-directory', cwd]
    for filename in files:
        command += ['-f', filename]
    config = json.loads(run(command + ['config', '--format', 'json']))
    hashes = dict(line.split() for line in run(command + ['config', '--hash', service_name]).splitlines() if len(line.split()) == 2)
    if not labels.get('com.docker.compose.config-hash') or hashes.get(service_name) != labels['com.docker.compose.config-hash']:
        raise SetupError('Compose configuration differs from the running service (or uses an incompatible Compose version). Reconcile it before automatic recreation.')
    service = config.get('services', {}).get(service_name)
    if not service:
        raise SetupError('The running service is missing from its original Compose files.')
    verify_compose_storage(config, service, inspect, project)
    if service.get('privileged') or inspect.get('HostConfig', {}).get('Privileged'):
        raise SetupError('Automatic FUSE setup does not manage privileged containers.')
    host_fuse()
    devices = service.setdefault('devices', [])
    if not any(isinstance(d, dict) and d.get('target') == '/dev/fuse' for d in devices):
        devices.append({'source': '/dev/fuse', 'target': '/dev/fuse', 'permissions': 'rwm'})
    caps = service.setdefault('cap_add', [])
    if 'SYS_ADMIN' not in caps:
        caps.append('SYS_ADMIN')
    if any('apparmor' in item for item in security):
        if not shutil.which('apparmor_parser'):
            raise SetupError('Install the host AppArmor parser before configuring this Docker container.')
        profile = Path('/etc/apparmor.d/openensemble-shares')
        content = data['apparmor_profile']
        if profile.exists() and profile.read_text() != content:
            raise SetupError('An existing openensemble-shares profile differs. Its administrator must reconcile it first.')
        if not profile.exists():
            write_private(profile, content)
            profile.chmod(0o644)
        run(['apparmor_parser', '-r', str(profile)])
        options = [item for item in service.get('security_opt', []) if not item.startswith(('apparmor=', 'apparmor:'))]
        service['security_opt'] = options + ['apparmor=openensemble-shares']
    # Pin the current image and effective environment; never rebuild, pull, or
    # expose secrets in the tool result. Compose config is stored root-only.
    service['image'] = inspect['Image']
    # `compose config` escapes dollar signs for a subsequent Compose parse.
    # Values coming from inspect are raw and need that same escaping exactly once.
    service['environment'] = {key: value.replace('$', '$$')
                              for key, value in (item.split('=', 1) for item in inspect['Config'].get('Env', []) if '=' in item)}
    staged = folder / 'compose.json'
    write_private(staged, json.dumps(config))
    # Validate on the host before scheduling any interruption.
    run(['docker', 'compose', '--project-name', project, '--project-directory', cwd, '-f', str(staged), 'config', '--quiet'])
    apply = ['docker', 'compose', '--project-name', project, '--project-directory', cwd, '-f', str(staged),
             'up', '-d', '--no-deps', '--no-build', '--pull', 'never', service_name]
    result = {'ready': False, 'configured': True, 'restart_required': True, 'staged_config': str(staged),
              'message': 'FUSE device, capability, and security policy are prepared. Recreate this Compose service, then verify network-share support.'}
    if data.get('restart_container'):
        result['restart_job'] = schedule(folder, apply, cwd=cwd)
    return result


def main(data):
    if os.geteuid() != 0:
        raise SetupError('Container-host setup requires a paired node running with full root access.')
    if data.get('host_kind') not in ('docker_compose', 'proxmox'):
        raise SetupError('Choose Docker Compose or Proxmox.')
    root = private_dir(Path('/var/lib/openensemble-share-setup'))
    with (root / 'setup.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SetupError('Another host setup is already running.')
        pending = root / 'pending-restart.json'
        if pending.exists():
            if json.loads(pending.read_text()).get('expires', 0) > time.time():
                raise SetupError('A container restart is already scheduled or running on this host. Verify its result before another setup.')
            pending.unlink()
        folder = private_dir(root / uuid.uuid4().hex)
        result = globals()[data['host_kind']](data, folder)
        result['host_receipt'] = str(folder)
        write_private(folder / 'result.json', json.dumps(result))
        return result


if __name__ == '__main__':
    os.umask(0o077)
    try:
        print(json.dumps(main(json.loads(sys.argv[1]))))
    except (SetupError, ValueError, KeyError, OSError) as exc:
        # Only our bounded errors are public; never echo raw configuration.
        print(json.dumps({'ready': False, 'error': str(exc) if isinstance(exc, SetupError) else 'Host setup could not read its configuration.'}))
        sys.exit(1)
