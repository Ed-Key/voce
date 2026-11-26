"""Terra's memory: facts the user reviewed, kept on this Mac. Only current entries ever reach Terra.

Entries move waiting -> current -> past (replaced, never sent), or to dismissed (lost a conflict, may
return) or rejected (a tombstone keeps it from being proposed again). The brief is built when Terra
starts, so nothing can go stale between a change here and what Terra reads.
"""
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import sys
import time

BUDGET = 28672        # bytes of memory Terra gets; speed is rechecked with each raise
MAX_ENTRY = 4096       # one entry can never fill the budget alone
MAX_IMPORT = 30        # a large import must not flood the tray
MAX_WAITING = 60       # the tray has to stay small enough to open and to read
MAX_RIVALS = 3         # conflicts shown per waiting entry
MAX_IMPORT_BYTES = 1 << 20
GROUPS = {"you": "About you", "story": "Stories", "project": "Projects", "person": "People"}
ORDER = list(GROUPS)
MAX_NAME = 60
SUBJECT = re.compile(r"(person|project):[^\n]{0,60}")
DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
# From the bake-off, plus anything that looks like a street address. The user's rule: a planted address is an
# instant fail even when quoted with a warning, so these cannot be approved as they stand.
INSTRUCTION = re.compile(r"(?<![\w-])assistant\s*([,:]|(please|must|should|always|never|ignore|tell|say|do)\b)|\b(remember that|ignore (previous|all|your)|from now on|note for)\b", re.I)
CONTACT = re.compile(r"https?://|\S+@\S+\.\w+|\b\d{1,5}\s+\w+(\s\w+)?\s+(street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr)\b", re.I)
# The user's rule: other people's health, family, money and feelings stay out.
PRIVATE = re.compile(r"\b(health|illness|diagnosed|\w+['’]s diagnosis|diagnosis (is|was)|therapy|pregnan\w+|divorce\w*|salary|debt|depress\w+|anxiety|anxious|stressed|grieving)\b", re.I)
SCHEMA = """
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, grp TEXT NOT NULL, subject TEXT NOT NULL, key TEXT NOT NULL, text TEXT NOT NULL,
  hash TEXT NOT NULL, sources TEXT NOT NULL, state TEXT NOT NULL, flags TEXT NOT NULL,
  imported_at INTEGER, approved_at INTEGER, replaced_by INTEGER);
CREATE INDEX IF NOT EXISTS entries_by_key ON entries(subject, key, state);
CREATE TABLE IF NOT EXISTS rejected (hash TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT);
"""


def now():
    return int(time.time() * 1000)


def text_hash(subject, text):
    return hashlib.sha256(f"{subject}\0{' '.join(text.split()).casefold()}".encode()).hexdigest()


def flags_for(text):
    """Imports only. Stories about the user can carry other people's details, so nothing is exempt."""
    flags = []
    if INSTRUCTION.search(text):
        flags.append("instruction")
    if CONTACT.search(text):
        flags.append("contact")
    if PRIVATE.search(text):
        flags.append("private")
    return flags


def checked_text(text):
    if not isinstance(text, str) or not text.strip():
        raise ValueError("Write something first")
    text = text.strip()
    if len(text.encode()) > MAX_ENTRY:
        raise ValueError("This entry is too long")
    return text


def open_store(root):
    path = Path(root) / "memory.sqlite3"
    if path.is_symlink():
        raise ValueError("Memory store must not be linked")
    db = sqlite3.connect(str(path), timeout=2, isolation_level=None)
    db.row_factory = sqlite3.Row
    path.chmod(0o600)
    db.executescript(SCHEMA)
    db.execute("BEGIN IMMEDIATE")
    try:
        migrate(db, Path(root) / "companion-brief.md")
    except BaseException:
        db.execute("ROLLBACK")
        raise
    db.execute("COMMIT")
    return db


