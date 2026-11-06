//! The UI language handed to WebView2 on Windows (`--lang`).
//!
//! WebView2 words its own built-in UI (native date and time pickers, spelling
//! suggestions, `navigator.language`) in the language it starts with, which is
//! the OS display language unless `--lang` says otherwise. Ryu's language is
//! chosen in the webview, after WebView2 has started, so the locale the webview
//! last showed is kept in a state file (`state/webview-ui-locale`, through the
//! data-dir layout) by `set_native_copy` and applied by
//! `hardware_acceleration::apply_before_webview` on the next launch. A language
//! change therefore reaches these built-in controls after a restart.
//!
//! WKWebView and WebKitGTK take no such switch. On macOS the explicit UI
//! language is instead written to the app's `AppleLanguages` default, so the
//! chrome AppKit draws itself follows it on the next launch (`macos`).
//! WebKitGTK stores nothing.

use crate::profile;

#[path = "webview_locale_macos.rs"]
pub(crate) mod macos;

const STATE_FILE: &str = "webview-ui-locale";
const MAX_TAG_LENGTH: usize = 35;

fn state_file() -> std::path::PathBuf {
    ryu_sidecar_runtime::layout::state_path(&profile::ryu_home_dir(), STATE_FILE)
}

/// A BCP 47 tag WebView2 can take (`pt_BR` -> `pt-BR`), or `None` when the
/// value is blank, too long or not a plain language tag.
fn normalize(raw: &str) -> Option<String> {
    let tag = raw.trim().replace('_', "-");
    let mut parts = tag.split('-');
    let language = parts.next()?;
    let valid = tag.len() <= MAX_TAG_LENGTH
        && (2..=8).contains(&language.len())
        && language.chars().all(|c| c.is_ascii_alphabetic())
        && parts.all(|part| {
            (1..=8).contains(&part.len()) && part.chars().all(|c| c.is_ascii_alphanumeric())
        });
    valid.then_some(tag)
}

/// The `--lang` switch for this launch, from the locale the webview last
/// showed. `None` before the first run or when the stored value is unusable.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn launch_arg() -> Option<String> {
    let stored = std::fs::read_to_string(state_file()).ok()?;
    normalize(&stored).map(|tag| format!("--lang={tag}"))
}

/// Keep the locale the webview shows for the next launch: WebView2's
/// `--lang` on Windows, the app's `AppleLanguages` on macOS (only for an
/// explicit `language_mode` of `"fixed"`; `"auto"` removes what Ryu wrote).
/// Best effort: a write failure only means the OS language stays.
pub fn remember(locale: Option<&str>, language_mode: Option<&str>) {
    #[cfg(target_os = "macos")]
    macos::remember(locale, language_mode);
    #[cfg(not(target_os = "macos"))]
    let _ = language_mode;
    if !cfg!(target_os = "windows") {
        return;
    }
    let Some(tag) = locale.and_then(normalize) else {
        return;
    };
    let path = state_file();
    if std::fs::read_to_string(&path).ok().as_deref() == Some(tag.as_str()) {
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(error) = std::fs::write(&path, tag) {
        tracing::warn!("could not save the WebView2 UI locale: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_plain_language_tags_and_normalizes_underscores() {
        assert_eq!(normalize("de").as_deref(), Some("de"));
        assert_eq!(normalize(" pt_BR ").as_deref(), Some("pt-BR"));
        assert_eq!(normalize("zh-Hant-TW").as_deref(), Some("zh-Hant-TW"));
    }

    #[test]
    fn rejects_values_that_could_smuggle_another_switch() {
        for raw in [
            "",
            "e",
            "en --disable-web-security",
            "en=1",
            "--lang=en",
            "en-",
            "1a",
            &"a".repeat(40),
        ] {
            assert_eq!(normalize(raw), None, "{raw:?}");
        }
    }

    #[test]
    fn the_state_file_lives_in_the_state_dir() {
        assert_eq!(
            state_file(),
            ryu_sidecar_runtime::layout::state_path(&profile::ryu_home_dir(), STATE_FILE)
        );
    }
}
