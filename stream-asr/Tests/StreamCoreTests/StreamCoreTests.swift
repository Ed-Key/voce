import Foundation
import StreamCore
import XCTest

final class EndpointerTests: XCTestCase {
    let step = 1_600  // 100 ms, what the worker sends

    /// Feeds `steps` 100 ms steps with the given partial text; returns the decisions.
    func feed(_ e: inout Endpointer, _ steps: Int, _ text: String) -> [Endpointer.Decision] {
        (0..<steps).map { _ in e.observe(fed: step, partial: text) }
    }

    func testOneSecondWithoutNewTextFinalizes() {
        var e = Endpointer(chunk: 8_960)
        XCTAssertEqual(feed(&e, 20, "").filter { $0 != .none }, [])
        XCTAssertEqual(e.observe(fed: step, partial: "we should"), .guess(text: "we should", start: 33_600 - 8_960, end: 33_600))
        let quiet = feed(&e, 10, "we should")
        XCTAssertEqual(quiet.dropLast(), Array(repeating: .none, count: 9))
        XCTAssertEqual(quiet.last, .finalize)  // exactly 1.0 s after the last change
        let done = e.finished("We should.")!
        XCTAssertEqual(done.start, 33_600 - 8_960)
        XCTAssertEqual(done.end, 33_600 + 16_000)
    }

    func testShortPauseAfterSixSeconds() {
        var e = Endpointer(chunk: 8_960)
        var text = ""
        for i in 0..<60 {  // a word every 100 ms for 6 s
            text += "w\(i) "
            _ = e.observe(fed: step, partial: text)
        }
        let pause = feed(&e, 3, text)
        XCTAssertEqual(pause, [.none, .none, .finalize])
    }

    func testForcedFinalAtTwelveSeconds() {
        var e = Endpointer(chunk: 8_960)
        var text = "", decisions: [Endpointer.Decision] = []
        for i in 0..<130 {
            text += "w\(i) "
            decisions.append(e.observe(fed: step, partial: text))
            if decisions.last == .finalize { break }
        }
        // 12 s of line age (the line starts at the first step with text): finalize at step 121.
        XCTAssertEqual(decisions.count, 121)
    }

    func testManyLinesKeepExactInputPositions() {
        // Row 12: positions are input samples, so after many endpoints they still equal the audio fed.
        var e = Endpointer(chunk: 8_960)
        var previousEnd = 0, fedTotal = 0
        for line in 0..<200 {
            for _ in 0..<5 { _ = e.observe(fed: step, partial: ""); fedTotal += step }
            _ = e.observe(fed: step, partial: "line \(line)"); fedTotal += step
            while e.observe(fed: step, partial: "line \(line)") != .finalize { fedTotal += step }
            fedTotal += step
            let done = e.finished("line \(line)")!
            XCTAssertEqual(done.end, fedTotal)
            XCTAssertGreaterThanOrEqual(done.start, previousEnd)
            previousEnd = done.end
        }
        XCTAssertEqual(e.fed, fedTotal)
    }

    func testFlushWithoutTextPublishesNothing() {
        var e = Endpointer(chunk: 8_960)
        _ = feed(&e, 5, "")
        XCTAssertNil(e.finished("  "))
        XCTAssertEqual(e.finished("late word")!.start, 8_000)  // text that only appeared at finish
    }
}

final class ProtocolTests: XCTestCase {
    func reader(_ bytes: [UInt8]) -> (Int) -> Data? {
        var data = Data(bytes)
        return { n in
            guard data.count >= n else { return nil }
            let head = data.prefix(n)
            data = data.dropFirst(n)
            return Data(head)
        }
    }

    func le(_ v: UInt32) -> [UInt8] { [UInt8(v & 255), UInt8(v >> 8 & 255), UInt8(v >> 16 & 255), UInt8(v >> 24)] }

    func testAudioFlushResetStop() throws {
        let one = Float(0.5).bitPattern, two = Float(-1).bitPattern
        let read = reader([1, 1] + le(2) + le(one) + le(two) + [2, 0] + le(7) + [3, 1] + le(9) + [5, 0] + le(3) + [4])
        XCTAssertEqual(try readCommand(read), .audio(track: 1, samples: [0.5, -1]))
        XCTAssertEqual(try readCommand(read), .flush(track: 0, id: 7))
        XCTAssertEqual(try readCommand(read), .reset(track: 1, id: 9))
        XCTAssertEqual(try readCommand(read), .ping(track: 0, id: 3))
        XCTAssertEqual(try readCommand(read), .stop)
        XCTAssertNil(try readCommand(read))
    }

    func testPartialFrameIsEndOfInput() throws {
        XCTAssertNil(try readCommand(reader([1, 0] + le(4) + [0, 0, 0])))
        XCTAssertNil(try readCommand(reader([2, 0, 1])))
    }

    func testMalformedFramesAreErrors() {
        XCTAssertThrowsError(try readCommand(reader([9])))
        XCTAssertThrowsError(try readCommand(reader([2, 5] + le(1))))
        XCTAssertThrowsError(try readCommand(reader([1, 0] + le(10_000_000))))
    }
}
