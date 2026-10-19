"""Disposable acceptance provisioning; no production daemon, provider key or user config."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import urllib.request

value = json.load(sys.stdin)
root = Path(value["root"])
base = Path("/home/hermes/.cache/salaam-m10.eByB1aeQ")
if root.parent != base or not re.fullmatch(r"m18-[0-9a-f-]{36}", root.name) or str(root.resolve()) != str(root):
    raise RuntimeError("Select a fresh owned M18 subdirectory of the authorized rehearsal root")
phase = value["phase"]
if phase == "create":
    base.mkdir(mode=0o700, parents=True, exist_ok=True)
    root.mkdir(mode=0o700)
    for name in ["sdk", "uploads", "preparation-home", "peer-home", "peer-state"]:
        (root / name).mkdir(mode=0o700)
    (root / ".salaam-m18-owned").write_text(value["owner"])
    print(json.dumps({"root": str(root), "system": platform.system(), "machine": platform.machine(), "free_bytes": shutil.disk_usage(root).free}))
    raise SystemExit(0)
if not (root / ".salaam-m18-owned").is_file() or (root / ".salaam-m18-owned").read_text() != value["owner"]:
    raise RuntimeError("Rehearsal ownership marker changed")
if phase == "kill":
    import signal
    pid = int(value["pid"])
    handle = os.pidfd_open(pid)
    try:
        command = (Path("/proc") / str(pid) / "cmdline").read_bytes().split(b"\0")
        if str(root / "uploads/m18-remote-service.mjs").encode() not in command or str(root / "service-config.json").encode() not in command:
            raise RuntimeError("Not the owned acceptance daemon")
        signal.pidfd_send_signal(handle, signal.SIGKILL)
    finally:
        os.close(handle)
    print(json.dumps({"killed_owned_daemon": pid, "signal": "SIGKILL"}))
    raise SystemExit(0)
if phase == "cleanup":
    shutil.rmtree(root)
    print(json.dumps({"removed_owned_root": str(root)}))
    raise SystemExit(0)
pin = json.loads((root / "node-pin.json").read_text())["node"]
if pin["version"] != "26.7.0" or pin["arch"] != "linux-x64" or pin["url"] != "https://nodejs.org/dist/v26.7.0/node-v26.7.0-linux-x64.tar.xz" or pin["sha256"] != "982aa24dd8be4c889c6a8ab337ddff3b0896645b20f4239356e80552c16277ee":
    raise RuntimeError("Portable runtime identity changed")
node_root = root / "node-v26.7.0-linux-x64"
node = node_root / "bin/node"
if phase == "prepare":
    archive = root / "node.tar.xz"
    with urllib.request.urlopen(pin["url"], timeout=45) as response:
        data = response.read(64 * 1024 * 1024 + 1)
    if len(data) > 64 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != pin["sha256"]:
        raise RuntimeError("Portable Node artifact failed integrity verification")
    archive.write_bytes(data)
    with tarfile.open(archive) as tar:
        tar.extractall(root, filter="data")
home = root / "preparation-home"
for name in ["user.npmrc", "global.npmrc"]:
    (home / name).write_text("")
env = {"HOME": str(home), "PATH": str(node_root / "bin") + ":/usr/bin:/bin", "LANG": "C.UTF-8", "npm_config_userconfig": str(home / "user.npmrc"), "npm_config_globalconfig": str(home / "global.npmrc"), "npm_config_cache": str(home / "npm-cache")}


def run(args, timeout=180):
    return subprocess.check_output([str(x) for x in args], cwd=root, env=env, timeout=timeout, stderr=subprocess.PIPE, text=True)


if run([node, "--version"]).strip() != "v26.7.0":
    raise RuntimeError("Wrong portable Node executable")
if phase == "prepare":
    run([node_root / "bin/npm", "ci", "--prefix", root / "sdk", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org/"])
    print(json.dumps({"root": str(root), "node": str(node), "node_version": "26.7.0", "npm_version": run([node_root / "bin/npm", "--version"]).strip(), "sdk": str(root / "sdk/node_modules/@a2a-js/sdk"), "system": platform.system(), "release": platform.release(), "machine": platform.machine(), "original_node_untouched": "/usr/bin/node"}))
elif phase == "install":
    archive = root / "uploads/salaam-cli-0.0.1.tgz"
    manifest = json.loads((root / "uploads/release.json").read_text())
    if manifest["dirty"] or hashlib.sha256(archive.read_bytes()).hexdigest() != manifest["package_sha256"]:
        raise RuntimeError("Candidate identity changed")
    cli = root / "cli"
    if cli.exists():
        shutil.rmtree(cli)
    cli.mkdir(mode=0o700)
    run([node_root / "bin/npm", "install", "--prefix", cli, "--ignore-scripts", "--offline", "--no-audit", "--no-fund", archive])
    print(json.dumps({"installed_candidate": manifest["commit"], "package_sha256": manifest["package_sha256"], "source_checkout_required": False}))
elif phase == "smoke":
    print(run([node, root / "uploads/package-smoke.mjs", root / "uploads/salaam-cli-0.0.1.tgz"]))
elif phase == "coding":
    cli = root / "cli"
    cli.mkdir(mode=0o700, exist_ok=True)
    run([node_root / "bin/npm", "install", "--prefix", cli, "--ignore-scripts", "--offline", "--no-audit", "--no-fund", root / "uploads/salaam-cli-0.0.1.tgz"])
    package = cli / "node_modules/@superjackfruitlabs/salaam"
    for image in ["docker.io/library/busybox@sha256:5cec3fc171c87218698e85a52af7087de727372aae264a787b8112901a5b0092", "docker.io/library/node@sha256:aadf416b2cdce311a8811ba3f0608a61b77dbf997500e2eafe781b51f6a0b019", "docker.io/library/node@sha256:4db36457f406501e6f608802e5da617e5fbd0e80b75901b6a09de1ae5a667d32"]:
        run(["/usr/bin/docker", "image", "pull", image])
    receipt = run([node, package / "bin/salaam.mjs", "harness", "prepare", "--runtime-root", root / "harness-runtime", "--arch", "linux-x64"], timeout=300)
    (root / "harness-preparation.json").write_text(receipt)
    harness = run([node, package / "bin/salaam.mjs", "harness", "config", "--target", "codex-app-server", "--runtime-root", root / "harness-runtime", "--id", "codex"])
    (root / "harness.json").write_text(harness)
    (root / "harness.json").chmod(0o600)
    (root / "bin").mkdir(mode=0o700, exist_ok=True)
    wrapper = root / "bin/sal"
    wrapper.write_text("#!/bin/sh\nexec " + shlex.quote(str(node)) + " " + shlex.quote(str(package / "bin/salaam.mjs")) + ' "$@"\n')
    wrapper.chmod(0o700)
    print(json.dumps({"package_root": str(package), "remote_bin": str(wrapper), "harness_runtime": str(root / "harness-runtime"), "target": "codex-app-server", "harness_preparation": json.loads(receipt)}))
else:
    raise RuntimeError("Unknown acceptance preparation phase")
