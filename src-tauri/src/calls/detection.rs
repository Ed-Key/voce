//! Read-only native call hints. Detection never starts or stops capture.
use super::{MicState, Ownership};
use serde::{Deserialize, Serialize};
use std::{
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant, SystemTime},
};

const STALE_AFTER: Duration = Duration::from_secs(4);
const SETTLE: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum CallApp {
    Discord,
    FaceTime,
    Zoom,
    GoogleMeet,
}

#[derive(Clone, Default, Serialize, specta::Type)]
pub struct DetectionSnapshot {
    pub available: bool,
    pub apps: Vec<CallApp>,
    pub possible_end: bool,
    pub dictating: bool,
}

#[derive(Clone, Default)]
struct Context {
    session_id: Option<String>,
    app: Option<CallApp>,
    mic_state: MicState,
    dictating: bool,
}
impl Context {
    fn from_owner(owner: &Ownership) -> Self {
        Self {
            session_id: owner
                .call_active
                .then(|| owner.session_id.clone())
                .flatten(),
            app: owner.detected_app,
            mic_state: owner.mic_state,
            dictating: owner.dictating,
        }
    }
}

struct Observation {
    apps: Vec<CallApp>,
    input_device: u32,
}
#[derive(Default)]
struct Detector {
    snapshot: DetectionSnapshot,
    observed: Option<Instant>,
    wall: Option<SystemTime>,
    input_device: Option<u32>,
    context: Context,
    hold_until: Option<Instant>,
    absent_since: Option<Instant>,
}
impl Detector {
    fn observe(
        &mut self,
        observation: Result<Observation, ()>,
        context: Context,
        now: Instant,
        wall: SystemTime,
    ) {
        let interrupted = self.observed.is_none_or(|previous| {
            let monotonic_gap = now.saturating_duration_since(previous);
            let wall_gap = self
                .wall
                .and_then(|previous| wall.duration_since(previous).ok());
            monotonic_gap > STALE_AFTER
                || wall_gap.is_none_or(|gap| gap.abs_diff(monotonic_gap) > Duration::from_secs(2))
        });
        self.observed = Some(now);
        self.wall = Some(wall);
        self.snapshot = DetectionSnapshot {
            dictating: context.dictating,
            ..Default::default()
        };
        let changed_session =
            self.context.session_id != context.session_id || self.context.app != context.app;
        let was_guarded = self.context.dictating || self.context.mic_state != MicState::Live;
        self.context = context;
        let Ok(observation) = observation else {
            self.absent_since = None;
            self.hold_until = Some(now + SETTLE);
            return;
        };
        let changed_device = self.input_device != Some(observation.input_device);
        self.input_device = Some(observation.input_device);
        self.snapshot.available = true;
        self.snapshot.apps = observation.apps;
        if interrupted || changed_device || changed_session || was_guarded {
            self.hold_until = Some(now + SETTLE);
            self.absent_since = None;
        }
        let guarded = self.context.dictating
            || self.context.mic_state != MicState::Live
            || self.context.session_id.is_none()
            || self.hold_until.is_some_and(|deadline| now < deadline);
        let Some(app) = self.context.app else {
            self.absent_since = None;
            return;
        };
        if guarded || self.snapshot.apps.contains(&app) {
            self.absent_since = None;
            return;
        }
        let since = self.absent_since.get_or_insert(now);
        self.snapshot.possible_end = now.saturating_duration_since(*since) >= SETTLE;
    }
    fn snapshot(&self, now: Instant) -> DetectionSnapshot {
        if self
            .observed
            .is_none_or(|at| now.saturating_duration_since(at) > STALE_AFTER)
        {
            return DetectionSnapshot::default();
        }
        self.snapshot.clone()
    }
}

