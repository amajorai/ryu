//! The UI language handed to AppKit on macOS (the per-app `AppleLanguages`).
//!
//! AppKit words the chrome it draws itself (the Edit-menu items it adds, such
//! as Start Dictation, Emoji & Symbols and AutoFill, and the `NSOpenPanel`
//! buttons) from the app's preferred languages, which are read once at launch.
//! When the UI language is chosen explicitly, Ryu writes it to the app's own
//! defaults domain, exactly what System Settings > Language & Region >
//! Applications does, together with a marker (`RyuManagedAppleLanguages`) that
//! records the value Ryu wrote. In auto mode the key is removed again, but only
//! while it still holds the value Ryu wrote, so a per-app language the user
//! chose in System Settings is never erased. Like WebView2's `--lang`, the
//! change reaches AppKit on the next launch.
//!
//! Auto-mode language detection (`native_copy::os`) must not read Ryu's own
//! choice back, so [`preferred_languages`] answers from the user's global list
//! while the app value is the one Ryu manages.

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const APPLE_LANGUAGES: &str = "AppleLanguages";
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const MARKER: &str = "RyuManagedAppleLanguages";

/// What to do with the app-domain `AppleLanguages` for one language push.
#[derive(Debug, PartialEq, Eq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) enum Action {
    /// Write `[tag]` and record `tag` as the managed value.
    Write(String),
    /// Remove the value Ryu wrote and its marker.
    Clear,
    /// The user replaced Ryu's value in System Settings: keep theirs, drop
    /// the marker.
    ForgetMarker,
    /// Nothing to change.
    Keep,
}

/// Apple's spelling of a BCP 47 tag: Chinese by script (`zh-CN` ->
/// `zh-Hans`, `zh-TW` -> `zh-Hant`), every other tag unchanged (`pt-BR`).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn apple_tag(tag: &str) -> String {
    let mut parts = tag.split('-');
    let language = parts.next().unwrap_or_default();
    if !language.eq_ignore_ascii_case("zh") {
        return tag.to_owned();
    }
    let Some(subtag) = parts.next() else {
        return tag.to_owned();
    };
    match subtag.to_ascii_uppercase().as_str() {
        "CN" | "SG" | "HANS" => "zh-Hans".to_owned(),
        "TW" | "HK" | "MO" | "HANT" => "zh-Hant".to_owned(),
        _ => tag.to_owned(),
    }
}

/// Whether the app-domain value is still exactly the one Ryu wrote.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn is_managed(current: Option<&[String]>, marker: Option<&str>) -> bool {
    match (current, marker) {
        (Some([only]), Some(marker)) => only == marker,
        _ => false,
    }
}

/// The change for a language push: `language_mode` is `"fixed"` for an
/// explicit choice and `"auto"` when the OS language applies; any other
/// value (an older webview that does not send it) changes nothing.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn decide(
    language_mode: Option<&str>,
    locale: Option<&str>,
    current: Option<&[String]>,
    marker: Option<&str>,
) -> Action {
    match language_mode {
        Some("fixed") => {
            let Some(tag) = locale.and_then(super::normalize).map(|tag| apple_tag(&tag)) else {
                return Action::Keep;
            };
            if is_managed(current, marker) && marker == Some(tag.as_str()) {
                Action::Keep
            } else {
                Action::Write(tag)
            }
        }
        Some("auto") if marker.is_some() => {
            if is_managed(current, marker) {
                Action::Clear
            } else {
                Action::ForgetMarker
            }
        }
        _ => Action::Keep,
    }
}

