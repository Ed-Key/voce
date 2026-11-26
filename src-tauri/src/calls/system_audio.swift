import Foundation
import CoreAudio
import AudioToolbox
import AVFoundation
import AppKit
import ApplicationServices

func nativeCallMask(_ identifier: String) -> UInt32 {
    switch identifier.lowercased() {
    case "com.hnc.discord", "com.hnc.discord.helper.renderer": return 1
    case "com.apple.facetime", "com.apple.avconferenced": return 2
    case "us.zoom.xos", "us.zoom.cpthost", "us.zoom.zoomhybridconf": return 4
    default: return 0
    }
}

func callBrowser(_ identifier: String) -> String? {
    let identifier = identifier.lowercased()
    return ["com.google.Chrome", "com.microsoft.edgemac", "com.brave.Browser", "com.apple.Safari"].first {
        identifier == $0.lowercased() || identifier.hasPrefix($0.lowercased() + ".")
    }
}

func browserMeetingMask(_ url: String) -> UInt32 {
    guard let parts = URLComponents(string: url), parts.scheme == "https", parts.user == nil,
          let host = parts.host?.lowercased() else { return 0 }
    if host == "meet.google.com", parts.path.range(of: "^/[a-z]{3}-[a-z]{4}-[a-z]{3}/?$", options: .regularExpression) != nil { return 8 }
    if (host == "zoom.us" || host.hasSuffix(".zoom.us")), parts.path.range(of: "^/wc/[0-9]+/(join|start)/?$", options: .regularExpression) != nil { return 4 }
    return 0
}

func isMeetingLeaveControl(_ label: String, service: UInt32) -> Bool {
    let label = label.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    // shortcut: English call controls only; add verified localized labels when needed.
    let names = service == 8 ? ["leave call"] : ["leave", "leave meeting", "leave call"]
    return names.contains { label == $0 || label.hasPrefix($0 + " (") }
}

private func axAttribute(_ element: AXUIElement, _ name: String) -> (AXError, CFTypeRef?) {
    AXUIElementSetMessagingTimeout(element, 0.05)
    var value: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return (status, value)
}

// Only inspect windows of a browser already using input. Never retain URLs or page text.
private func browserCallMask(_ identifier: String, deadline: UInt64) -> (UInt32, Bool) {
    guard AXIsProcessTrusted() else { return (0, false) }
    let apps = NSRunningApplication.runningApplications(withBundleIdentifier: identifier)
    guard !apps.isEmpty, apps.count <= 4 else { return (0, false) }
    var detected: UInt32 = 0
    for app in apps {
        guard DispatchTime.now().uptimeNanoseconds < deadline else { return (detected, false) }
        let root = AXUIElementCreateApplication(app.processIdentifier)
        let (status, value) = axAttribute(root, kAXWindowsAttribute)
        guard status == .success, let windows = value as? [AXUIElement], windows.count <= 8 else { return (detected, false) }
        var stack = windows.map { ($0, UInt32(0), 0) }
        var visited = 0
        while let (element, inheritedService, depth) = stack.popLast() {
            guard DispatchTime.now().uptimeNanoseconds < deadline, visited < 512, depth < 32 else { return (detected, false) }
            visited += 1
            let (roleStatus, roleValue) = axAttribute(element, kAXRoleAttribute)
            guard roleStatus == .success, let role = roleValue as? String else { return (detected, false) }
            var service = inheritedService
            if role == "AXWebArea" {
                let (urlStatus, urlValue) = axAttribute(element, kAXURLAttribute)
                guard urlStatus == .success else { return (detected, false) }
                let url = (urlValue as? URL)?.absoluteString ?? (urlValue as? String) ?? ""
                service = browserMeetingMask(url)
                if service == 0 { continue }
            }
            if service != 0, detected & service != 0 { continue }
            if service != 0, role == kAXButtonRole as String {
                for name in [kAXDescriptionAttribute, kAXTitleAttribute, kAXHelpAttribute] {
                    let (labelStatus, label) = axAttribute(element, name)
                    if labelStatus == .cannotComplete || labelStatus == .invalidUIElement { return (detected, false) }
                    if let label = label as? String, isMeetingLeaveControl(label, service: service) { detected |= service }
                }
            }
            AXUIElementSetMessagingTimeout(element, 0.05)
            var children: CFArray?
            let childStatus = AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0, 64, &children)
            if childStatus == .attributeUnsupported || childStatus == .noValue { continue }
            guard childStatus == .success, let values = children as? [AXUIElement], values.count < 64 else { return (detected, false) }
            stack.append(contentsOf: values.reversed().map { ($0, service, depth + 1) })
        }
    }
    return (detected, true)
}

