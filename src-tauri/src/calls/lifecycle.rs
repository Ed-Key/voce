//! Startup deadlines also gate callbacks, so a late OS response cannot record.
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        mpsc, Arc,
    },
    time::{Duration, Instant},
};

const PENDING: u8 = 0;
const RECORDING: u8 = 1;
const CANCELLED: u8 = 2;

pub struct CapturePermit {
    state: AtomicU8,
    deadline: Instant,
}
impl CapturePermit {
    pub fn new(timeout: Duration) -> Arc<Self> {
        Arc::new(Self {
            state: AtomicU8::new(PENDING),
            deadline: Instant::now() + timeout,
        })
    }
    pub fn cancelled(&self) -> bool {
        self.state.load(Ordering::Acquire) == CANCELLED
            || (self.state.load(Ordering::Acquire) == PENDING && Instant::now() >= self.deadline)
    }
    pub fn commit(&self) -> Result<(), String> {
        if self.cancelled() {
            self.cancel();
            return Err("Call startup was cancelled or timed out".into());
        }
        self.state
            .compare_exchange(PENDING, RECORDING, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|_| "Call startup was cancelled".into())
    }
    pub fn can_record(&self) -> bool {
        self.state.load(Ordering::Acquire) == RECORDING
    }
    pub fn cancel(&self) {
        self.state.store(CANCELLED, Ordering::Release);
    }
}

/// Only one native start may be outstanding, including a timed-out OS call.
pub fn open_bounded<T: Send + 'static>(
    busy: &'static AtomicBool,
    permit: Arc<CapturePermit>,
    timeout: Duration,
    open: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    if busy
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("A previous system audio start is still waiting for macOS. Reopen Voce before retrying.".into());
    }
    let (sender, receiver) = mpsc::sync_channel(1);
    let worker_permit = permit.clone();
    let spawn = std::thread::Builder::new()
        .name("system-audio-start".into())
        .spawn(move || {
            struct Reset(&'static AtomicBool);
            impl Drop for Reset {
                fn drop(&mut self) {
                    self.0.store(false, Ordering::Release);
                }
            }
            let _reset = Reset(busy);
            let result = open();
            if worker_permit.cancelled() {
                drop(result);
                return;
            }
            // A disconnected receiver drops the native result and closes it here.
            let _ = sender.send(result);
        });
    if let Err(error) = spawn {
        busy.store(false, Ordering::Release);
        return Err(error.to_string());
    }
    match receiver.recv_timeout(timeout) {
        Ok(result) => result,
        Err(error) => {
            permit.cancel();
            Err(format!("System audio did not start: {error}. No call was started. Check Voce under System Audio Recording Only. After rebuilding, refresh that dev-app entry and reopen the app."))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pending_and_cancelled_capture_cannot_record() {
        let permit = CapturePermit::new(Duration::from_secs(1));
        assert!(!permit.can_record());
        permit.commit().unwrap();
        assert!(permit.can_record());
        permit.cancel();
        assert!(!permit.can_record());
        assert!(permit.commit().is_err());
    }
    #[test]
    fn expired_start_cannot_be_committed() {
        let permit = CapturePermit::new(Duration::ZERO);
        assert!(permit.commit().is_err());
        assert!(!permit.can_record());
    }
    #[test]
    fn timed_out_native_start_drops_late_result_and_limits_retries() {
        static BUSY: AtomicBool = AtomicBool::new(false);
        struct Resource(mpsc::Sender<()>);
        impl Drop for Resource {
            fn drop(&mut self) {
                let _ = self.0.send(());
            }
        }
        let (release, block) = mpsc::channel();
        let (dropped, observed) = mpsc::channel();
        let permit = CapturePermit::new(Duration::from_secs(1));
        let result = open_bounded(
            &BUSY,
            permit.clone(),
            Duration::from_millis(20),
            move || {
                block.recv().unwrap();
                Ok(Resource(dropped))
            },
        );
        assert!(result.is_err());
        assert!(permit.cancelled());
        assert!(BUSY.load(Ordering::Acquire));
        assert!(open_bounded(
            &BUSY,
            CapturePermit::new(Duration::from_secs(1)),
            Duration::from_millis(20),
            || Ok(())
        )
        .is_err());
        release.send(()).unwrap();
        observed.recv_timeout(Duration::from_secs(1)).unwrap();
    }
}
