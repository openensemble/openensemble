#!/usr/bin/env python3
"""Extract an OE data archive after checking every member, without following links."""
import os
import gzip
import pathlib
import sys
import tarfile


class BoundedReader:
    def __init__(self, source, limit):
        self.source, self.limit, self.total = source, limit, 0

    def read(self, size=-1):
        value = self.source.read(min(size, 1024 * 1024) if size >= 0 else 1024 * 1024)
        self.total += len(value)
        if self.total > self.limit:
            raise ValueError('Archive exceeds the restored data limit')
        return value


def extract_members(bundle, root, max_bytes, max_entries):
    total = 0
    seen = set()
    for member in bundle:
            name = pathlib.PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts or '\\' in member.name:
                raise ValueError('Unsafe archive path: ' + member.name)
            if not member.isfile() and not member.isdir():
                raise ValueError('Archive links and special files are unsupported: ' + member.name)
            if str(name) == '.':
                if member.isdir():
                    continue
                raise ValueError('Invalid archive root')
            if str(name) in seen or len(member.name) > 4096:
                raise ValueError('Duplicate or oversized archive path: ' + member.name)
            seen.add(str(name))
            total += member.size
            if total > max_bytes or len(seen) > max_entries or member.size < 0:
                raise ValueError('Archive exceeds the restored data limit')
            target = root.joinpath(*name.parts)
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if member.isdir():
                target.mkdir(exist_ok=True, mode=0o700)
                continue
            with bundle.extractfile(member) as source, open(target, 'xb') as output:
                remaining = member.size
                while remaining:
                    chunk = source.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError('Truncated archive member: ' + member.name)
                    output.write(chunk)
                    remaining -= len(chunk)
            os.chmod(target, 0o700 if member.mode & 0o111 else 0o600)


def extract(archive, destination, max_bytes, max_entries=100000):
    root = pathlib.Path(destination).resolve()
    with gzip.open(archive, 'rb') as compressed:
        source = BoundedReader(compressed, max_bytes + max_entries * 8192 + 10240)
        with tarfile.open(fileobj=source, mode='r|') as bundle:
            extract_members(bundle, root, max_bytes, max_entries)
        # tar ends before the gzip footer. Read through it so a truncated
        # stream or bad CRC cannot be accepted as a verified backup.
        while source.read(1024 * 1024):
            pass


if __name__ == '__main__':
    try:
        extract(sys.argv[1], sys.argv[2], int(sys.argv[3]))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
