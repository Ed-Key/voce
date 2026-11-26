"""Joins one call's step journals into the document the call page replays. Reads the app data folder, writes nothing,
and nothing leaves the Mac. Problems found while joining (open steps, broken sequences) are listed in the document;
they never stop it.

  python3 -I observatory.py <app data> <call id> [--full]

--full keeps every field for observability checks.
"""
from datetime import datetime
import json
import os
from pathlib import Path
import sys

TOKEN_FIELDS = ("inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens")


def rows(path, problems):
    """Readable rows; a row cut short by a crash is reported, and numbering continues after it."""
    if not path.is_file():
        return None
    out = []
    for line in path.read_text().splitlines():
        if line.strip():
            try:
                out.append(json.loads(line))
            except ValueError:
                problems.append(f"{path.parent.name}/{path.name}: a row cut short (the writer stopped mid-row)")
    return out


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def discover(data, call_id):
    """The call's newest run and the Terra runs bound to it: two replays of one recording are separate timelines."""
    runs = [p.parent for p in (data / "call-feed-replays").glob("*/request.json")
            if read_json(p).get("session", {}).get("id") == call_id]
    workers = sorted(runs, key=lambda w: (w / "request.json").stat().st_mtime)[-1:]
    terras = []
    for p in sorted((data / "assistie").glob("meeting-*/state.json")):
        binding = read_json(p).get("call_binding") or {}
        if binding.get("call_id") == call_id and binding.get("local_run_id") in (None, *[w.name for w in workers]):
            terras.append(p.parent)
    return workers, terras


def seq_problems(name, journal):
    seqs = [r.get("seq") for r in journal]
    if seqs != list(range(1, len(seqs) + 1)):
        return [f"{name}: journal rows are not a contiguous sequence"]
    return []


def export(workers, terras):
    doc = {"call": {}, "lines": {}, "engine": [], "feed": [], "turns": [], "sessions": [], "replies": [],
           "transcript_final": [], "problems": [], "sources": {"worker": [str(w.resolve()) for w in workers], "terra": [str(t.resolve()) for t in terras]}}
    for w in workers:
        request = json.loads((w / "request.json").read_text())
        session = request["session"]
        doc["call"] = {"id": session["id"], "title": session.get("title") or "Call", "started_at": session["started_at"],
                       "started_ms": int(datetime.fromisoformat(session["started_at"]).timestamp() * 1000)}
        journal = rows(w / "worker-journal.jsonl", doc["problems"])
        if journal is None:
            doc["problems"].append(f"{w.name}: no worker journal (a run from before the journals existed)")
            continue
        doc["problems"] += seq_problems(w.name, journal)
        sends = {}
        for r in journal:
            prov = f"{w.name}/worker-journal.jsonl#{r.get('seq')}"
            if r.get("kind") == "line":
                line = doc["lines"].setdefault(r["line"], {"source": r.get("source"), "revisions": [], "dropped": None})
                if r["stage"] == "dropped":
                    line["dropped"] = {"epoch_ms": r["epoch_ms"], "reason": r.get("reason"), "prov": prov}
                else:
                    line["source"] = line["source"] or r.get("source")
                    line["revisions"].append({"epoch_ms": r["epoch_ms"], "stage": r["stage"], "text": r["text"], "audio_ms": r.get("audio_ms"),
                                              "file": r.get("file"), "engine_id": r.get("engine_id"), "prov": prov})
            elif r.get("kind") == "engine":
                doc["engine"].append({k: r.get(k) for k in ("epoch_ms", "event", "engine_id", "reason", "resume")} | {"prov": prov})
            elif r.get("kind") == "run":
                doc["engine"].append({"epoch_ms": r["epoch_ms"], "event": "run " + r["event"], "engine_id": None,
                                      "reason": r.get("outcome") or r.get("reason"), "resume": None, "prov": prov})
            elif r.get("kind") == "feed":
                if r["event"] == "send":
                    sends[r["sequence"]] = r
                    doc["feed"].append({"epoch_ms": r["epoch_ms"], "sequence": r["sequence"], "upserts": [u["id"] for u in r["upserts"]],
                                        "removes": r["removes"], "ack_ms": None, "version": None, "prov": prov})
                elif r["event"] == "ack":
                    entry = next((f for f in reversed(doc["feed"]) if f["sequence"] == r["sequence"]), None)
                    if entry is None:
                        doc["problems"].append(f"{prov}: an acknowledgement without a send")
                    else:
                        entry.update(ack_ms=r["epoch_ms"], version=r["version"])
        for f in doc["feed"]:
            if f["ack_ms"] is None:
                doc["problems"].append(f"{f['prov']}: a feed send that was never acknowledged")
        transcript = w / "transcript.json"
        if transcript.is_file():
            doc["transcript_final"] = read_json(transcript).get("entries", [])
    for t in terras:
        journal = rows(t / "terra-journal.jsonl", doc["problems"])
        if journal is None:
            doc["problems"].append(f"{t.name}: no Terra journal (a run from before the journals existed)")
            continue
        doc["problems"] += seq_problems(t.name, journal)
        turns, usage = {}, []
        for r in journal:
            prov = f"{t.name}/terra-journal.jsonl#{r.get('seq')}"
            kind = r.get("kind")
            if kind == "session":
                doc["sessions"].append({k: r.get(k) for k in ("epoch_ms", "model", "effort", "codex_version", "prompt_sha256", "brief", "thread_id")}
                                       | {"terra_run": t.name, "prov": prov})
            elif kind == "usage":
                usage.append(r)
            elif kind == "event":
                turns[r["event_id"]] = {"terra_run": t.name, "event_id": r["event_id"], "kind": r["event_kind"], "question": r.get("question"),
                                        "event_ms": r["epoch_ms"], "request_ms": None, "lines_sent": [], "turn_id": None, "output_ms": None,
                                        "first_text_ms": None, "status": None, "raw": None, "settle_ms": None, "reason": None, "why": None,
                                        "payload": None, "cited": None, "tokens": None, "prov": {"event": prov}}
            elif kind in ("request", "buffered", "started", "output", "settle") and r.get("event_id") in turns:
                turn = turns[r["event_id"]]
                turn["prov"][kind] = prov
                if kind == "started":  # the turn id exists from here, so tokens join even if the turn never finishes
                    turn["turn_id"] = r.get("turn_id")
                elif kind in ("request", "buffered"):
                    turn["request_ms"], turn["lines_sent"], turn["sent_kind"], turn["message"] = r["epoch_ms"], r.get("lines", []), kind, r.get("message")
                elif kind == "output":
                    turn.update(output_ms=r["epoch_ms"], first_text_ms=r.get("first_text_ms"), status=r.get("status"), raw=r.get("raw"), turn_id=r.get("turn_id") or turn["turn_id"])
                else:
                    turn.update(settle_ms=r["epoch_ms"], reason=r.get("reason"), why=r.get("why"), payload=r.get("payload"), cited=r.get("cited_raw"))
            elif kind in ("request", "buffered", "started", "output", "settle"):
                doc["problems"].append(f"{prov}: a {kind} step for an event that was never recorded")
        for turn in turns.values():
            turn["tokens"] = turn_tokens(usage, turn["turn_id"])
            turn["complete"] = turn["settle_ms"] is not None and (turn.get("sent_kind") == "buffered" or turn["output_ms"] is not None)
            if not turn["complete"]:
                doc["problems"].append(f"{turn['prov']['event']}: turn {turn['event_id']} never settled")
            doc["turns"].append(turn)
        for p in sorted(t.glob("reply-*.json")):
            reply = read_json(p).get("reply")
            if not reply:
                doc["problems"].append(f"{t.name}/{p.name}: an unreadable reply")
                continue
            doc["replies"].append({"event_id": reply["event_id"], "terra_run": t.name, "text": reply["text"], "sources": reply["sources"],
                                   "received_at_ms": reply["received_at_ms"], "prov": f"{t.name}/{p.name}"})
    doc["turns"].sort(key=lambda x: x["event_ms"])
    starts = [r["epoch_ms"] for line in doc["lines"].values() for r in line["revisions"]] + [x["event_ms"] for x in doc["turns"]]
    run_start = next((e["epoch_ms"] for e in doc["engine"] if e["event"] == "run start"), None)
    first = min(starts) if starts else run_start or 0
    # A replay reuses the original call's session (and its started_at); its journals carry the replay's own times.
    if not doc["call"].get("started_ms") or not first - 2 * 3600 * 1000 <= doc["call"]["started_ms"] <= first:
        doc["call"]["started_ms"], doc["call"]["clock"] = run_start or first, "run start"
    else:
        doc["call"]["clock"] = "session start"
    doc["call"]["ended_ms"] = max(starts + [x["settle_ms"] or 0 for x in doc["turns"]], default=0)
    return doc


