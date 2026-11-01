//! Keyboard input policy: canonical key combos and the blocked-hotkey tables.
//!
//! Adapted from vercel-labs/agent-desktop (Apache-2.0), whose input backends refuse
//! session-ending or desktop-hijacking key combos (quit, log out, lock, app switch,
//! virtual-terminal switch) before they reach the OS. The tables and the superset
//! rule are reimplemented here; no code is copied.
//!
//! This module is pure: no FFI, no I/O. `keyboard::press_key_with` and
//! `keyboard::send_hotkey_with` call [`check_key`] / [`check_hotkey`] before any
//! event is synthesized, and dispatch exactly the [`KeyCombo`] that was checked.

use std::collections::BTreeSet;
use std::fmt;

use Modifier::{Alt, Ctrl, Meta, Shift};

/// A keyboard modifier. `Meta` is the platform logo key (Cmd on macOS, Win on
/// Windows, Super on Linux).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Modifier {
    /// cmd, command, super, win, windows, meta.
    Meta,
    /// ctrl, control.
    Ctrl,
    /// alt, option, opt.
    Alt,
    /// shift.
    Shift,
}

impl Modifier {
    /// Parse a modifier alias (already lowercased and trimmed).
    fn from_alias(name: &str) -> Option<Self> {
        Some(match name {
            "cmd" | "command" | "super" | "win" | "windows" | "meta" => Self::Meta,
            "ctrl" | "control" => Self::Ctrl,
            "alt" | "option" | "opt" => Self::Alt,
            "shift" => Self::Shift,
            _ => return None,
        })
    }

    /// The canonical (policy) name.
    pub const fn canonical(self) -> &'static str {
        match self {
            Self::Meta => "meta",
            Self::Ctrl => "ctrl",
            Self::Alt => "alt",
            Self::Shift => "shift",
        }
    }

    /// A name the platform dispatcher accepts: `macos_modifier_flags` and the
    /// macOS keymap (`cmd`, `ctrl`, `alt`, `shift`), Windows `name_to_vk`
    /// (`win`, …) and Linux `name_to_keysym` (`super`, …).
    pub const fn dispatch_name(self, os: TargetOs) -> &'static str {
        match (self, os) {
            (Self::Meta, TargetOs::Mac) => "cmd",
            (Self::Meta, TargetOs::Windows) => "win",
            (Self::Meta, TargetOs::Linux) => "super",
            (Self::Ctrl, _) => "ctrl",
            (Self::Alt, _) => "alt",
            (Self::Shift, _) => "shift",
        }
    }
}

/// The OS whose blocked-combo table and dispatcher names apply.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetOs {
    Mac,
    Windows,
    Linux,
}

impl TargetOs {
    /// The OS this crate was compiled for (non-Mac, non-Windows targets use Linux).
    pub const fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Mac
        } else if cfg!(target_os = "windows") {
            Self::Windows
        } else {
            Self::Linux
        }
    }
}

/// A canonical, policy-checked key combination.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyCombo {
    pub modifiers: BTreeSet<Modifier>,
    /// Canonical key used by the policy (`escape`=>`esc`, `return`=>`enter`,
    /// `backspace`|`del`|`delete`|`forwarddelete`=>`delete`).
    pub key: String,
    /// The name sent to the platform dispatcher; it always folds to `key`.
    pub dispatch_key: String,
}

/// Named (non-character) keys every dispatcher supports, besides `f1`..`f24` and
/// the modifier keys. Each entry is `(alias, canonical, dispatch)`.
const NAMED_KEYS: &[(&str, &str, &str)] = &[
    ("return", "enter", "return"),
    ("enter", "enter", "return"),
    ("escape", "esc", "escape"),
    ("esc", "esc", "escape"),
    ("tab", "tab", "tab"),
    ("space", "space", "space"),
    ("backspace", "delete", "backspace"),
    ("delete", "delete", "delete"),
    ("del", "delete", "delete"),
    ("forwarddelete", "delete", "forwarddelete"),
    ("home", "home", "home"),
    ("end", "end", "end"),
    ("pageup", "pageup", "pageup"),
    ("pagedown", "pagedown", "pagedown"),
    ("left", "left", "left"),
    ("right", "right", "right"),
    ("up", "up", "up"),
    ("down", "down", "down"),
];

/// `Some(n)` for `f1`..`f24`.
pub(crate) fn function_key_number(key: &str) -> Option<u8> {
    let digits = key.strip_prefix('f')?;
    if digits.is_empty() || digits.len() > 2 || digits.starts_with('0') {
        return None;
    }
    let n: u8 = digits.parse().ok()?;
    (1..=24).contains(&n).then_some(n)
}

