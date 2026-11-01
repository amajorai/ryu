//! COM apartment and UI Automation session lifetime.
//!
//! [`ComGuard`] balances `CoInitializeEx`/`CoUninitialize` on every exit path, and
//! [`UiaSession`] holds the one `IUIAutomation` and `ControlViewWalker` a call uses,
//! so walks never create an automation object per node.

use std::sync::mpsc;
use std::time::{Duration, Instant};

use ::windows::core::Interface;
use ::windows::Win32::Foundation::{S_FALSE, S_OK};
use ::windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use ::windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomation2, IUIAutomationTreeWalker,
};

use crate::contract::{Delivery, GhostError};

/// Initializes an STA on the current thread; uninitializes on drop only when this
/// guard's `CoInitializeEx` succeeded (`S_OK` or `S_FALSE`). `RPC_E_CHANGED_MODE`
/// (the thread already lives in an MTA) leaves the apartment alone; UIA still works.
pub(crate) struct ComGuard {
    initialized: bool,
}

impl ComGuard {
    pub(crate) fn sta() -> Self {
        // SAFETY: plain COM initialization of the calling thread; balanced in Drop.
        let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        Self {
            initialized: hr == S_OK || hr == S_FALSE,
        }
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.initialized {
            // SAFETY: paired with the successful CoInitializeEx in `sta`.
            unsafe { CoUninitialize() };
        }
    }
}

/// One automation object and one control-view walker, created once per call and
/// passed down. Must be dropped before the [`ComGuard`] of its thread (declare the
/// guard first so it drops last).
pub(crate) struct UiaSession {
    pub automation: IUIAutomation,
    pub walker: IUIAutomationTreeWalker,
}

impl UiaSession {
    pub(crate) fn new() -> ::windows::core::Result<Self> {
        // SAFETY: COM is initialized on this thread by the caller's ComGuard.
        unsafe {
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
            let walker = automation.ControlViewWalker()?;
            Ok(Self { automation, walker })
        }
    }

    /// Bounds every cross-process call of this session by the time left until
    /// `deadline` (between [`MIN_CALL_MS`] and [`MAX_CALL_MS`]), so a hung provider
    /// fails with `UIA_E_TIMEOUT` instead of UIA's ~20 s default. Best effort:
    /// before Windows 8 there is no `IUIAutomation2` and the defaults stay.
    pub(crate) fn bound_calls(&self, deadline: Instant) {
        let Ok(automation2) = self.automation.cast::<IUIAutomation2>() else {
            return;
        };
        let left = deadline
            .saturating_duration_since(Instant::now())
            .as_millis();
        let ms = u32::try_from(left)
            .unwrap_or(MAX_CALL_MS)
            .clamp(MIN_CALL_MS, MAX_CALL_MS);
        // SAFETY: plain setters on this thread's automation object.
        unsafe {
            let _ = automation2.SetConnectionTimeout(ms);
            let _ = automation2.SetTransactionTimeout(ms);
        }
    }

    /// [`UiaSession::new`] with the failure mapped to the error contract.
    pub(crate) fn open() -> Result<Self, GhostError> {
        Self::new().map_err(|e| {
            GhostError::internal(format!(
                "UI Automation is unavailable (HRESULT 0x{:08X})",
                e.code().0 as u32
            ))
        })
    }
}

/// Floor and ceiling of the per-call UIA timeouts set by [`UiaSession::bound_calls`].
const MIN_CALL_MS: u32 = 250;
const MAX_CALL_MS: u32 = 20_000;

/// Extra time the waiting side allows past the action deadline so the worker can
/// report its own TIMEOUT (with the right delivery) before being abandoned.
const REPORT_GRACE: Duration = Duration::from_millis(500);

/// Runs `work` on a dedicated thread inside its own STA and UIA session, waiting
/// until `deadline` (plus a short grace). On timeout the thread is abandoned, since
/// a provider call such as `Invoke` can block on a modal dialog, and the result is
/// `TIMEOUT` with `DeliveryUncertain`.
pub(crate) fn run_on_sta_thread<T, F>(deadline: Instant, work: F) -> Result<T, GhostError>
where
    T: Send + 'static,
    F: FnOnce(&UiaSession) -> Result<T, GhostError> + Send + 'static,
{
    run_bounded(deadline, Delivery::DeliveryUncertain, work)
}

/// [`run_on_sta_thread`] for read-only work (snapshots, finds, hit tests): a
/// timeout delivered nothing.
pub(crate) fn read_on_sta_thread<T, F>(deadline: Instant, work: F) -> Result<T, GhostError>
where
    T: Send + 'static,
    F: FnOnce(&UiaSession) -> Result<T, GhostError> + Send + 'static,
{
    run_bounded(deadline, Delivery::NotDelivered, work)
}

fn run_bounded<T, F>(deadline: Instant, on_timeout: Delivery, work: F) -> Result<T, GhostError>
where
    T: Send + 'static,
    F: FnOnce(&UiaSession) -> Result<T, GhostError> + Send + 'static,
{
    let (tx, rx) = mpsc::channel();
    let spawned = std::thread::Builder::new()
        .name("ghost-uia-worker".into())
        .spawn(move || {
            let _com = ComGuard::sta();
            let result = UiaSession::open().and_then(|session| {
                session.bound_calls(deadline);
                work(&session)
            });
            let _ = tx.send(result);
        });
    if spawned.is_err() {
        return Err(GhostError::internal(
            "could not start the UI Automation worker",
        ));
    }
    let wait = deadline.saturating_duration_since(Instant::now()) + REPORT_GRACE;
    match rx.recv_timeout(wait) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => Err(GhostError::timeout(
            "the UI Automation provider did not answer before the deadline",
            on_timeout,
        )
        .with_suggestion("the app may be showing a modal dialog; take a new snapshot")),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(GhostError::internal(
            "the UI Automation worker stopped unexpectedly",
        )),
    }
}
