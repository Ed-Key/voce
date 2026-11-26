// Pure parts of the sidecar (no model): the pipe protocol and the line endpoint rule, so both are testable
// without the Neural Engine.
import Foundation

public let sampleRate = 16000

/// Commands on stdin, little-endian:
///   1 audio: track u8, count u32, count x float32 (16 kHz mono)
///   2 flush: track u8, id u32   (finalize the open line, then report `flushed`)
///   3 reset: track u8, id u32   (flush, then fresh recognizer state and input position 0)
///   4 stop                      (flush both tracks, exit 0)
///   5 ping:  track u8, id u32   (answered with `pong` once everything before it on that track is done)
public enum Command: Equatable {
    case audio(track: Int, samples: [Float])
    case flush(track: Int, id: UInt32)
    case reset(track: Int, id: UInt32)
    case stop
    case ping(track: Int, id: UInt32)
}

public enum ProtocolError: Error, Equatable {
    case unknownKind(UInt8)
    case badTrack(UInt8)
    case tooLarge(UInt32)
}

/// Largest audio frame accepted (10 s): the worker sends 100 ms, so anything bigger is a framing error.
public let maxFrameSamples: UInt32 = 160_000

/// Reads one command with `read(n)`, which returns exactly n bytes or nil at end of input.
/// A command cut short by end of input returns nil like a clean end: the worker is gone either way.
public func readCommand(_ read: (Int) -> Data?) throws -> Command? {
    guard let head = read(1) else { return nil }
    let kind = head[head.startIndex]
    if kind == 4 { return .stop }
    guard kind >= 1 && kind <= 5 else { throw ProtocolError.unknownKind(kind) }
    guard let rest = read(5) else { return nil }
    let bytes = [UInt8](rest)
    guard bytes[0] <= 1 else { throw ProtocolError.badTrack(bytes[0]) }
    let track = Int(bytes[0])
    let value = UInt32(bytes[1]) | UInt32(bytes[2]) << 8 | UInt32(bytes[3]) << 16 | UInt32(bytes[4]) << 24
    switch kind {
    case 1:
        guard value <= maxFrameSamples else { throw ProtocolError.tooLarge(value) }
        guard let body = read(Int(value) * 4) else { return nil }
        let samples = body.withUnsafeBytes { raw in
            (0..<Int(value)).map { Float(bitPattern: raw.loadUnaligned(fromByteOffset: $0 * 4, as: UInt32.self).littleEndian) }
        }
        return .audio(track: track, samples: samples)
    case 2: return .flush(track: track, id: value)
    case 3: return .reset(track: track, id: value)
    default: return .ping(track: track, id: value)
    }
}

/// The bake-off endpoint rule, on input samples (not wall time): a line is final once its text has not
/// changed for 1.0 s of fed audio, or for 0.3 s once the line is 6 s old, or at 12 s regardless.
/// Positions are input samples since the track's last reset; they are exact, unlike model token times,
/// which drift because every finish pads the last chunk with silence.
public struct Endpointer {
    public static let endpoint = 16_000, shortPause = 4_800, longLine = 96_000, maxLine = 192_000

    public let chunk: Int  // model chunk in samples: text appears up to one chunk after its audio
    public private(set) var fed = 0
    public private(set) var shown = ""
    private var changedAt = 0
    private var startedAt = 0
    public private(set) var lineStart = 0
    public private(set) var lastEnd = 0

    public init(chunk: Int) { self.chunk = chunk }

    public enum Decision: Equatable {
        case none
        case guess(text: String, start: Int, end: Int)
        case finalize
    }

    /// Record `count` more fed samples and the model's current partial text.
    public mutating func observe(fed count: Int, partial: String) -> Decision {
        fed += count
        let text = partial.trimmingCharacters(in: .whitespacesAndNewlines)
        if text != shown {
            if shown.isEmpty {
                startedAt = fed
                lineStart = max(lastEnd, fed - chunk)
            }
            shown = text
            changedAt = fed
            if text.isEmpty { return .none }
            // A line that keeps growing is still cut at 12 s.
            return fed - startedAt >= Self.maxLine ? .finalize : .guess(text: text, start: lineStart, end: fed)
        }
        guard !shown.isEmpty else { return .none }
        let quiet = fed - changedAt, age = fed - startedAt
        if quiet >= Self.endpoint || (age >= Self.longLine && quiet >= Self.shortPause) || age >= Self.maxLine {
            return .finalize
        }
        return .none
    }

    /// The model finished the line with `text`; returns (text, start, end) to publish, or nil when there
    /// is nothing to say. Starts the next line at the current input position.
    public mutating func finished(_ text: String) -> (text: String, start: Int, end: Int)? {
        let final = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let start = shown.isEmpty ? max(lastEnd, fed - chunk) : lineStart
        shown = ""
        lastEnd = fed
        return final.isEmpty ? nil : (final, start, fed)
    }

    /// Fresh recognizer: input positions restart at 0.
    public mutating func reset() { self = Endpointer(chunk: chunk) }
}

/// One JSON line for stdout.
public func jsonLine(_ object: [String: Any]) -> Data {
    var data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    data.append(0x0A)
    return data
}
