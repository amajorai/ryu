//! Window acquisition for a [`WindowTarget`] and the snapshot walk.

use ::windows::Win32::Foundation::{CloseHandle, BOOL, E_ACCESSDENIED, HWND, LPARAM, STILL_ACTIVE};
use ::windows::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use ::windows::Win32::UI::Accessibility::IUIAutomationElement;
use ::windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetForegroundWindow, GetWindow, GetWindowTextW, GetWindowThreadProcessId,
    IsWindowVisible, GW_OWNER,
};
use serde_json::json;

use super::super::limits::WalkBudget;
use super::super::{pick_window_title, window_pick_error, TitlePick};
use super::super::{AXSnapshot, RendererA11y, SnapshotOptions, WindowTarget};
use super::com::UiaSession;
use super::hresult::{to_error, Phase};
use super::walk::walk_element;
use crate::contract::{ErrorCode, GhostError};

/// A top-level window of a process.
struct TopWindow {
    hwnd: HWND,
    title: String,
}

fn window_pid(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    // SAFETY: plain user32 query with a valid out pointer.
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid
}

fn window_title(hwnd: HWND) -> String {
    let mut buf = [0u16; 512];
    // SAFETY: the buffer outlives the call; the length is bounded by it.
    let len = unsafe { GetWindowTextW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..usize::try_from(len).unwrap_or(0).min(buf.len())])
}

struct EnumState {
    pid: u32,
    windows: Vec<TopWindow>,
}

unsafe extern "system" fn collect_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
    // SAFETY: lparam is the `EnumState` passed by `process_windows`, alive for the call.
    let state = unsafe { &mut *(lparam.0 as *mut EnumState) };
    // SAFETY: user32 queries on an enumerated window handle.
    let visible = unsafe { IsWindowVisible(hwnd).as_bool() };
    let unowned = unsafe { GetWindow(hwnd, GW_OWNER) }.is_err();
    if visible && unowned && window_pid(hwnd) == state.pid {
        state.windows.push(TopWindow {
            hwnd,
            title: window_title(hwnd),
        });
    }
    BOOL(1)
}

/// The visible, unowned top-level windows of `pid`, in z-order.
fn process_windows(pid: u32) -> Vec<TopWindow> {
    let mut state = EnumState {
        pid,
        windows: Vec::new(),
    };
    // SAFETY: the callback only dereferences `state`, which outlives EnumWindows.
    let _ = unsafe { EnumWindows(Some(collect_window), LPARAM(&mut state as *mut _ as isize)) };
    state.windows
}

/// Whether `pid` names a running process (false when it cannot be opened at all).
pub(crate) fn process_alive(pid: u32) -> bool {
    // SAFETY: the handle is closed before returning.
    unsafe {
        let handle = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(h) => h,
            // Access denied still means the process exists; a missing pid fails with
            // ERROR_INVALID_PARAMETER.
            Err(e) => return e.code() == E_ACCESSDENIED,
        };
        let mut code = 0u32;
        let alive = GetExitCodeProcess(handle, &mut code).is_ok() && code == STILL_ACTIVE.0 as u32;
        let _ = CloseHandle(handle);
        alive
    }
}

/// The executable's file stem, e.g. `notepad`.
pub(crate) fn process_name(pid: u32) -> Option<String> {
    // SAFETY: the handle is closed before returning; the buffer outlives the call.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            ::windows::core::PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(handle);
        if !ok {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..(len as usize).min(buf.len())]);
        let file = path.rsplit(['\\', '/']).next()?.to_string();
        let stem = file
            .strip_suffix(".exe")
            .or_else(|| file.strip_suffix(".EXE"));
        Some(stem.unwrap_or(&file).to_string())
    }
}

fn no_window(pid: u32) -> GhostError {
    GhostError::new(
        ErrorCode::AppNotFound,
        "the process has no visible top-level window",
    )
    .with_details(json!({ "pid": pid }))
}