/// Resolve a raw key name to `(canonical, dispatch)` for `os`.
fn canonical_key(raw: &str, os: TargetOs) -> Result<(String, String), KeyError> {
    if raw == " " {
        return Ok(("space".into(), "space".into()));
    }
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(KeyError::EmptyKey);
    }
    let lower = trimmed.to_lowercase();
    if let Some(m) = Modifier::from_alias(&lower) {
        return Ok((m.canonical().into(), m.dispatch_name(os).into()));
    }
    if let Some(&(_, canonical, dispatch)) = NAMED_KEYS.iter().find(|(a, _, _)| *a == lower) {
        // Linux `name_to_keysym` has no `forwarddelete`; its `delete` is forward delete.
        let dispatch = if dispatch == "forwarddelete" && os == TargetOs::Linux {
            "delete"
        } else {
            dispatch
        };
        return Ok((canonical.into(), dispatch.into()));
    }
    if function_key_number(&lower).is_some() {
        return Ok((lower.clone(), lower));
    }
    let mut chars = trimmed.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        if !c.is_control() && !c.is_whitespace() {
            let mut low = c.to_lowercase();
            let folded = match (low.next(), low.next()) {
                (Some(l), None) => l,
                _ => c,
            };
            let s = folded.to_string();
            return Ok((s.clone(), s));
        }
    }
    Err(KeyError::UnknownKey(trimmed.to_string()))
}

impl KeyCombo {
    /// Parse a key and its modifiers for the current OS. See [`KeyCombo::parse_for`].
    pub fn parse(key: &str, modifiers: &[&str]) -> Result<Self, KeyError> {
        Self::parse_for(key, modifiers, TargetOs::current())
    }

    /// Lowercases. A key that is a modifier name is always canonicalized to
    /// `meta`/`ctrl`/`alt`/`shift`. The key must be a named key every dispatcher
    /// supports, `f1`..`f24`, or a single printable character, else
    /// [`KeyError::UnknownKey`]. `dispatch_key` uses `os`'s dispatcher names.
    pub fn parse_for(key: &str, modifiers: &[&str], os: TargetOs) -> Result<Self, KeyError> {
        let mut mods = BTreeSet::new();
        for raw in modifiers {
            let lower = raw.trim().to_lowercase();
            let m = Modifier::from_alias(&lower)
                .ok_or_else(|| KeyError::UnknownModifier(raw.trim().to_string()))?;
            mods.insert(m);
        }
        let (key, dispatch_key) = canonical_key(key, os)?;
        Ok(Self {
            modifiers: mods,
            key,
            dispatch_key,
        })
    }

    /// All but the last entry are modifiers; the last is the key.
    pub fn from_keys(keys: &[&str]) -> Result<Self, KeyError> {
        match keys.split_last() {
            Some((key, modifiers)) => Self::parse(key, modifiers),
            None => Err(KeyError::EmptyKey),
        }
    }

    /// `"meta+shift+q"`: modifiers in canonical order, then the key.
    pub fn display(&self) -> String {
        let mut parts: Vec<&str> = self.modifiers.iter().map(|m| m.canonical()).collect();
        parts.push(&self.key);
        parts.join("+")
    }
}

/// One blocked-combo entry: blocked iff `combo.key == key && modifiers ⊆ combo.modifiers`.
struct BlockedEntry {
    modifiers: &'static [Modifier],
    key: &'static str,
    reason: &'static str,
}

const fn entry(
    modifiers: &'static [Modifier],
    key: &'static str,
    reason: &'static str,
) -> BlockedEntry {
    BlockedEntry {
        modifiers,
        key,
        reason,
    }
}

const MAC_BLOCKED: &[BlockedEntry] = &[
    entry(&[Meta, Shift], "delete", "empties the Trash"),
    entry(&[Meta, Shift], "q", "logs the user out"),
    entry(&[Ctrl, Meta], "q", "locks the screen"),
    entry(&[Meta], "q", "quits the frontmost app"),
    entry(&[Meta, Alt], "esc", "opens Force Quit Applications"),
];

const WINDOWS_BLOCKED: &[BlockedEntry] = &[
    entry(&[Alt], "f4", "closes the active window"),
    entry(&[Meta], "l", "locks the workstation"),
    entry(&[Meta], "d", "shows the desktop"),
    entry(&[Alt], "tab", "switches apps"),
    entry(&[Meta], "r", "opens the Run dialog"),
    entry(&[Meta], "x", "opens the Quick Link menu"),
    entry(&[Meta], "e", "opens File Explorer"),
    entry(&[Ctrl, Shift], "esc", "opens Task Manager"),
    entry(&[Ctrl, Alt], "delete", "opens the security screen"),
];

const VT_SWITCH: &str = "switches to a virtual terminal";

