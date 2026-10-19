#!/usr/bin/env python3
"""Write a bounded ZIP using only the inherited authorized directory (fd 3)."""
import json
import os
import stat
import sys
import zipfile


class BoundedFile:
    def __init__(self, file, limit):
        self.file, self.limit = file, limit

    def write(self, data):
        if self.file.tell() + len(data) > self.limit:
            raise ValueError('Project archive exceeds the 500 MiB download limit.')
        return self.file.write(data)

    def __getattr__(self, name):
        return getattr(self.file, name)


def version(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def archive(output, limit, skip):
    count, total = 0, 0
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    if not stat.S_ISDIR(os.fstat(3).st_mode):
        raise ValueError('Invalid project directory.')
    with open(output, 'xb') as raw, zipfile.ZipFile(BoundedFile(raw, limit), 'w', zipfile.ZIP_DEFLATED, allowZip64=True) as bundle:
        def walk(parent, prefix='', depth=0):
            nonlocal count, total
            if depth > 40:
                raise ValueError('Project has too many nested folders.')
            for name in sorted(os.listdir(parent)):
                if name in skip:
                    continue
                if name in ('.', '..') or '/' in name or '\\' in name:
                    raise ValueError('Project contains an unsupported archive filename.')
                count += 1
                if count > 100000:
                    raise ValueError('Project has too many archive entries.')
                before = os.stat(name, dir_fd=parent, follow_symlinks=False)
                relative = prefix + name
                if stat.S_ISDIR(before.st_mode):
                    fd = os.open(name, flags | os.O_DIRECTORY, dir_fd=parent)
                    try:
                        if version(os.fstat(fd)) != version(before):
                            raise ValueError('Project changed during download. Try again.')
                        bundle.writestr(relative + '/', b'')
                        walk(fd, relative + '/', depth + 1)
                    finally:
                        os.close(fd)
                elif stat.S_ISREG(before.st_mode):
                    fd = os.open(name, flags, dir_fd=parent)
                    with os.fdopen(fd, 'rb') as source:
                        if version(os.fstat(fd)) != version(before):
                            raise ValueError('Project changed during download. Try again.')
                        info = zipfile.ZipInfo(relative)
                        info.compress_type = zipfile.ZIP_DEFLATED
                        info.external_attr = (stat.S_IFREG | (0o700 if before.st_mode & 0o111 else 0o600)) << 16
                        with bundle.open(info, 'w', force_zip64=True) as destination:
                            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                                total += len(chunk)
                                if total > 5 * 1024 ** 3:
                                    raise ValueError('Project exceeds the 5 GiB source limit.')
                                destination.write(chunk)
                        if version(os.fstat(fd)) != version(before):
                            raise ValueError('Project changed during download. Try again.')
                # Symlinks, sockets, devices and FIFOs are never opened.
        walk(3)


if __name__ == '__main__':
    try:
        archive(sys.argv[1], int(sys.argv[2]), set(json.loads(sys.argv[3])))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
