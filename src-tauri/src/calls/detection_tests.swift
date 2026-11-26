import Foundation

// Compile with system_audio.swift to exercise the native classification boundary.
@main struct CallDetectionTests {
    static func main() {
        assert(nativeCallMask("us.zoom.xos") == 4)
        assert(nativeCallMask("us.zoom.CptHost") == 4)
        assert(nativeCallMask("us.zoom.ZoomHybridConf") == 4)
        assert(nativeCallMask("us.zoom.ZoomPhone") == 0)
        assert(nativeCallMask("us.zoom.xos.fake") == 0)
        assert(callBrowser("com.google.Chrome.helper.renderer") == "com.google.Chrome")
        assert(callBrowser("com.google.chromeevil") == nil)
        assert(browserMeetingMask("https://meet.google.com/abc-defg-hij?authuser=0") == 8)
        assert(browserMeetingMask("https://meet.google.com/") == 0)
        assert(browserMeetingMask("https://meet.google.com.evil.test/abc-defg-hij") == 0)
        assert(browserMeetingMask("https://meet.google.com@evil.test/abc-defg-hij") == 0)
        assert(browserMeetingMask("http://meet.google.com/abc-defg-hij") == 0)
        assert(browserMeetingMask("https://us02web.zoom.us/wc/123456789/join") == 4)
        assert(browserMeetingMask("https://evilzoom.us/wc/123456789/join") == 0)
        assert(browserMeetingMask("https://zoom.us/j/123456789") == 0)
        assert(isMeetingLeaveControl("Leave call", service: 8))
        assert(isMeetingLeaveControl("Leave call (⌘ + W)", service: 8))
        assert(!isMeetingLeaveControl("Join now", service: 8))
        assert(!isMeetingLeaveControl("Leave feedback", service: 8))
        assert(isMeetingLeaveControl("Leave", service: 4))
        assert(!isMeetingLeaveControl("Leave", service: 8))
        print("Native call detection classification checks passed")
    }
}