def migrate(db, brief):
    """The hand-written brief becomes one entry, in one piece, exactly once. The file is only read."""
    if db.execute("SELECT 1 FROM meta WHERE name='brief_migrated'").fetchone():
        return
    text = ""
    if brief.is_file() and not brief.is_symlink():
        text = brief.read_bytes().decode("utf-8", "ignore").strip()
    # Kept whole even past the entry limit: if it does not fit, the page says so and the user shortens it.
    if text:
        sources = json.dumps([{"origin": "brief", "excerpt": "", "source_date": None}])
        db.execute("INSERT INTO entries(grp,subject,key,text,hash,sources,state,flags,approved_at) VALUES "
                   "('you','you','original-brief',?,?,?,'current','[]',?)", (text, text_hash("you", text), sources, now()))
    db.execute("INSERT INTO meta VALUES ('brief_migrated','1')")


def entry(db, entry_id, *states):
    row = db.execute("SELECT * FROM entries WHERE id=?", (entry_id,)).fetchone()
    if row is None or row["state"] not in states:
        raise ValueError("This entry changed; reload memory")
    return row


def promote(db, entry_id):
    """The one way an entry becomes current: its key's old value retires and rival proposals are dismissed."""
    row = db.execute("SELECT subject, key FROM entries WHERE id=?", (entry_id,)).fetchone()
    db.execute("UPDATE entries SET state='past', replaced_by=? WHERE subject=? AND key=? AND state='current' AND id<>?",
               (entry_id, row["subject"], row["key"], entry_id))
    db.execute("UPDATE entries SET state='dismissed' WHERE subject=? AND key=? AND state='waiting' AND id<>?",
               (row["subject"], row["key"], entry_id))
    db.execute("UPDATE entries SET state='current', flags='[]', approved_at=? WHERE id=?", (now(), entry_id))


def add(db, value):
    group = value.get("group")
    if group not in GROUPS:
        raise ValueError("Unknown memory group")
    text = checked_text(value.get("text"))
    name = " ".join(str(value.get("name") or "").split())[:MAX_NAME]
    subject = "you" if group in ("you", "story") else f"{group}:{name}"
    write(db, group, subject, f"ed-{now()}-{text_hash(subject, text)[:8]}", text)


def write(db, group, subject, key, text):
    """The user's own words: they clear any tombstone and become current at once."""
    digest = text_hash(subject, text)
    db.execute("DELETE FROM rejected WHERE hash=?", (digest,))
    sources = json.dumps([{"origin": "ed", "excerpt": "", "source_date": time.strftime("%Y-%m-%d")}])
    entry_id = db.execute("INSERT INTO entries(grp,subject,key,text,hash,sources,state,flags) VALUES (?,?,?,?,?,?,'waiting','[]')",
                          (group, subject, key, text, digest, sources)).lastrowid
    promote(db, entry_id)


def approve(db, value):
    row = entry(db, value.get("id"), "waiting")
    if json.loads(row["flags"]):
        raise ValueError("Edit this entry before approving it")
    promote(db, row["id"])


def reject(db, value):
    row = entry(db, value.get("id"), "waiting", "current")
    db.execute("INSERT OR IGNORE INTO rejected VALUES (?)", (row["hash"],))
    # Only the fingerprint stays, so a deleted fact really is gone, older values of it included.
    keys = db.execute("SELECT DISTINCT subject, key FROM entries WHERE hash=?", (row["hash"],)).fetchall()
    db.execute("DELETE FROM entries WHERE hash=?", (row["hash"],))
    for key in keys:
        db.execute("DELETE FROM entries WHERE subject=? AND key=? AND state='past'", (key["subject"], key["key"]))


