"""Opt-in pinned Hermes transport rehearsal; the message handler is a fixture, not a model."""
import asyncio
import json
import os
import sys

mode, root = sys.argv[1:3]
if mode not in {"serve", "send"} or not os.environ.get("SALAAM_A2A_FIXTURE_HOME") or os.environ.get("HOME") != os.environ["SALAAM_A2A_FIXTURE_HOME"]:
    raise RuntimeError("Use a disposable HOME and explicit pinned Hermes source root")
sys.path.insert(0, root)
from plugins.platforms.a2a.adapter import A2AAdapter
from plugins.platforms.a2a import tools
from gateway.config import PlatformConfig


def emit(value):
    print(json.dumps(value), flush=True)


async def main():
    if mode == "send":
        value = json.loads(await asyncio.to_thread(sys.stdin.readline))
        # This is operator fixture configuration, supplied outside model turns.
        tools._load_config = lambda: {"a2a_agents": {"salaam": {"url": value["url"], "auth": {"type": "bearer", "token": value["token"]}, "timeout": 30, "tenant": value.get("tenant", "")}}}
        reply = await asyncio.to_thread(tools.a2a_call, {"agent": "salaam", "message": value["text"]})
        emit({"reply": reply, "scope": "actual-pinned-plugin-client-fixture-configuration"})
        return
    adapter = A2AAdapter(PlatformConfig(enabled=True, extra={"port": 0}))
    accepted = 0
    held = False

    async def reply(event):
        nonlocal accepted
        accepted += 1
        if held:
            while held:
                await asyncio.sleep(0.05)
        return "Fixture analysis from the actual Hermes A2A adapter; no model or execution claim."

    adapter.set_message_handler(reply)
    if not await adapter.connect():
        raise RuntimeError("Hermes adapter failed to bind")
    # The real adapter's address is authoritative when the OS selected port zero.
    port = adapter._httpd.server_address[1]
    adapter.port = port
    emit({"ready": True, "version": "0.22.2", "scope": "actual-pinned-plugin-transport-fixture-agent", "endpoint": f"http://127.0.0.1:{port}/", "card": f"http://127.0.0.1:{port}/.well-known/agent-card.json"})
    try:
        while line := await asyncio.to_thread(sys.stdin.readline):
            command = json.loads(line)
            if command["op"] == "stats":
                emit({"accepted": accepted})
            elif command["op"] == "hold":
                held = True
                emit({"held": True})
            elif command["op"] == "release":
                held = False
                emit({"released": True})
            elif command["op"] == "stop":
                break
    finally:
        held = False
        await adapter.disconnect()


asyncio.run(main())
