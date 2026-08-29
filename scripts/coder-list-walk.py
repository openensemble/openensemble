#!/usr/bin/env python3
"""Descriptor-anchored, streaming project traversal for coder_list_files.

The trusted project-root descriptor is inherited as fd 3. All descendant
opens are relative to an already-open directory and use O_NOFOLLOW, so a
project process cannot race a pathname into a host symlink. The protocol is a
sequence of length-prefixed binary frames: one type byte, a four-byte big
endian payload length, then the payload.
"""

import json
import os
import stat
import struct
import sys
import time


HEADER = struct.Struct(">cI")
ROOT_FD = 3


def emit(kind, payload=b""):
    if isinstance(payload, str):
        payload = payload.encode("utf-8", "replace")
    sys.stdout.buffer.write(HEADER.pack(kind, len(payload)))
    sys.stdout.buffer.write(payload)


def emit_json(kind, value):
    emit(kind, json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode("ascii"))


def fail(message):
    emit(b"E", str(message))
    sys.stdout.buffer.flush()
    return 1


def require_capabilities():
    missing = []
    if os.scandir not in os.supports_fd:
        missing.append("scandir(fd)")
    if os.open not in os.supports_dir_fd:
        missing.append("open(dir_fd=...)")
    if os.stat not in os.supports_dir_fd or os.stat not in os.supports_follow_symlinks:
        missing.append("stat(dir_fd=..., follow_symlinks=False)")
    if not hasattr(os, "O_DIRECTORY") or not hasattr(os, "O_NOFOLLOW"):
        missing.append("O_DIRECTORY/O_NOFOLLOW")
    if missing:
        raise RuntimeError("Python lacks required descriptor APIs: " + ", ".join(missing))


def main():
    if len(sys.argv) < 4:
        return fail("walker arguments are missing")
    try:
        max_entries = int(sys.argv[1])
        max_depth = int(sys.argv[2])
        budget_ms = int(sys.argv[3])
    except ValueError:
        return fail("walker limits must be integers")
    if max_entries < 1 or max_depth < 1 or budget_ms < 1:
        return fail("walker limits must be positive")

    try:
        require_capabilities()
        root_stat = os.fstat(ROOT_FD)
        if not stat.S_ISDIR(root_stat.st_mode):
            return fail("inherited project root is not a directory")
    except OSError as error:
        return fail(f"could not inspect inherited project root: {error}")
    except RuntimeError as error:
        return fail(error)

    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    if hasattr(os, "O_NONBLOCK"):
        flags |= os.O_NONBLOCK

    current_fd = ROOT_FD
    try:
        for segment in sys.argv[4:]:
            if not segment or segment in (".", "..") or "/" in segment or "\0" in segment:
                raise ValueError("invalid starting-directory segment")
            next_fd = os.open(segment, flags, dir_fd=current_fd)
            if not stat.S_ISDIR(os.fstat(next_fd).st_mode):
                os.close(next_fd)
                raise NotADirectoryError(segment)
            os.close(current_fd)
            current_fd = next_fd
    except (OSError, ValueError) as error:
        try:
            os.close(current_fd)
        except OSError:
            pass
        return fail(f"could not safely open requested directory: {error}")

    deadline = time.monotonic() + budget_ms / 1000.0
    state = {
        "visited": 0,
        "entry_limit": False,
        "time_limit": False,
        "unreadable_directories": 0,
        "unreadable_entries": 0,
        "depth_skipped": 0,
    }
    stopped = False

    def over_time():
        nonlocal stopped
        if time.monotonic() < deadline:
            return False
        state["time_limit"] = True
        stopped = True
        return True

    def walk(directory_fd, relative, depth):
        nonlocal stopped
        try:
            try:
                iterator = os.scandir(directory_fd)
            except OSError:
                state["unreadable_directories"] += 1
                return
            with iterator:
                while not stopped:
                    if over_time():
                        return
                    try:
                        entry = next(iterator)
                    except StopIteration:
                        return
                    except OSError:
                        state["unreadable_directories"] += 1
                        return
                    if over_time():
                        return
                    if entry.name in (".git", "node_modules"):
                        continue
                    if state["visited"] >= max_entries:
                        state["entry_limit"] = True
                        stopped = True
                        return
                    state["visited"] += 1

                    # The parent protocol and tool response are UTF-8. Unix
                    # filenames with undecodable bytes are legal, but emitting
                    # them with replacement characters would invent a path
                    # that does not exist, so report an honest partial listing.
                    try:
                        name_bytes = entry.name.encode("utf-8")
                    except UnicodeEncodeError:
                        state["unreadable_entries"] += 1
                        continue

                    try:
                        entry_stat = os.stat(entry.name, dir_fd=directory_fd, follow_symlinks=False)
                    except OSError:
                        state["unreadable_entries"] += 1
                        continue

                    path_bytes = name_bytes if not relative else relative + b"/" + name_bytes
                    mode = entry_stat.st_mode
                    if stat.S_ISDIR(mode):
                        emit(b"D", path_bytes)
                        if depth >= max_depth:
                            state["depth_skipped"] += 1
                            continue
                        if over_time():
                            return
                        try:
                            child_fd = os.open(entry.name, flags, dir_fd=directory_fd)
                            if not stat.S_ISDIR(os.fstat(child_fd).st_mode):
                                os.close(child_fd)
                                state["unreadable_directories"] += 1
                                continue
                        except OSError:
                            state["unreadable_directories"] += 1
                            continue
                        walk(child_fd, path_bytes, depth + 1)
                    elif stat.S_ISREG(mode):
                        emit(b"F", path_bytes)
                    else:
                        emit(b"O", path_bytes)
        finally:
            try:
                os.close(directory_fd)
            except OSError:
                pass

    try:
        walk(current_fd, b"", 0)
        emit_json(b"S", state)
        sys.stdout.buffer.flush()
        return 0
    except BrokenPipeError:
        return 0
    except Exception as error:  # Fail closed on helper/protocol bugs.
        try:
            return fail(f"walker failed: {error}")
        except BrokenPipeError:
            return 1


if __name__ == "__main__":
    raise SystemExit(main())