// Reads activity metadata only. This path never opens an audio device or tap.
@_cdecl("handy_call_activity")
func handyCallActivity(_ mask: UnsafeMutablePointer<UInt32>, _ input: UnsafeMutablePointer<UInt32>) -> Int32 {
    mask.pointee = 0
    input.pointee = 0
    guard #available(macOS 14.2, *) else { return -1 }
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size = UInt32(MemoryLayout<UInt32>.size)
    var status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, input)
    guard status == noErr, input.pointee != kAudioObjectUnknown else { return status == noErr ? -1 : status }
    address.mSelector = kAudioHardwarePropertyProcessObjectList
    size = 0
    status = AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size)
    guard status == noErr else { return status }
    guard size % UInt32(MemoryLayout<AudioObjectID>.size) == 0, size <= 4096 * UInt32(MemoryLayout<AudioObjectID>.size) else { return -1 }
    var processes = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    if !processes.isEmpty {
        status = processes.withUnsafeMutableBytes { AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, $0.baseAddress!) }
        guard status == noErr else { return status }
    }
    var detected: UInt32 = 0
    var browsers = Set<String>()
    for process in processes.prefix(Int(size) / MemoryLayout<AudioObjectID>.size) {
        var running: UInt32 = 0
        size = UInt32(MemoryLayout<UInt32>.size)
        address.mSelector = kAudioProcessPropertyIsRunningInput
        status = AudioObjectGetPropertyData(process, &address, 0, nil, &size, &running)
        // A vanished process is an unknown observation, never proof of hang-up.
        guard status == noErr else { return status }
        guard running == 1 else { continue }
        var bundle: Unmanaged<CFString>?
        size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        address.mSelector = kAudioProcessPropertyBundleID
        status = AudioObjectGetPropertyData(process, &address, 0, nil, &size, &bundle)
        guard status == noErr else { return status }
        guard let bundle else { return -1 }
        let identifier = (bundle.takeRetainedValue() as String).lowercased()
        detected |= nativeCallMask(identifier)
        if let browser = callBrowser(identifier) { browsers.insert(browser) }
    }
    let deadline = DispatchTime.now().uptimeNanoseconds + 600_000_000
    for browser in browsers.sorted() {
        let (browserMask, complete) = browserCallMask(browser, deadline: deadline)
        // A failed or bounded-out AX read is unknown, never evidence of hang-up.
        guard complete else { return -2 }
        detected |= browserMask
    }
    mask.pointee = detected
    return noErr
}

typealias CallAudioSink = @convention(c) (UnsafePointer<Float>?, UInt32, UInt64, UnsafeMutableRawPointer?) -> Void

@available(macOS 14.4, *)
private final class SystemAudioTap {
    var tap: AudioObjectID = 0
    var device: AudioObjectID = 0
    var io: AudioDeviceIOProcID?
    let sink: CallAudioSink
    let context: UnsafeMutableRawPointer?
    var rate: Double = 0
    let baseTime = mach_absolute_time()
    var timebase = mach_timebase_info_data_t()

    init(_ sink: @escaping CallAudioSink, _ context: UnsafeMutableRawPointer?) {
        self.sink = sink
        self.context = context
    }
    func check(_ status: OSStatus, _ operation: String) throws {
        if status != noErr { throw NSError(domain: "HandyCalls", code: Int(status), userInfo: [NSLocalizedDescriptionKey: "\(operation) failed (\(status)). Check System Audio Recording permission."]) }
    }
    func frameOffset(_ host: UInt64) -> UInt64 {
        let ticks = host >= baseTime ? host - baseTime : 0
        return UInt64(Double(ticks) * Double(timebase.numer) / Double(timebase.denom) * rate / 1_000_000_000)
    }
    func start() throws {
        mach_timebase_info(&timebase)
        let description = CATapDescription(monoGlobalTapButExcludeProcesses: [])
        description.name = "Voce system audio"
        description.isPrivate = true
        description.muteBehavior = .unmuted
        try check(AudioHardwareCreateProcessTap(description, &tap), "Create system audio tap")
        var address = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyFormat, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var format = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        try check(AudioObjectGetPropertyData(tap, &address, 0, nil, &size, &format), "Read tap format")
        guard format.mFormatID == kAudioFormatLinearPCM, format.mFormatFlags & kAudioFormatFlagIsFloat != 0, format.mBitsPerChannel == 32, format.mChannelsPerFrame == 1 else {
            throw NSError(domain: "HandyCalls", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unsupported system audio format. Recording was not started."])
        }
        rate = format.mSampleRate
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Voce private capture",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: description.uuid.uuidString]]
        ]
        try check(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &device), "Create private audio device")
        try check(AudioDeviceCreateIOProcIDWithBlock(&io, device, nil) { [self] _, data, time, _, _ in
            let buffer = data.pointee.mBuffers
            guard let bytes = buffer.mData, buffer.mDataByteSize > 0 else { return }
            sink(bytes.assumingMemoryBound(to: Float.self), buffer.mDataByteSize / 4, frameOffset(time.pointee.mHostTime), context)
        }, "Install system audio callback")
        try check(AudioDeviceStart(device, io), "Start system audio")
    }
    func stop() {
        if device != 0 {
            if let io { AudioDeviceStop(device, io); AudioDeviceDestroyIOProcID(device, io); sink(nil, 0, frameOffset(mach_absolute_time()), context) }
            AudioHardwareDestroyAggregateDevice(device)
            device = 0
        }
        if tap != 0 { AudioHardwareDestroyProcessTap(tap); tap = 0 }
    }
}

@_cdecl("handy_call_tap_start")
func handyCallTapStart(_ sink: @escaping CallAudioSink, _ context: UnsafeMutableRawPointer?, _ rate: UnsafeMutablePointer<Double>, _ error: UnsafeMutablePointer<CChar>, _ capacity: Int32) -> UnsafeMutableRawPointer? {
    guard #available(macOS 14.4, *) else { return nil }
    let tap = SystemAudioTap(sink, context)
    do {
        try tap.start()
        rate.pointee = tap.rate
        return Unmanaged.passRetained(tap).toOpaque()
    } catch let failure {
        tap.stop()
        failure.localizedDescription.withCString { message in _ = strlcpy(error, message, Int(capacity)) }
        return nil
    }
}

@_cdecl("handy_call_tap_stop")
func handyCallTapStop(_ pointer: UnsafeMutableRawPointer) {
    if #available(macOS 14.4, *) {
        let tap = Unmanaged<SystemAudioTap>.fromOpaque(pointer).takeRetainedValue()
        tap.stop()
    }
}

// A read-only preflight. This never opens a microphone or requests a grant.
@_cdecl("handy_call_microphone_authorized")
func handyCallMicrophoneAuthorized() -> Bool {
    AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
}