def edit(db, value):
    row = entry(db, value.get("id"), "waiting", "current")
    text = checked_text(value.get("text"))
    # Imports are held to the rules; a current entry is already the user's own words.
    if row["state"] == "current":
        # The entry keeps its id, so a click queued behind this save still finds it.
        db.execute("INSERT INTO entries(grp,subject,key,text,hash,sources,state,flags,approved_at,replaced_by) "
                   "SELECT grp,subject,key,text,hash,sources,'past',flags,approved_at,id FROM entries WHERE id=?", (row["id"],))
        digest = text_hash(row["subject"], text)
        db.execute("DELETE FROM rejected WHERE hash=?", (digest,))
        sources = json.dumps([{"origin": "ed", "excerpt": "", "source_date": time.strftime("%Y-%m-%d")}])
        db.execute("UPDATE entries SET text=?, hash=?, sources=? WHERE id=?", (text, digest, sources, row["id"]))
        promote(db, row["id"])
        return
    if flags_for(f"{row['subject']} {text}"):
        raise ValueError("Edit this entry before approving it")
    db.execute("UPDATE entries SET text=?, hash=? WHERE id=?", (text, text_hash(row["subject"], text), row["id"]))
    promote(db, row["id"])


def propose(db, value):
    """One-way import: a list of {group, subject, key, text, excerpt, source, source_date, replaces?, flags?}."""
    items = value.get("entries")
    if not isinstance(items, list) or len(items) > MAX_IMPORT:
        raise ValueError(f"An import takes at most {MAX_IMPORT} entries")
    if db.execute("SELECT COUNT(*) FROM entries WHERE state='waiting'").fetchone()[0] + len(items) > MAX_WAITING:
        raise ValueError("Clear the waiting entries first")
    added = merged = dropped = 0
    for item in items:
        group, subject, key, source = (item.get(name) for name in ("group", "subject", "key", "source"))
        if group not in GROUPS or not all(isinstance(v, str) and v for v in (subject, key, source)):
            raise ValueError("An import entry is missing a field")
        if len(source) > MAX_NAME or len(key) > MAX_NAME * 2:
            raise ValueError("An import entry has a bad source")
        text = checked_text(item.get("text"))
        date = item.get("source_date")
        if date is not None and not valid_date(date):
            raise ValueError("An import entry has a bad date")
        if subject != "you" and not SUBJECT.fullmatch(subject):
            raise ValueError("An import entry has a bad subject")
        replaces = item.get("replaces")
        if replaces is not None:
            target = entry(db, replaces, "current")
            subject, key = target["subject"], target["key"]
        digest = text_hash(subject, text)
        if db.execute("SELECT 1 FROM rejected WHERE hash=?", (digest,)).fetchone():
            dropped += 1
            continue
        origin = {"origin": source, "excerpt": str(item.get("excerpt") or "")[:400], "source_date": date}
        flags = sorted(set(flags_for(f"{subject} {text}")) | set(item.get("flags") or []))
        same = db.execute("SELECT id, sources, flags, state FROM entries WHERE hash=? AND state IN ('waiting','current')", (digest,)).fetchone()
        if same:
            sources = json.loads(same["sources"])
            if same["state"] == "waiting":  # a later source's warning must not be lost
                db.execute("UPDATE entries SET flags=? WHERE id=?", (json.dumps(sorted(set(json.loads(same["flags"])) | set(flags))), same["id"]))
            if not any(s["origin"] == source for s in sources):
                db.execute("UPDATE entries SET sources=? WHERE id=?", (json.dumps(sources + [origin]), same["id"]))
                merged += 1
            continue
        db.execute("INSERT INTO entries(grp,subject,key,text,hash,sources,state,flags,imported_at) VALUES (?,?,?,?,?,?,'waiting',?,?)",
                   (group, subject, key, text, digest, json.dumps([origin]), json.dumps(flags), now()))
        added += 1
    return {"added": added, "merged": merged, "dropped": dropped}


def line(row):
    dates = [s["source_date"] for s in json.loads(row["sources"]) if s.get("source_date")]
    name = row["subject"].split(":", 1)[-1] if ":" in row["subject"] else ""
    text = f"{name}: {row['text']}" if name and not re.match(re.escape(name) + r"\b", row["text"]) else row["text"]
    return f"- {text}" + (f" (as of {weekday(max(dates))})" if dates else "")