const LINUX_BLOCKED: &[BlockedEntry] = &[
    entry(&[Alt], "f4", "closes the active window"),
    entry(&[Alt], "tab", "switches apps"),
    entry(&[Alt], "f2", "opens the run-command prompt"),
    entry(&[Meta], "l", "locks the screen"),
    entry(&[Meta], "d", "shows the desktop"),
    entry(&[Meta], "tab", "switches apps"),
    entry(&[Ctrl, Alt], "t", "opens a terminal"),
    entry(&[Ctrl, Alt], "delete", "opens the log-out dialog"),
    entry(&[Ctrl, Alt], "l", "locks the screen"),
    entry(&[Ctrl, Alt], "f1", VT_SWITCH),
    entry(&[Ctrl, Alt], "f2", VT_SWITCH),
    entry(&[Ctrl, Alt], "f3", VT_SWITCH),
    entry(&[Ctrl, Alt], "f4", VT_SWITCH),
    entry(&[Ctrl, Alt], "f5", VT_SWITCH),
    entry(&[Ctrl, Alt], "f6", VT_SWITCH),
    entry(&[Ctrl, Alt], "f7", VT_SWITCH),
    entry(&[Ctrl, Alt], "f8", VT_SWITCH),
    entry(&[Ctrl, Alt], "f9", VT_SWITCH),
    entry(&[Ctrl, Alt], "f10", VT_SWITCH),
    entry(&[Ctrl, Alt], "f11", VT_SWITCH),
    entry(&[Ctrl, Alt], "f12", VT_SWITCH),
    entry(&[], "meta", "opens the desktop launcher"),
];

const fn table(os: TargetOs) -> &'static [BlockedEntry] {
    match os {
        TargetOs::Mac => MAC_BLOCKED,
        TargetOs::Windows => WINDOWS_BLOCKED,
        TargetOs::Linux => LINUX_BLOCKED,
    }
}

/// Superset rule: blocked iff some entry has `entry.key == combo.key` and
/// `entry.modifiers ⊆ combo.modifiers`.
pub fn blocked_reason_for(combo: &KeyCombo, os: TargetOs) -> Option<&'static str> {
    table(os)
        .iter()
        .find(|e| e.key == combo.key && e.modifiers.iter().all(|m| combo.modifiers.contains(m)))
        .map(|e| e.reason)
}

/// [`blocked_reason_for`] with [`TargetOs::current`].
pub fn blocked_reason(combo: &KeyCombo) -> Option<&'static str> {
    blocked_reason_for(combo, TargetOs::current())
}

/// Options for a policy-checked key press.
#[derive(Debug, Clone, Copy, Default)]
pub struct KeyOptions {
    /// Skip the blocked-combo policy. Only Ghost's MCP `force` param sets it.
    pub force: bool,
}

/// Fail with [`KeyError::Blocked`] if `combo` is blocked on `os`, unless forced.
pub(crate) fn enforce(combo: &KeyCombo, os: TargetOs, opts: KeyOptions) -> Result<(), KeyError> {
    if opts.force {
        return Ok(());
    }
    match blocked_reason_for(combo, os) {
        Some(reason) => Err(KeyError::Blocked {
            combo: combo.display(),
            reason,
        }),
        None => Ok(()),
    }
}

/// Parse + policy (unless `force`). Callers use it to refuse BEFORE focusing an app.
pub fn check_key(key: &str, modifiers: &[&str], opts: KeyOptions) -> Result<KeyCombo, KeyError> {
    let combo = KeyCombo::parse(key, modifiers)?;
    enforce(&combo, TargetOs::current(), opts)?;
    Ok(combo)
}

/// `Ok(None)` for an empty slice (a no-op); else [`KeyCombo::from_keys`] + policy.
pub fn check_hotkey(keys: &[&str], opts: KeyOptions) -> Result<Option<KeyCombo>, KeyError> {
    if keys.is_empty() {
        return Ok(None);
    }
    let combo = KeyCombo::from_keys(keys)?;
    enforce(&combo, TargetOs::current(), opts)?;
    Ok(Some(combo))
}

/// Why a key press was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyError {
    Blocked { combo: String, reason: &'static str },
    UnknownModifier(String),
    UnknownKey(String),
    EmptyKey,
}

impl KeyError {
    /// `POLICY_DENIED` for a blocked combo; `INVALID_ARGS` otherwise.
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Blocked { .. } => "POLICY_DENIED",
            _ => "INVALID_ARGS",
        }
    }

    /// The message without the code prefix.
    pub fn message(&self) -> String {
        match self {
            Self::Blocked { combo, reason } => format!(
                "key combo '{combo}' is blocked ({reason}); pass force=true only if the user explicitly asked for it"
            ),
            Self::UnknownModifier(m) => format!("Unknown modifier: '{m}'"),
            Self::UnknownKey(k) => format!("Unknown key: '{k}'"),
            Self::EmptyKey => "key must not be empty".to_string(),
        }
    }
}

impl fmt::Display for KeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code(), self.message())
    }
}

impl std::error::Error for KeyError {}

#[cfg(test)]
#[path = "policy_test.rs"]
mod tests;
