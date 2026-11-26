"""Stand-in for handy-stream-asr in worker tests: the same pipe protocol, no model. Each loud 100 ms frame
adds a word to the open line (a guess); 1 s of quiet, a flush or a reset makes it final. FAKE_MODE in the
environment injects failures: crash:N (exit after N audio frames), crash_once:N (only while FAKE_MARK is
absent), hang:N (stop reading), garbage:N (a malformed line), badfield:N (a line without positions),
badtrack:N, badpong:N, farend:N (a final past the audio sent),
nextfile (on a later mic file, a final past that file's audio)."""
import json
import os
import struct
import sys

mode, _, limit = os.environ.get("FAKE_MODE", "").partition(":")
limit = int(limit or 0)
names = ["mic", "system"]
out = sys.stdout
fed, words, start, quiet, line = [0, 0], [[], []], [0, 0], [0, 0], [0, 0]
frames, resets, claimed = 0, 0, False


def send(**event):
    out.write(json.dumps(event) + "\n")
    out.flush()


def final(track):
    if words[track]:
        send(event="final", track=names[track], line=line[track], text=" ".join(words[track]), in_start=start[track], in_end=fed[track])
        line[track] += 1
    words[track], quiet[track] = [], 0


def read(n):
    data = sys.stdin.buffer.read(n)
    return data if len(data) == n else None


send(event="ready", chunk_ms=560)
with open(os.environ.get("FAKE_LOG", os.devnull), "a") as log:
    while (head := read(1)) is not None:
        kind = head[0]
        if kind == 4:
            final(0); final(1)
            break
        rest = read(5)
        if rest is None:
            break
        track, value = rest[0], struct.unpack("<I", rest[1:])[0]
        log.write(f"{kind} {names[track]} {value}\n"); log.flush()
        if kind == 1:
            body = read(value * 4)
            if body is None:
                break
            samples = struct.unpack(f"<{value}f", body)
            frames += 1
            if mode == "crash" and frames > limit:
                sys.exit(3)
            if mode == "crash_once" and frames > limit and not os.path.exists(os.environ["FAKE_MARK"]):
                open(os.environ["FAKE_MARK"], "w").close()
                sys.exit(3)
            if mode == "hang" and frames > limit:
                while True:
                    pass
            if mode == "garbage" and frames > limit:
                out.write("not json\n"); out.flush()
            if mode == "badfield" and frames > limit:
                send(event="guess", track="system", line=0, text="no positions")
            if mode == "badtrack" and frames > limit:
                send(event="guess", track=[], line=0, text="x", in_start=0, in_end=1)
            if mode == "badpong" and frames > limit:
                send(event="pong", track="mic", id=[])
            if mode == "nextfile" and track == 0 and resets >= 2 and not claimed:
                # on the second mic file: a final 3 s past this file's start, inside the cumulative mic audio
                send(event="final", track="mic", line=99, text="from the last file", in_start=0, in_end=48000)
                claimed = True
            if mode == "farend" and frames > limit:
                send(event="final", track="system", line=0, text="from the future", in_start=0, in_end=10 ** 12)
            fed[track] += value
            if max(abs(x) for x in samples) > 0.05:
                if not words[track]:
                    start[track] = max(0, fed[track] - value)
                words[track].append(f"{names[track][0]}{fed[track] // 1600}")
                quiet[track] = 0
                send(event="guess", track=names[track], line=line[track], text=" ".join(words[track]), in_start=start[track], in_end=fed[track])
            elif words[track]:
                quiet[track] += value
                if quiet[track] >= 16000:
                    final(track)
        elif kind in (2, 3):
            final(track)
            if kind == 3:
                fed[track] = 0
                resets += track == 0
            send(event="flushed", track=names[track], id=value)
        elif kind == 5:
            send(event="pong", track=names[track], id=value)
