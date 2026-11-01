//! Synthetic keyboard input: typing text, single key presses and hotkeys.
//!
//! Every key press goes through [`crate::policy`] first: the key and modifiers are
//! validated and canonicalized, the blocked-combo policy is applied (unless
//! `KeyOptions::force`), and the platform dispatcher sends exactly the checked
//! combo (`dispatch_key` plus each modifier's `dispatch_name`). Typed text is never
//! logged; only its character count.

use anyhow::Result;

use crate::policy::{check_hotkey, check_key, KeyCombo, KeyOptions};
#[cfg(target_os = "linux")]
use crate::policy::{KeyError, TargetOs};

#[cfg(any(target_os = "macos", test))]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod macos_keymap;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod win;

/// Type Unicode text into the focused element. `clear` selects all and deletes
/// first; that internal select-all bypasses the hotkey policy.
pub fn type_text(text: &str, clear: bool) -> Result<()> {
    tracing::debug!(chars = text.chars().count(), clear, "type_text");

    #[cfg(target_os = "windows")]
    return win::type_text(text, clear);

    #[cfg(target_os = "macos")]
    return macos::type_text(text, clear);

    #[cfg(target_os = "linux")]
    return crate::linux::type_text(text, clear).map_err(|e| redact_type_error(&e, text));

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = clear;
        Ok(())
    }
}

/// The frozen Linux backend lists the characters it could not type; never let
/// typed text escape into an error.
#[cfg(target_os = "linux")]
fn redact_type_error(err: &anyhow::Error, text: &str) -> anyhow::Error {
    let msg = err.to_string();
    if msg.starts_with("Cannot type ") {
        anyhow::anyhow!(
            "Cannot type some of the {} characters on the active X11 keyboard layout; nothing was typed",
            text.chars().count()
        )
    } else if msg.starts_with("X11 connect failed") {
        // Contains no typed text.
        anyhow::anyhow!("{msg}")
    } else {
        anyhow::anyhow!("type_text failed ({} characters)", text.chars().count())
    }
}

/// Press a single key with optional modifiers, policy-checked (`force = false`).
/// Key names: return/enter, tab, escape/esc, space, backspace, delete,
/// forwarddelete, home, end, pageup, pagedown, arrows, f1-f24, a modifier name,
/// or a single printable character.
pub fn press_key(key: &str, modifiers: &[&str]) -> Result<()> {
    press_key_with(key, modifiers, KeyOptions::default())
}

/// Press a key combination, e.g. `send_hotkey(&["ctrl", "c"])`. All but the last
/// entry are modifiers. An empty slice is an `Ok(())` no-op.
pub fn send_hotkey(keys: &[&str]) -> Result<()> {
    send_hotkey_with(keys, KeyOptions::default())
}

/// [`check_key`], then dispatch the checked combo. Errors are
/// `anyhow::Error::new(KeyError)` so callers can downcast.
pub fn press_key_with(key: &str, modifiers: &[&str], opts: KeyOptions) -> Result<()> {
    let combo = check_key(key, modifiers, opts).map_err(anyhow::Error::new)?;
    dispatch(&combo, opts, false)
}

/// [`check_hotkey`]; an empty slice is `Ok(())`, otherwise dispatch the checked combo.
pub fn send_hotkey_with(keys: &[&str], opts: KeyOptions) -> Result<()> {
    match check_hotkey(keys, opts).map_err(anyhow::Error::new)? {
        Some(combo) => dispatch(&combo, opts, true),
        None => Ok(()),
    }
}

/// Send a checked combo through the Windows dispatcher.
#[cfg(target_os = "windows")]
fn dispatch(combo: &KeyCombo, opts: KeyOptions, _as_hotkey: bool) -> Result<()> {
    win::press_combo(combo, opts)
}

/// Send a checked combo through the macOS dispatcher.
#[cfg(target_os = "macos")]
fn dispatch(combo: &KeyCombo, _opts: KeyOptions, _as_hotkey: bool) -> Result<()> {
    macos::press_combo(combo)
}

/// Send a checked combo through the (frozen) X11 backend: `linux::hotkey` for
/// hotkeys, `linux::press_key` for key presses, with dispatcher names only.
#[cfg(target_os = "linux")]
fn dispatch(combo: &KeyCombo, _opts: KeyOptions, as_hotkey: bool) -> Result<()> {
    // `linux.rs` maps only f1..f12; refuse rather than reach its error path.
    if crate::policy::function_key_number(&combo.key).is_some_and(|n| n > 12) {
        return Err(anyhow::Error::new(KeyError::UnknownKey(combo.key.clone())));
    }
    let os = TargetOs::Linux;
    let mut keys: Vec<&str> = combo
        .modifiers
        .iter()
        .map(|m| m.dispatch_name(os))
        .collect();
    if as_hotkey {
        keys.push(&combo.dispatch_key);
        crate::linux::hotkey(&keys)
    } else {
        crate::linux::press_key(&combo.dispatch_key, &keys)
    }
}

/// No input backend on this OS: validate and log the combo (never text).
#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn dispatch(combo: &KeyCombo, _opts: KeyOptions, _as_hotkey: bool) -> Result<()> {
    tracing::debug!(combo = %combo.display(), "press_key (no backend)");
    Ok(())
}

#[cfg(test)]
mod tests;
