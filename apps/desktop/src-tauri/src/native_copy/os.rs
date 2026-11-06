//! The OS's preferred UI languages, best first, as the OS spells them.
//! `super::get_os_preferred_languages` normalises and deduplicates them.

/// macOS: the `AppleLanguages` defaults (System Settings > Language &
/// Region), never the per-app value Ryu writes for an explicit UI language;
/// `NSLocale.preferredLanguages` when the defaults hold no list.
#[cfg(target_os = "macos")]
pub(super) fn preferred_languages() -> Vec<String> {
    if let Some(languages) = crate::webview_locale::macos::preferred_languages() {
        return languages;
    }
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::CStr;
    use std::os::raw::c_char;

    let mut languages = Vec::new();
    // SAFETY: `preferredLanguages` is a thread-safe class method returning an
    // autoreleased NSArray<NSString *>; every element is read while the array
    // is alive, and `UTF8String` points into the NSString, copied at once.
    unsafe {
        let list: *mut Object = msg_send![class!(NSLocale), preferredLanguages];
        if list.is_null() {
            return languages;
        }
        let count: usize = msg_send![list, count];
        for index in 0..count.min(32) {
            let item: *mut Object = msg_send![list, objectAtIndex: index];
            if item.is_null() {
                continue;
            }
            let utf8: *const c_char = msg_send![item, UTF8String];
            if !utf8.is_null() {
                languages.push(CStr::from_ptr(utf8).to_string_lossy().into_owned());
            }
        }
    }
    languages
}

/// Windows: `GetUserPreferredUILanguages` (Settings > Time & language).
#[cfg(target_os = "windows")]
pub(super) fn preferred_languages() -> Vec<String> {
    const MUI_LANGUAGE_NAME: u32 = 0x8;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetUserPreferredUILanguages(
            flags: u32,
            languages: *mut u32,
            buffer: *mut u16,
            buffer_len: *mut u32,
        ) -> i32;
    }
    let mut count = 0u32;
    let mut len = 0u32;
    // SAFETY: the first call only writes the two counters; the second writes at
    // most `len` UTF-16 units into a buffer of exactly that size.
    unsafe {
        if GetUserPreferredUILanguages(
            MUI_LANGUAGE_NAME,
            &mut count,
            std::ptr::null_mut(),
            &mut len,
        ) == 0
            || len == 0
        {
            return Vec::new();
        }
        let mut buffer = vec![0u16; len as usize];
        if GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &mut count, buffer.as_mut_ptr(), &mut len)
            == 0
        {
            return Vec::new();
        }
        buffer
            .split(|unit| *unit == 0)
            .filter(|tag| !tag.is_empty())
            .map(String::from_utf16_lossy)
            .collect()
    }
}

/// Linux and the rest: the POSIX locale environment, in glibc's precedence.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(super) fn preferred_languages() -> Vec<String> {
    let read = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
    from_posix_env(
        read("LANGUAGE").as_deref(),
        read("LC_ALL").as_deref(),
        read("LC_MESSAGES").as_deref(),
        read("LANG").as_deref(),
    )
}

/// `LANGUAGE` (a colon list) applies only when the locale is not `C`; then the
/// first of `LC_ALL`, `LC_MESSAGES`, `LANG` that is set.
#[cfg_attr(any(target_os = "macos", target_os = "windows"), allow(dead_code))]
pub(super) fn from_posix_env(
    language: Option<&str>,
    lc_all: Option<&str>,
    lc_messages: Option<&str>,
    lang: Option<&str>,
) -> Vec<String> {
    let locale = lc_all.or(lc_messages).or(lang);
    let mut languages = Vec::new();
    let is_c = locale.is_some_and(|value| value == "C" || value == "POSIX");
    if let Some(list) = language.filter(|_| !is_c) {
        languages.extend(
            list.split(':')
                .filter(|tag| !tag.is_empty())
                .map(str::to_owned),
        );
    }
    languages.extend(locale.map(str::to_owned));
    languages
}