/// Where auto-mode detection reads the user's languages from: the app value
/// when the user set it (not Ryu), else the global list. While Ryu manages the
/// app value the answer is never `None`, so the caller cannot fall back to
/// `NSLocale`, which would report Ryu's own choice.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn detection_list(
    app_value: Option<Vec<String>>,
    marker: Option<&str>,
    global: Option<Vec<String>>,
) -> Option<Vec<String>> {
    match app_value {
        Some(list) if is_managed(Some(&list), marker) => Some(global.unwrap_or_default()),
        Some(list) if !list.is_empty() => Some(list),
        _ => global.filter(|list| !list.is_empty()),
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use core_foundation::array::CFArray;
    use core_foundation::base::{CFType, CFTypeRef, TCFType};
    use core_foundation::string::{CFString, CFStringRef};

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFPreferencesAnyApplication: CFStringRef;
        static kCFPreferencesCurrentApplication: CFStringRef;
        static kCFPreferencesCurrentUser: CFStringRef;
        static kCFPreferencesAnyHost: CFStringRef;
        fn CFPreferencesCopyValue(
            key: CFStringRef,
            application: CFStringRef,
            user: CFStringRef,
            host: CFStringRef,
        ) -> CFTypeRef;
        fn CFPreferencesSetAppValue(key: CFStringRef, value: CFTypeRef, application: CFStringRef);
        fn CFPreferencesAppSynchronize(application: CFStringRef) -> u8;
    }

    /// One domain's value only (no search through the global domain).
    fn copy_value(key: &str, global: bool) -> Option<CFType> {
        let key = CFString::new(key);
        // SAFETY: the CFPreferences constants are immutable CFStrings exported
        // by CoreFoundation; `CFPreferencesCopyValue` follows the Copy rule,
        // so a non-null result is owned here and released on drop.
        unsafe {
            let application = if global {
                kCFPreferencesAnyApplication
            } else {
                kCFPreferencesCurrentApplication
            };
            let raw = CFPreferencesCopyValue(
                key.as_concrete_TypeRef(),
                application,
                kCFPreferencesCurrentUser,
                kCFPreferencesAnyHost,
            );
            (!raw.is_null()).then(|| CFType::wrap_under_create_rule(raw))
        }
    }

    fn string_list(value: CFType) -> Option<Vec<String>> {
        let array = value.downcast::<CFArray>()?;
        let mut list = Vec::new();
        for item in array.get_all_values().into_iter().take(32) {
            if item.is_null() {
                continue;
            }
            // SAFETY: `item` is a live element of `array`, retained by the wrap.
            let item = unsafe { CFType::wrap_under_get_rule(item) };
            if let Some(text) = item.downcast::<CFString>() {
                list.push(text.to_string());
            }
        }
        Some(list)
    }

    pub(super) fn app_languages() -> Option<Vec<String>> {
        copy_value(super::APPLE_LANGUAGES, false).and_then(string_list)
    }

    pub(super) fn global_languages() -> Option<Vec<String>> {
        copy_value(super::APPLE_LANGUAGES, true).and_then(string_list)
    }

    pub(super) fn marker() -> Option<String> {
        copy_value(super::MARKER, false)
            .and_then(|value| value.downcast::<CFString>())
            .map(|text| text.to_string())
    }

    fn set(key: &str, value: Option<CFTypeRef>) {
        let key = CFString::new(key);
        // SAFETY: the key and value are live CF objects for the whole call;
        // CFPreferences retains what it stores. A null value removes the key.
        unsafe {
            CFPreferencesSetAppValue(
                key.as_concrete_TypeRef(),
                value.unwrap_or(std::ptr::null()),
                kCFPreferencesCurrentApplication,
            );
        }
    }

    pub(super) fn write(tag: &str) {
        let list = CFArray::from_CFTypes(&[CFString::new(tag)]);
        let marker = CFString::new(tag);
        set(super::APPLE_LANGUAGES, Some(list.as_CFTypeRef()));
        set(super::MARKER, Some(marker.as_CFTypeRef()));
        synchronize();
    }

    pub(super) fn remove(apple_languages: bool) {
        if apple_languages {
            set(super::APPLE_LANGUAGES, None);
        }
        set(super::MARKER, None);
        synchronize();
    }

    fn synchronize() {
        // SAFETY: flushes the current application's domain; no pointers kept.
        if unsafe { CFPreferencesAppSynchronize(kCFPreferencesCurrentApplication) } == 0 {
            tracing::warn!("could not save the macOS app language");
        }
    }
}

/// Apply a language push to the app's `AppleLanguages` (best effort).
#[cfg(target_os = "macos")]
pub(crate) fn remember(locale: Option<&str>, language_mode: Option<&str>) {
    let current = platform::app_languages();
    let marker = platform::marker();
    match decide(language_mode, locale, current.as_deref(), marker.as_deref()) {
        Action::Write(tag) => platform::write(&tag),
        Action::Clear => platform::remove(true),
        Action::ForgetMarker => platform::remove(false),
        Action::Keep => {}
    }
}

