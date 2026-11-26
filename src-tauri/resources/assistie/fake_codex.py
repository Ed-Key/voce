"""Scripted stand-in for `codex app-server`, for test_responder.py. No network, no model.

FAKE_CODEX_SCRIPT names a JSON list, one entry per turn: {"text", "delay", "items", "inferences",
"die", "late", "stale", "notify", "exit_after"}. Every turn/start input is appended to FAKE_CODEX_LOG.
FAKE_CODEX_INIT_DELAY stalls the initialize reply. `codex mcp list --json` reports no servers.
"""
import json
import os
import sys
import threading
import time

if "mcp" in sys.argv:
    print("[]")
    sys.exit(0)
if "--version" in sys.argv:
    print("codex-cli fake")
    sys.exit(0)
script = json.load(open(os.environ["FAKE_CODEX_SCRIPT"]))
log = os.environ["FAKE_CODEX_LOG"]
lock, turns, running = threading.Lock(), iter(script), {}


def send(message):
    with lock:
        sys.stdout.write(json.dumps(message) + "\n")
        sys.stdout.flush()


def note(method, **params):
    send({"jsonrpc": "2.0", "method": method, "params": params})


def play(turn_id, step, cancel):
    if step.get("die"):
        os._exit(3)
    if step.get("stale"):
        # Output tagged with the previous turn, arriving after the new turn started.
        old = f"turn{int(turn_id[4:]) - 1}"
        note("item/agentMessage/delta", threadId="t1", turnId=old, itemId="old", delta="STALE TEXT ")
        note("turn/completed", threadId="t1", turn={"id": old, "status": "completed"})
    if step.get("notify"):
        note(step["notify"], threadId="t1", turnId=turn_id)
    if cancel.wait(step.get("delay", 0)):
        if step.get("late"):
            note("item/agentMessage/delta", turnId=turn_id, itemId="late", delta="LATE TEXT")
        note("turn/completed", threadId="t1", turn={"id": turn_id, "status": "interrupted"})
        return
    for kind in step.get("items", []):
        note("item/started", threadId="t1", turnId=turn_id, item={"type": kind, "id": kind})
    note("item/started", threadId="t1", turnId=turn_id, item={"type": "agentMessage", "id": "m"})
    for piece in [step.get("text", "")[i:i + 7] for i in range(0, len(step.get("text", "")), 7)]:
        note("item/agentMessage/delta", threadId="t1", turnId=turn_id, itemId="m", delta=piece)
    for _ in range(step.get("inferences", 1)):
        note("thread/tokenUsage/updated", threadId="t1", turnId=turn_id, tokenUsage={"last": {}})
    note("turn/completed", threadId="t1", turn={"id": turn_id, "status": "completed"})
    if step.get("exit_after"):
        time.sleep(.2)
        os._exit(4)


for line in sys.stdin:
    message = json.loads(line)
    method, params = message.get("method"), message.get("params", {})
    if method == "initialize":
        time.sleep(float(os.environ.get("FAKE_CODEX_INIT_DELAY", "0")))
        send({"jsonrpc": "2.0", "id": message["id"], "result": {}})
    elif method == "thread/start":
        with open(log, "a") as stream:
            stream.write(json.dumps({"system": params["baseInstructions"], "flags": sys.argv[1:], "pid": os.getpid()}) + "\n")
        send({"jsonrpc": "2.0", "id": message["id"], "result": {"thread": {"id": "t1"}}})
    elif method == "turn/start":
        turn_id = f"turn{len(running) + 1}"
        with open(log, "a") as stream:
            stream.write(json.dumps({"input": json.loads(params["input"][0]["text"]), "raw": params["input"][0]["text"]}) + "\n")
        send({"jsonrpc": "2.0", "id": message["id"], "result": {"turn": {"id": turn_id}}})
        cancel = threading.Event()
        running[turn_id] = cancel
        threading.Thread(target=play, args=(turn_id, next(turns, {"text": "NO_POINTER"}), cancel), daemon=True).start()
    elif method == "turn/interrupt":
        running[params["turnId"]].set()
        send({"jsonrpc": "2.0", "id": message["id"], "result": {}})
