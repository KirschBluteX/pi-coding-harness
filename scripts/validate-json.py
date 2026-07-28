#!/usr/bin/env python3
"""Compatibility launcher for the authoritative Ajv 2020 validator."""

from pathlib import Path
import subprocess
import sys


SCRIPT = Path(__file__).with_name("validate-json.mjs")
raise SystemExit(subprocess.call(["node", str(SCRIPT), *sys.argv[1:]]))