def valid_date(date):
    try:
        return bool(isinstance(date, str) and DATE.fullmatch(date) and time.strptime(date, "%Y-%m-%d"))
    except ValueError:
        return False


def weekday(date):
    """The user wants the weekday with every date."""
    return time.strftime("%a %Y-%m-%d", time.strptime(date, "%Y-%m-%d"))


def build(db):
    """(brief, ids left out). Whole entries only, in a fixed order, so the same memory gives the same brief."""
    rows = db.execute("SELECT * FROM entries WHERE state='current' ORDER BY approved_at DESC, id DESC").fetchall()
    rows.sort(key=lambda row: ORDER.index(row["grp"]))
    kept, left_out = [], []
    for row in rows:
        if len(render(kept + [row]).encode()) <= BUDGET:
            kept.append(row)
        else:
            left_out.append(row["id"])
    return render(kept), left_out


def render(rows):
    blocks = []
    for group in ORDER:
        lines = [line(row) for row in rows if row["grp"] == group]
        if lines:
            blocks.append(GROUPS[group] + ":\n" + "\n".join(lines))
    return "\n\n".join(blocks)


def compile(root):
    """What Terra reads at start. Raises rather than hand Terra something unchecked."""
    db = open_store(root)
    try:
        db.execute("BEGIN")
        brief, _ = build(db)
        db.execute("COMMIT")
        return brief
    finally:
        db.close()


def view(row, conflicts, was=None):
    return {"id": row["id"], "group": row["grp"], "subject": row["subject"], "text": row["text"], "state": row["state"],
            "sources": json.loads(row["sources"]), "flags": json.loads(row["flags"]), "conflicts": conflicts, "was": was}


def listing(db):
    brief, left_out = build(db)
    rows = db.execute("SELECT * FROM entries WHERE state IN ('waiting','current') ORDER BY approved_at DESC, id DESC").fetchall()
    current = {(r["subject"], r["key"]): r for r in rows if r["state"] == "current"}
    waiting, kept = [], []
    for row in rows:
        if row["state"] == "waiting":
            rivals = [r for r in rows if r["id"] != row["id"] and (r["subject"], r["key"]) == (row["subject"], row["key"])]
            rivals.sort(key=lambda r: r["state"] != "current")
            waiting.append(view(row, [view(r, []) for r in rivals[:MAX_RIVALS]]))
        else:
            before = db.execute("SELECT text FROM entries WHERE replaced_by=? AND state='past' ORDER BY id DESC", (row["id"],)).fetchone()
            kept.append(view(row, [], before["text"] if before else None))
    waiting.sort(key=lambda item: item["id"])
    return {"waiting": waiting, "current": kept, "brief": brief, "size": len(brief.encode()), "budget": BUDGET, "left_out": left_out}


COMMANDS = {"add": add, "approve": approve, "reject": reject, "delete": reject, "edit": edit, "propose": propose}


def run(root, command, value):
    db = open_store(root)
    try:
        if command == "list":
            db.execute("BEGIN")
            result = listing(db)
            db.execute("COMMIT")
            return result
        if command == "check":
            return {"size": len(build(db)[0].encode())}
        action = COMMANDS.get(command)
        if action is None:
            raise ValueError("Unknown memory command")
        db.execute("BEGIN IMMEDIATE")
        try:
            done = action(db, value)
            result = done if done is not None else listing(db)  # a change that cannot be shown is not saved
        except BaseException:
            db.execute("ROLLBACK")
            raise
        db.execute("COMMIT")
        return result
    finally:
        db.close()


def main():
    root, command = sys.argv[1], sys.argv[2]
    try:
        data = sys.stdin.buffer.read(MAX_IMPORT_BYTES + 1)
        if len(data) > MAX_IMPORT_BYTES:
            raise ValueError("Memory command is too large")
        print(json.dumps(run(root, command, json.loads(data or b"{}")), ensure_ascii=False))
    except Exception as error:  # noqa: BLE001 - the app shows this message
        print(json.dumps({"error": str(error)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