/// The user's preferred languages for auto-mode detection, read from the
/// defaults rather than `NSLocale` so a value Ryu wrote is never read back.
/// `None` when the defaults hold no list and Ryu manages none (the caller
/// then asks `NSLocale`).
#[cfg(target_os = "macos")]
pub(crate) fn preferred_languages() -> Option<Vec<String>> {
    let marker = platform::marker();
    detection_list(
        platform::app_languages(),
        marker.as_deref(),
        platform::global_languages(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(tags: &[&str]) -> Vec<String> {
        tags.iter().map(|tag| (*tag).to_owned()).collect()
    }

    #[test]
    fn maps_tags_to_apple_spelling() {
        assert_eq!(apple_tag("zh-CN"), "zh-Hans");
        assert_eq!(apple_tag("zh-SG"), "zh-Hans");
        assert_eq!(apple_tag("zh-Hans-CN"), "zh-Hans");
        assert_eq!(apple_tag("zh-TW"), "zh-Hant");
        assert_eq!(apple_tag("zh-HK"), "zh-Hant");
        assert_eq!(apple_tag("zh"), "zh");
        assert_eq!(apple_tag("pt-BR"), "pt-BR");
        assert_eq!(apple_tag("de"), "de");
        assert_eq!(apple_tag("ja"), "ja");
        assert_eq!(apple_tag("ar"), "ar");
    }

    #[test]
    fn ja_ar_and_de_choices_reach_appkit_and_auto_hands_back_the_os_list() {
        // A Japanese Mac whose user picks Arabic in Ryu: Ryu writes `ar`.
        assert_eq!(
            decide(Some("fixed"), Some("ar"), None, None),
            Action::Write("ar".into())
        );
        let ours = list(&["ar"]);
        // Detection still reports the Mac's own languages, not Ryu's `ar`.
        let global = Some(list(&["ja-JP", "en-US"]));
        assert_eq!(
            detection_list(Some(ours.clone()), Some("ar"), global.clone()),
            global
        );
        // Switching to German replaces it; Auto detect removes it again.
        assert_eq!(
            decide(Some("fixed"), Some("de-DE"), Some(&ours), Some("ar")),
            Action::Write("de-DE".into())
        );
        let german = list(&["de-DE"]);
        assert_eq!(
            decide(Some("auto"), Some("ja"), Some(&german), Some("de-DE")),
            Action::Clear
        );
    }

    #[test]
    fn an_explicit_language_is_written_once() {
        assert_eq!(
            decide(Some("fixed"), Some("zh_CN"), None, None),
            Action::Write("zh-Hans".into())
        );
        let current = list(&["de"]);
        assert_eq!(
            decide(Some("fixed"), Some("de"), Some(&current), Some("de")),
            Action::Keep
        );
        assert_eq!(
            decide(Some("fixed"), Some("fr"), Some(&current), Some("de")),
            Action::Write("fr".into())
        );
        // An explicit choice takes over a per-app language set in System Settings.
        assert_eq!(
            decide(Some("fixed"), Some("de"), Some(&current), None),
            Action::Write("de".into())
        );
    }

    #[test]
    fn auto_mode_clears_only_the_value_ryu_wrote() {
        let ours = list(&["de"]);
        assert_eq!(
            decide(Some("auto"), Some("en"), Some(&ours), Some("de")),
            Action::Clear
        );
        let theirs = list(&["fr"]);
        assert_eq!(
            decide(Some("auto"), Some("en"), Some(&theirs), Some("de")),
            Action::ForgetMarker
        );
        assert_eq!(
            decide(Some("auto"), Some("en"), None, Some("de")),
            Action::ForgetMarker
        );
        assert_eq!(
            decide(Some("auto"), Some("en"), Some(&theirs), None),
            Action::Keep
        );
    }

    #[test]
    fn invalid_tags_and_unknown_modes_change_nothing() {
        for raw in ["", "en --disable-web-security", "en=1", "1a"] {
            assert_eq!(
                decide(Some("fixed"), Some(raw), None, None),
                Action::Keep,
                "{raw:?}"
            );
        }
        assert_eq!(decide(Some("fixed"), None, None, None), Action::Keep);
        assert_eq!(decide(None, Some("de"), None, Some("de")), Action::Keep);
        assert_eq!(decide(Some("other"), Some("de"), None, None), Action::Keep);
    }

    #[test]
    fn detection_never_reads_back_the_value_ryu_wrote() {
        let global = Some(list(&["fr-FR", "en-US"]));
        assert_eq!(
            detection_list(Some(list(&["de"])), Some("de"), global.clone()),
            global
        );
        assert_eq!(
            detection_list(Some(list(&["it"])), Some("de"), global.clone()),
            Some(list(&["it"]))
        );
        assert_eq!(
            detection_list(Some(list(&["it"])), None, None),
            Some(list(&["it"]))
        );
        assert_eq!(detection_list(None, None, global.clone()), global);
        assert_eq!(detection_list(None, None, Some(Vec::new())), None);
        assert_eq!(
            detection_list(Some(list(&["de"])), Some("de"), None),
            Some(Vec::new())
        );
    }
}