def turn_tokens(usage, turn_id):
    """This turn's tokens: the running total at its last update minus the total just before it. Unknown is None."""
    if not turn_id:
        return None
    mine = [i for i, u in enumerate(usage) if u.get("turn_id") == turn_id and u.get("total")]
    if not mine:
        return None
    after = usage[mine[-1]]["total"]
    before = next((usage[i]["total"] for i in range(mine[0] - 1, -1, -1) if usage[i].get("total")), {})
    out = {f: after.get(f, 0) - before.get(f, 0) for f in TOKEN_FIELDS}
    out["context_window"] = usage[mine[-1]].get("context_window")
    out["thread_total"] = after.get("totalTokens")
    return out


def view(doc):
    """What the call page shows: everything else in the export is for the checks."""
    def line(l):
        return {"source": l["source"], "dropped": l["dropped"] and {k: l["dropped"][k] for k in ("epoch_ms", "reason")},
                "revisions": [{k: r[k] for k in ("epoch_ms", "stage", "text", "audio_ms")} for r in l["revisions"]]}
    return {"call": doc["call"], "lines": {k: line(l) for k, l in doc["lines"].items()},
            "engine": [{k: e[k] for k in ("epoch_ms", "event", "reason")} for e in doc["engine"]],
            "turns": [{k: v for k, v in t.items() if k != "prov"} for t in doc["turns"]],
            "sessions": [{k: s[k] for k in ("model", "effort", "brief")} for s in doc["sessions"]],
            "replies": [{k: r[k] for k in ("event_id", "terra_run", "text", "sources", "received_at_ms")} for r in doc["replies"]],
            "problems": doc["problems"]}


def main():
    os.nice(10)  # this also runs during a live call
    data, call_id = Path(sys.argv[1]), sys.argv[2]
    doc = export(*discover(data, call_id))
    print(json.dumps(doc if "--full" in sys.argv else view(doc), ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
