import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import {
  BookOpen,
  Briefcase,
  ChevronDown,
  Hourglass,
  Send,
  UserRound,
  Users,
  X,
} from "lucide-react";

type Group = "you" | "story" | "project" | "person";

interface Source {
  origin: string;
  excerpt: string;
  source_date: string | null;
}

interface Entry {
  id: number;
  group: Group;
  subject: string;
  text: string;
  state: string;
  sources: Source[];
  flags: string[];
  conflicts: Entry[];
  was: string | null;
}

interface Memory {
  waiting: Entry[];
  current: Entry[];
  brief: string;
  size: number;
  budget: number;
  left_out: number[];
}

const GROUPS: { group: Group; Icon: typeof Users }[] = [
  { group: "you", Icon: UserRound },
  { group: "story", Icon: BookOpen },
  { group: "project", Icon: Briefcase },
  { group: "person", Icon: Users },
];
const KB = (bytes: number) => (bytes / 1024).toFixed(1);
// The name beside a fact, unless the fact already opens with it.
const named = ({ subject, text }: Entry) => {
  const name = subject.split(":")[1] ?? "";
  return text.startsWith(`${name} `) ? "" : name;
};

/** One fact, edited where it sits, as in the Observatory mockup. Enter saves and Escape cancels. */
function Tile({
  entry,
  leftOut,
  onSave,
  onDelete,
}: {
  entry: Entry;
  leftOut: boolean;
  onSave: (text: string) => Promise<boolean>;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [unsaved, setUnsaved] = useState(false);
  const source = entry.sources[0];
  return (
    <div
      className={`tile ${leftOut || unsaved ? "left-out" : ""}`}
      title={[
        unsaved ? t("memory.unsaved") : "",
        leftOut ? t("memory.notSent") : "",
        source
          ? t("memory.from", {
              origin: t(`memory.origin.${source.origin}`, {
                defaultValue: source.origin,
              }),
              date: source.source_date ?? t("memory.unknownDate"),
            })
          : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {named(entry) && <span className="k">{named(entry)}</span>}
      <span
        className="v"
        role="textbox"
        aria-label={t("memory.entry")}
        tabIndex={0}
        spellCheck={false}
        contentEditable="plaintext-only"
        suppressContentEditableWarning
        onBlur={(event) => {
          const now = event.currentTarget.textContent?.trim() ?? "";
          if (now && now !== entry.text)
            void onSave(now).then((saved) => setUnsaved(!saved));
          else {
            event.currentTarget.textContent = entry.text;
            setUnsaved(false);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            event.currentTarget.textContent = entry.text;
            event.currentTarget.blur();
          }
        }}
      >
        {entry.text}
      </span>
      {entry.was && <span className="was">{entry.was}</span>}
      <button
        className="tile-delete"
        aria-label={t("memory.delete")}
        title={t("memory.delete")}
        // Keeps focus in the tile, so a half edit is dropped instead of racing the delete.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onDelete}
      >
        <X />
      </button>
    </div>
  );
}

function Editor({
  initial,
  askName,
  onSave,
  onCancel,
}: {
  initial: string;
  askName?: boolean;
  onSave: (text: string, name: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(initial);
  const [name, setName] = useState("");
  return (
    <div className="memory-editor">
      {askName && (
        <input
          value={name}
          aria-label={t("memory.name")}
          placeholder={t("memory.name")}
          onChange={(event) => setName(event.target.value)}
        />
      )}
      <textarea
        autoFocus={!askName}
        rows={Math.min(8, Math.max(2, Math.ceil(initial.length / 44)))}
        value={text}
        aria-label={t("memory.newEntry")}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
      />
      <div className="acts">
        <button
          className="keep"
          disabled={!text.trim()}
          onClick={() => onSave(text, name)}
        >
          {t("memory.save")}
        </button>
        <button onClick={onCancel}>{t("memory.cancel")}</button>
      </div>
    </div>
  );
}

function SourceLine({ entry }: { entry: Entry }) {
  const { t } = useTranslation();
  return (
    <div className="calm">
      {entry.sources
        .map((source) =>
          t("memory.from", {
            origin: t(`memory.origin.${source.origin}`, {
              defaultValue: source.origin,
            }),
            date: source.source_date ?? t("memory.unknownDate"),
          }),
        )
        .join(" · ")}
    </div>
  );
}

/** Everything Terra knows about the user. Nothing here reaches Terra until he keeps it. */
export function MemoryPage() {
  const { t } = useTranslation();
  const [memory, setMemory] = useState<Memory | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<number | Group | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const send = useCallback(
    (command: string, payload: object = {}) => {
      // One at a time and in order: a save and the click after it must both happen.
      const done = queue.current.then(async () => {
        try {
          const reply = await invoke<string>("memory_command", {
            command,
            payload: JSON.stringify(payload),
          });
          setMemory(JSON.parse(reply));
          // A refresh must not close an editor the user is typing in.
          if (command !== "list") {
            setEditing(null);
            setError("");
          }
          return true;
        } catch (failure) {
          setError(t("memory.failed", { reason: String(failure) }));
          return false;
        }
      });
      queue.current = done;
      return done;
    },
    [t],
  );

  useEffect(() => {
    const refresh = () => void send("list");
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [send]);

  const sent = memory ? memory.current.length - memory.left_out.length : 0;
  return (
    <section className="call-notepad">
      <div className="obs">
        <header className="top">
          <h1>{t("memory.title")}</h1>
          {memory && <span className="pill">{memory.current.length}</span>}
        </header>
        {error && (
          <p className="memory-error" role="alert">
            {error}
          </p>
        )}
        {memory && (
          <div className="mem">
            <div className="groups">
              {GROUPS.map(({ group, Icon }) => (
                <div className={`group ${group}`} key={group}>
                  <h3>
                    <Icon />
                    {t(`memory.group.${group}`)}
                  </h3>
                  <div className="tiles">
                    {memory.current
                      .filter((entry) => entry.group === group)
                      .map((entry) => (
                        <Tile
                          key={entry.id}
                          entry={entry}
                          leftOut={memory.left_out.includes(entry.id)}
                          onSave={(text) =>
                            send("edit", { id: entry.id, text })
                          }
                          onDelete={() => void send("delete", { id: entry.id })}
                        />
                      ))}
                    {editing !== group && (
                      <button
                        className="tile add"
                        aria-label={t("memory.addTo", {
                          group: t(`memory.group.${group}`),
                        })}
                        onClick={() => setEditing(group)}
                      >
                        {t("memory.add")}
                      </button>
                    )}
                  </div>
                  {editing === group && (
                    <Editor
                      initial=""
                      askName={group === "person" || group === "project"}
                      onSave={(text, name) =>
                        void send("add", { group, text, name })
                      }
                      onCancel={() => setEditing(null)}
                    />
                  )}
                </div>
              ))}
            </div>
            <div className="side">
              <div>
                <h3>
                  <Hourglass />
                  {t("memory.waiting")}
                </h3>
                {!memory.waiting.length && (
                  <div className="calm">{t("memory.nothingWaiting")}</div>
                )}
                {memory.waiting.map((entry) =>
                  editing === entry.id ? (
                    <Editor
                      key={entry.id}
                      initial={entry.text}
                      onSave={(text) =>
                        void send("edit", { id: entry.id, text })
                      }
                      onCancel={() => setEditing(null)}
                    />
                  ) : (
                    <div className="hold" key={entry.id}>
                      <div>
                        {named(entry) && (
                          <span className="calm">{named(entry)} </span>
                        )}
                        <b>{entry.text}</b>
                      </div>
                      <SourceLine entry={entry} />
                      {entry.flags.map((flag) => (
                        <div className="calm" key={flag}>
                          {t(`memory.flag.${flag}`)}
                        </div>
                      ))}
                      {entry.conflicts.map((other) => (
                        <div className="memory-conflict" key={other.id}>
                          <div className="calm">
                            {t(
                              other.state === "current"
                                ? "memory.conflictNow"
                                : "memory.conflictOther",
                            )}
                          </div>
                          <div>{other.text}</div>
                          <SourceLine entry={other} />
                        </div>
                      ))}
                      <div className="acts">
                        <button
                          className="keep"
                          disabled={!!entry.flags.length}
                          onClick={() => void send("approve", { id: entry.id })}
                        >
                          {t("memory.keep")}
                        </button>
                        <button onClick={() => setEditing(entry.id)}>
                          {t("memory.edit")}
                        </button>
                        <button
                          onClick={() => void send("reject", { id: entry.id })}
                        >
                          {t("memory.discard")}
                        </button>
                      </div>
                    </div>
                  ),
                )}
              </div>
              <div>
                <h3>
                  <Send />
                  {t("memory.sent")}
                </h3>
                <details>
                  <summary>
                    <span className="mono">
                      {t("memory.size", {
                        used: KB(memory.size),
                        count: sent,
                      })}
                    </span>
                    <ChevronDown />
                  </summary>
                  <pre className="brief">{memory.brief}</pre>
                </details>
                {!!memory.left_out.length && (
                  <p className="memory-error" role="status">
                    {t("memory.leftOut", { count: memory.left_out.length })}
                  </p>
                )}
                <div className="calm memory-note">{t("memory.intro")}</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
