"""Syntax-check the Python inside mod/renpy/dubgame.rpy (the body of its `init python:` block).

Usage: python3 scripts/check-rpy.py mod/renpy/dubgame.rpy
Only checks the interpreter it runs under. Ren'Py 7 runs Python 2.7, so run it with python2 as well
when one is available.
"""
import sys
import textwrap


def extract(source):
    lines = source.splitlines()
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("init") and stripped.endswith("python:"):
            return textwrap.dedent("\n".join(lines[i + 1:])) + "\n"
    raise SystemExit("no `init python:` block found")


def main(path):
    with open(path, "rb") as handle:
        body = extract(handle.read().decode("utf-8"))
    compile(body, path, "exec")
    print("ok: %s compiles under Python %d.%d" % (path, sys.version_info[0], sys.version_info[1]))


if __name__ == "__main__":
    main(sys.argv[1])