/// Title match (exact only when `strict`, see [`pick_window_title`]); on a miss a
/// single window is used, several are STALE_REF.
fn pick_by_title(pid: u32, title: &str, strict: bool) -> Result<HWND, GhostError> {
    let windows = process_windows(pid);
    let titles: Vec<Option<&str>> = windows.iter().map(|w| Some(w.title.as_str())).collect();
    match pick_window_title(&titles, title, strict).or_single_window() {
        TitlePick::Found(i) => Ok(windows[i].hwnd),
        TitlePick::Miss(0) => Err(no_window(pid)),
        other => Err(window_pick_error(other, i32::try_from(pid).unwrap_or(0))),
    }
}

/// The foreground window when it belongs to `pid`, else its first top-level window.
fn pick_for_pid(pid: u32) -> Result<HWND, GhostError> {
    // SAFETY: plain user32 query.
    let fg = unsafe { GetForegroundWindow() };
    if !fg.is_invalid() && window_pid(fg) == pid {
        return Ok(fg);
    }
    process_windows(pid)
        .first()
        .map(|w| w.hwnd)
        .ok_or_else(|| no_window(pid))
}

fn foreground() -> Result<HWND, GhostError> {
    // SAFETY: plain user32 query.
    let fg = unsafe { GetForegroundWindow() };
    if fg.is_invalid() {
        return Err(GhostError::new(
            ErrorCode::AppNotFound,
            "there is no foreground window",
        ));
    }
    Ok(fg)
}

fn process_exited(pid: i32) -> GhostError {
    GhostError::stale_ref("the process the snapshot was taken from has exited")
        .with_details(json!({ "reason": "process_exited", "snapshot_pid": pid }))
        .with_suggestion("take a new snapshot")
}

/// The window element for `target`, and its pid (from `CurrentProcessId`).
pub(crate) fn acquire_root(
    session: &UiaSession,
    target: &WindowTarget,
) -> Result<(IUIAutomationElement, i32), GhostError> {
    let hwnd = match target {
        WindowTarget::Focused => foreground()?,
        // The frontmost app's windows, with the PidTitle rule on a title miss.
        WindowTarget::FocusedTitle { title } => {
            pick_by_title(window_pid(foreground()?), title, false)?
        }
        WindowTarget::Pid { pid } | WindowTarget::PidTitle { pid, .. } => {
            let upid = u32::try_from(*pid).map_err(|_| GhostError::invalid_args("invalid pid"))?;
            if !process_alive(upid) {
                return Err(process_exited(*pid));
            }
            match target {
                WindowTarget::PidTitle { title, .. } => pick_by_title(upid, title, true)?,
                _ => pick_for_pid(upid)?,
            }
        }
    };
    // SAFETY: COM calls on this thread's session.
    let root = unsafe { session.automation.ElementFromHandle(hwnd) }
        .map_err(|e| to_error(&e, "UIA.ElementFromHandle", Phase::Read))?;
    // SAFETY: COM property read.
    let pid = unsafe { root.CurrentProcessId() }
        .map_err(|e| to_error(&e, "UIA.CurrentProcessId", Phase::Read))?;
    Ok((root, pid))
}

/// Takes a snapshot of the window `opts.target` names.
pub(crate) fn snapshot_sync(
    session: &UiaSession,
    opts: &SnapshotOptions,
) -> Result<AXSnapshot, GhostError> {
    let (root_el, pid) = acquire_root(session, &opts.target)?;
    let mut budget = WalkBudget::start(opts.limits);
    let root = walk_element(session, &root_el, 0, &mut budget);
    let stats = budget.stats;
    Ok(AXSnapshot {
        pid,
        app_name: u32::try_from(pid).ok().and_then(process_name),
        window_title: root.title.clone(),
        complete: stats.complete(),
        stats,
        renderer: RendererA11y::NotApplicable,
        root,
    })
}
