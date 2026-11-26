// handy-stream-asr: live call transcription for the call worker.
//
//   handy-stream-asr --models <dir>     stream: commands on stdin, JSON lines on stdout (see StreamCore)
//   handy-stream-asr --download <dir>   fetch the 560 ms Core ML bundle into <dir>, print its folder, exit
//
// Streaming loads only from <dir> and never touches the network (the worker's sandbox denies it anyway).
// Output: {"event":"ready"}; {"event":"guess"|"final","track","line","text","in_start","in_end"};
// {"event":"flushed","track","id"}; {"event":"pong","track","id"}; {"event":"error","message"} before a
// nonzero exit.
// Stdin end of input exits at once, so the sidecar never outlives its worker.
import AVFoundation
import FluidAudio
import Foundation
import StreamCore

let names = ["mic", "system"]
let output = NSLock()

func send(_ object: [String: Any]) {
    output.lock()
    FileHandle.standardOutput.write(jsonLine(object))
    output.unlock()
}

func fail(_ message: String) -> Never {
    send(["event": "error", "message": message])
    exit(2)
}

/// One recognizer per track; commands for a track run strictly in order.
actor Track {
    let index: Int
    let manager: StreamingNemotronAsrManager
    let format: AVAudioFormat
    var endpointer: Endpointer
    var line = 0

    init(index: Int, manager: StreamingNemotronAsrManager, chunkSamples: Int) {
        self.index = index
        self.manager = manager
        self.format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(sampleRate), channels: 1, interleaved: false)!
        self.endpointer = Endpointer(chunk: chunkSamples)
    }

    func publish(_ kind: String, _ text: String, _ start: Int, _ end: Int) {
        send(["event": kind, "track": names[index], "line": line, "text": text, "in_start": start, "in_end": end])
    }

    func audio(_ samples: [Float]) async throws {
        guard !samples.isEmpty else { return }
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count))!
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { buffer.floatChannelData![0].update(from: $0.baseAddress!, count: samples.count) }
        _ = try await manager.process(audioBuffer: buffer)
        let partial = await manager.getPartialTranscript()
        switch endpointer.observe(fed: samples.count, partial: partial) {
        case .none: break
        case let .guess(text, start, end): publish("guess", text, start, end)
        case .finalize: try await finishLine()
        }
    }

    /// Decode what is buffered and close the line. The encoder cache carries on (no reset), as in the
    /// bake-off: the next line keeps the left context.
    func finishLine() async throws {
        let text = try await manager.finish()
        if let done = endpointer.finished(text) {
            publish("final", done.text, done.start, done.end)
            line += 1
        }
    }

    func flush(id: UInt32) async throws {
        try await finishLine()
        send(["event": "flushed", "track": names[index], "id": Int(id)])
    }

    func reset(id: UInt32) async throws {
        try await finishLine()
        await manager.reset()
        endpointer.reset()
        send(["event": "flushed", "track": names[index], "id": Int(id)])
    }
}

func loadManager(_ directory: URL) async throws -> StreamingNemotronAsrManager {
    // Local loading silently keeps the 2240 ms default when metadata.json is absent: require it.
    let metadata = directory.appendingPathComponent("metadata.json")
    guard let data = try? Data(contentsOf: metadata),
          let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          json["chunk_ms"] as? Int == 560
    else { fail("Model folder must hold the 560 ms Nemotron bundle with its metadata.json") }
    let manager = StreamingNemotronAsrManager(requestedChunkSize: .ms560)
    try await manager.loadModels(from: directory)
    guard await manager.config.chunkMs == 560 else { fail("Loaded model is not the 560 ms tier") }
    return manager
}

/// Blocking exact read from stdin; nil at end of input.
func readExactly(_ count: Int) -> Data? {
    var data = Data(capacity: count)
    while data.count < count {
        let piece = FileHandle.standardInput.readData(ofLength: count - data.count)
        if piece.isEmpty { return nil }
        data.append(piece)
    }
    return data
}

let args = CommandLine.arguments
guard args.count == 3 else { fail("usage: handy-stream-asr --models <dir> | --download <dir>") }
let folder = URL(fileURLWithPath: args[2], isDirectory: true)

if args[1] == "--download" {
    do {
        let manager = StreamingNemotronAsrManager(requestedChunkSize: .ms560)
        try await manager.loadModels(to: folder)
        send(["event": "downloaded", "folder": folder.appendingPathComponent("nemotron-streaming/560ms").path])
        exit(0)
    } catch { fail("Download failed: \(error)") }
}
guard args[1] == "--models" else { fail("usage: handy-stream-asr --models <dir> | --download <dir>") }

let tracks: [Track]
do {
    var made: [Track] = []
    for index in 0..<2 {
        let manager = try await loadManager(folder)
        made.append(Track(index: index, manager: manager, chunkSamples: await manager.config.chunkSamples))
    }
    tracks = made
} catch { fail("Model load failed: \(error)") }

// Each track drains its own ordered queue; the stdin reader only parses and routes.
var queues: [AsyncStream<Command>.Continuation] = []
var workers: [Task<Void, Never>] = []
for track in tracks {
    let (stream, continuation) = AsyncStream<Command>.makeStream(bufferingPolicy: .unbounded)
    queues.append(continuation)
    workers.append(Task {
        do {
            for await command in stream {
                switch command {
                case let .audio(_, samples): try await track.audio(samples)
                case let .flush(_, id): try await track.flush(id: id)
                case let .reset(_, id): try await track.reset(id: id)
                case .stop: try await track.finishLine()
                case let .ping(_, id): send(["event": "pong", "track": names[track.index], "id": Int(id)])
                }
            }
        } catch { fail("Recognizer failed on \(names[track.index]): \(error)") }
    })
}
send(["event": "ready", "chunk_ms": 560])
let running = workers, inputs = queues

let reader = Thread {
    while true {
        let command: Command?
        do { command = try readCommand(readExactly) } catch { fail("Bad command: \(error)") }
        switch command {
        case nil:
            exit(0)  // the worker is gone
        case .stop:
            inputs.forEach { $0.yield(.stop); $0.finish() }
            Task {
                for worker in running { await worker.value }
                exit(0)
            }
            return
        case let .audio(track, _), let .flush(track, _), let .reset(track, _), let .ping(track, _):
            inputs[track].yield(command!)
        }
    }
}
reader.start()
while true { try await Task.sleep(nanoseconds: 3_600_000_000_000) }