pub struct CallDetector {
    shared: Arc<Mutex<Detector>>,
    ownership: Arc<Mutex<Ownership>>,
    stop: mpsc::Sender<()>,
}
impl CallDetector {
    pub fn new(ownership: Arc<Mutex<Ownership>>) -> Result<Self, String> {
        let shared = Arc::new(Mutex::new(Detector::default()));
        let worker_shared = shared.clone();
        let worker_ownership = ownership.clone();
        let (stop, receiver) = mpsc::channel();
        std::thread::Builder::new()
            .name("call-activity".into())
            .spawn(move || loop {
                // Never hold the dictation coordinator lock across an OS read.
                let observation = read_activity();
                let Ok(owner) = worker_ownership.lock() else {
                    break;
                };
                let context = Context::from_owner(&owner);
                let cadence = if owner.call_active { 500 } else { 2000 };
                drop(owner);
                let Ok(mut detector) = worker_shared.lock() else {
                    break;
                };
                detector.observe(observation, context, Instant::now(), SystemTime::now());
                drop(detector);
                match receiver.recv_timeout(Duration::from_millis(cadence)) {
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    _ => break,
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(Self {
            shared,
            ownership,
            stop,
        })
    }
    pub fn snapshot(&self) -> DetectionSnapshot {
        let Ok(owner) = self.ownership.lock() else {
            return DetectionSnapshot::default();
        };
        let Ok(detector) = self.shared.lock() else {
            return DetectionSnapshot::default();
        };
        let mut snapshot = detector.snapshot(Instant::now());
        snapshot.dictating = owner.dictating;
        if !owner.call_active
            || owner.dictating
            || owner.mic_state != MicState::Live
            || owner.session_id != detector.context.session_id
            || owner
                .permit
                .as_ref()
                .is_none_or(|permit| permit.cancelled())
        {
            snapshot.possible_end = false;
        }
        snapshot
    }
    pub fn candidate(&self) -> Option<CallApp> {
        let snapshot = self.snapshot();
        if snapshot.available && !snapshot.dictating && snapshot.apps.len() == 1 {
            snapshot.apps.first().copied()
        } else {
            None
        }
    }
}
impl Drop for CallDetector {
    fn drop(&mut self) {
        let _ = self.stop.send(());
    }
}

fn read_activity() -> Result<Observation, ()> {
    let mut mask = 0;
    let mut input_device = 0;
    let status = unsafe { handy_call_activity(&mut mask, &mut input_device) };
    if status != 0 {
        return Err(());
    }
    Ok(Observation {
        apps: apps_from_mask(mask),
        input_device,
    })
}

fn apps_from_mask(mask: u32) -> Vec<CallApp> {
    let mut apps = Vec::with_capacity(4);
    if mask & 1 != 0 {
        apps.push(CallApp::Discord);
    }
    if mask & 2 != 0 {
        apps.push(CallApp::FaceTime);
    }
    if mask & 4 != 0 {
        apps.push(CallApp::Zoom);
    }
    if mask & 8 != 0 {
        apps.push(CallApp::GoogleMeet);
    }
    apps
}
extern "C" {
    fn handy_call_activity(mask: *mut u32, input_device: *mut u32) -> i32;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn meeting_masks_and_serialized_names_match_the_frontend() {
        assert_eq!(apps_from_mask(4), vec![CallApp::Zoom]);
        assert_eq!(apps_from_mask(8), vec![CallApp::GoogleMeet]);
        assert_eq!(apps_from_mask(15).len(), 4);
        assert!(apps_from_mask(16).is_empty());
        assert_eq!(serde_json::to_string(&CallApp::Zoom).unwrap(), "\"zoom\"");
        assert_eq!(
            serde_json::to_string(&CallApp::GoogleMeet).unwrap(),
            "\"google_meet\""
        );
    }

    #[test]
    fn browser_and_zoom_calls_keep_handoff_and_unknown_read_guards() {
        for app in [CallApp::GoogleMeet, CallApp::Zoom] {
            let mut detector = Detector::default();
            let base = Instant::now();
            let live = Context {
                app: Some(app),
                ..context()
            };
            for second in 0..25 {
                observe(&mut detector, base, second, live.clone(), vec![app], 1);
            }
            assert!(!detector.snapshot.possible_end);
            let dictating = Context {
                dictating: true,
                mic_state: MicState::Yielded,
                ..live.clone()
            };
            missing_for(&mut detector, base, 25, 50, dictating, 1);
            assert!(!detector.snapshot.possible_end);
            detector.observe(
                Err(()),
                live.clone(),
                base + Duration::from_secs(51),
                SystemTime::UNIX_EPOCH + Duration::from_secs(51),
            );
            assert!(!detector.snapshot.available);
            missing_for(&mut detector, base, 52, 60, live.clone(), 1);
            assert!(!detector.snapshot.possible_end);
            missing_for(&mut detector, base, 61, 80, live, 1);
            assert!(detector.snapshot.possible_end);
        }
    }
    fn context() -> Context {
        Context {
            session_id: Some("first".into()),
            app: Some(CallApp::Discord),
            mic_state: MicState::Live,
            dictating: false,
        }
    }
    fn observe(
        detector: &mut Detector,
        base: Instant,
        second: u64,
        context: Context,
        apps: Vec<CallApp>,
        device: u32,
    ) {
        detector.observe(
            Ok(Observation {
                apps,
                input_device: device,
            }),
            context,
            base + Duration::from_secs(second),
            SystemTime::UNIX_EPOCH + Duration::from_secs(second),
        );
    }
    fn missing_for(
        detector: &mut Detector,
        base: Instant,
        start: u64,
        end: u64,
        context: Context,
        device: u32,
    ) {
        for second in start..=end {
            observe(detector, base, second, context.clone(), vec![], device);
        }
    }
    #[test]
    fn absence_is_advisory_and_returning_activity_clears_it() {
        let mut detector = Detector::default();
        let base = Instant::now();
        missing_for(&mut detector, base, 0, 19, context(), 1);
        assert!(!detector.snapshot.possible_end);
        observe(&mut detector, base, 20, context(), vec![], 1);
        assert!(detector.snapshot.possible_end);
        observe(
            &mut detector,
            base,
            21,
            context(),
            vec![CallApp::Discord],
            1,
        );
        assert!(!detector.snapshot.possible_end);
        assert!(!detector.snapshot(base + Duration::from_secs(26)).available);
    }
    #[test]
    fn dictation_and_resume_never_count_as_call_absence() {
        let mut detector = Detector::default();
        let base = Instant::now();
        missing_for(&mut detector, base, 0, 19, context(), 1);
        let dictating = Context {
            dictating: true,
            mic_state: MicState::Yielded,
            ..context()
        };
        missing_for(&mut detector, base, 20, 45, dictating, 1);
        assert!(!detector.snapshot.possible_end);
        let starting = Context {
            mic_state: MicState::Starting,
            ..context()
        };
        missing_for(&mut detector, base, 46, 55, starting, 1);
        missing_for(&mut detector, base, 56, 75, context(), 1);
        assert!(!detector.snapshot.possible_end);
        observe(&mut detector, base, 76, context(), vec![], 1);
        assert!(detector.snapshot.possible_end);
    }
    #[test]
    fn failed_monitor_route_change_wake_and_new_session_reset_absence() {
        let mut detector = Detector::default();
        let base = Instant::now();
        missing_for(&mut detector, base, 0, 20, context(), 1);
        assert!(detector.snapshot.possible_end);
        detector.observe(
            Err(()),
            context(),
            base + Duration::from_secs(21),
            SystemTime::UNIX_EPOCH + Duration::from_secs(21),
        );
        assert!(!detector.snapshot.available);
        missing_for(&mut detector, base, 22, 30, context(), 1);
        assert!(!detector.snapshot.possible_end);
        missing_for(&mut detector, base, 31, 50, context(), 2);
        assert!(!detector.snapshot.possible_end);
        observe(&mut detector, base, 51, context(), vec![], 2);
        assert!(detector.snapshot.possible_end);
        // A wall-clock jump also catches sleep when the platform uptime clock pauses.
        detector.observe(
            Ok(Observation {
                apps: vec![],
                input_device: 2,
            }),
            context(),
            base + Duration::from_secs(52),
            SystemTime::UNIX_EPOCH + Duration::from_secs(152),
        );
        assert!(!detector.snapshot.possible_end);
        let next = Context {
            session_id: Some("second".into()),
            ..context()
        };
        observe(&mut detector, base, 53, next, vec![], 2);
        assert!(!detector.snapshot.possible_end);
        let failed = Context {
            mic_state: MicState::Failed,
            ..context()
        };
        missing_for(&mut detector, base, 54, 85, failed, 2);
        assert!(!detector.snapshot.possible_end);
    }
    #[test]
    fn unbound_manual_recordings_have_no_end_hint() {
        let mut detector = Detector::default();
        let base = Instant::now();
        missing_for(
            &mut detector,
            base,
            0,
            60,
            Context {
                app: None,
                ..context()
            },
            1,
        );
        assert!(!detector.snapshot.possible_end);
    }
    #[test]
    fn current_ownership_suppresses_a_hint_before_the_next_poll() {
        let permit = super::super::CapturePermit::new(Duration::from_secs(1));
        permit.commit().unwrap();
        let ownership = Arc::new(Mutex::new(Ownership {
            call_active: true,
            session_id: Some("first".into()),
            mic_state: MicState::Live,
            permit: Some(permit.clone()),
            ..Default::default()
        }));
        let shared = Arc::new(Mutex::new(Detector {
            snapshot: DetectionSnapshot {
                available: true,
                apps: vec![CallApp::Discord],
                possible_end: true,
                dictating: false,
            },
            observed: Some(Instant::now()),
            context: context(),
            ..Default::default()
        }));
        let (stop, _receiver) = mpsc::channel();
        let detector = CallDetector {
            shared,
            ownership: ownership.clone(),
            stop,
        };
        assert!(detector.snapshot().possible_end);
        assert_eq!(detector.candidate(), Some(CallApp::Discord));
        ownership.lock().unwrap().acquire().unwrap();
        assert!(!detector.snapshot().possible_end);
        assert_eq!(detector.candidate(), None);
        ownership.lock().unwrap().release();
        ownership.lock().unwrap().mic_state = MicState::Starting;
        assert!(!detector.snapshot().possible_end);
        ownership.lock().unwrap().mic_state = MicState::Live;
        ownership.lock().unwrap().session_id = Some("replacement".into());
        assert!(!detector.snapshot().possible_end);
        ownership.lock().unwrap().session_id = Some("first".into());
        permit.cancel();
        assert!(!detector.snapshot().possible_end);
        detector
            .shared
            .lock()
            .unwrap()
            .snapshot
            .apps
            .push(CallApp::FaceTime);
        assert_eq!(detector.candidate(), None);
    }
}
