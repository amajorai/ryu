//! Which locale a notification is rendered in.

use super::catalog;

/// Core preference key the desktop and the Island write the UI language to,
/// as `{ "mode": "auto" | "fixed", "packId": "official/ja" | null }`; Desktop adds
/// the `"locale"` it shows in `auto` mode.
pub const UI_LANGUAGE_PREF_KEY: &str = "ui-language";

const ENGLISH: &str = "en";

/// Likely script of each catalog language (CLDR likely subtags, as
/// `Intl.Locale.maximize()` reports them). A tag written in another script has
/// no catalog: `zh-Hant` must not fall back to Simplified Chinese.
/// `tools/generate-core-i18n.mjs` checks this table against `Intl`.
const LIKELY_SCRIPTS: &[(&str, &str)] = &[
    ("ar", "Arab"),
    ("de", "Latn"),
    ("es", "Latn"),
    ("fr", "Latn"),
    ("hi", "Deva"),
    ("it", "Latn"),
    ("ja", "Jpan"),
    ("ko", "Kore"),
    ("pt", "Latn"),
    ("ru", "Cyrl"),
    ("zh", "Hans"),
];

/// Regions whose likely script differs from their language's default
/// (Chinese as written in Taiwan, Hong Kong, Macao and most of the diaspora).
const REGION_SCRIPTS: &[(&str, &str, &str)] = &[
    ("zh", "AU", "Hant"),
    ("zh", "BN", "Hant"),
    ("zh", "GB", "Hant"),
    ("zh", "GF", "Hant"),
    ("zh", "HK", "Hant"),
    ("zh", "ID", "Hant"),
    ("zh", "MO", "Hant"),
    ("zh", "PA", "Hant"),
    ("zh", "PF", "Hant"),
    ("zh", "PH", "Hant"),
    ("zh", "PZ", "Hant"),
    ("zh", "SR", "Hant"),
    ("zh", "TH", "Hant"),
    ("zh", "TW", "Hant"),
    ("zh", "UK", "Hant"),
    ("zh", "US", "Hant"),
    ("zh", "VD", "Hant"),
    ("zh", "VN", "Hant"),
];

/// Map any locale tag (`ja`, `pt-br`, `zh_CN.UTF-8`, `en-US`) to a locale the
/// catalog has: by exact tag, then by language and script (`pt-PT` is `pt-BR`,
/// `zh-SG` is `zh-CN`, `zh-TW` and `zh-Hant` have none). Anything else is
/// English, matching `officialCatalogLocale` in `@ryu/i18n`.
pub fn resolve(tag: &str) -> &'static str {
    let tag = tag
        .split(['.', '@'])
        .next()
        .unwrap_or_default()
        .trim()
        .replace('_', "-");
    if tag.is_empty() {
        return ENGLISH;
    }
    if let Some(found) = catalog::LOCALES
        .iter()
        .find(|locale| locale.eq_ignore_ascii_case(&tag))
    {
        return found;
    }
    let language = tag.split('-').next().unwrap_or_default();
    let script = likely_script(&tag);
    catalog::LOCALES
        .iter()
        .find(|locale| {
            locale
                .split('-')
                .next()
                .is_some_and(|l| l.eq_ignore_ascii_case(language))
                && likely_script(locale) == script
        })
        .copied()
        .unwrap_or(ENGLISH)
}

/// The script a tag is written in: its own script subtag, else the one its
/// region implies, else its language's default (`None` when unknown).
fn likely_script(tag: &str) -> Option<String> {
    let mut subtags = tag.split('-');
    let language = subtags.next().unwrap_or_default().to_ascii_lowercase();
    let mut region = None;
    for subtag in subtags {
        let alphabetic = subtag.chars().all(|c| c.is_ascii_alphabetic());
        if subtag.len() == 4 && alphabetic {
            let mut script = subtag.to_ascii_lowercase();
            script[..1].make_ascii_uppercase();
            return Some(script);
        }
        if region.is_none() && subtag.len() == 2 && alphabetic {
            region = Some(subtag.to_ascii_uppercase());
        }
    }
    let by_region = region.and_then(|region| {
        REGION_SCRIPTS
            .iter()
            .find(|(lang, reg, _)| *lang == language && *reg == region)
    });
    if let Some((_, _, script)) = by_region {
        return Some((*script).to_owned());
    }
    LIKELY_SCRIPTS
        .iter()
        .find(|(lang, _)| *lang == language)
        .map(|(_, script)| (*script).to_owned())
}

/// The locale a browser's `Accept-Language` header asks for: its tags in
/// preference order (highest `q` first, equal weights in header order), the
/// first that is English or has a catalog, like `localeFromAcceptLanguage` in
/// `@ryu/i18n` (`zh-TW,zh;q=0.9` is zh-CN; `nl,de;q=0.8` is de). English when
/// no listed tag has a catalog; `None` for a missing, empty or wildcard-only
/// header.
pub fn from_accept_language(header: &str) -> Option<&'static str> {
    let mut candidates: Vec<(f32, &str)> = Vec::new();
    for entry in header.split(',').take(32) {
        let mut parts = entry.split(';');
        let tag = parts.next().unwrap_or_default().trim();
        if tag.is_empty() || tag == "*" {
            continue;
        }
        let quality = parts
            .filter_map(|part| part.trim().strip_prefix("q="))
            .find_map(|q| q.trim().parse::<f32>().ok())
            .unwrap_or(1.0);
        if quality > 0.0 {
            candidates.push((quality, tag));
        }
    }
    if candidates.is_empty() {
        return None;
    }
    // A stable sort keeps equal weights in the header's order.
    candidates.sort_by(|(left, _), (right, _)| right.total_cmp(left));
    let shown = candidates.iter().find_map(|(_, tag)| {
        let locale = resolve(tag);
        (locale != ENGLISH || is_english(tag)).then_some(locale)
    });
    Some(shown.unwrap_or(ENGLISH))
}

/// Whether a tag names English itself (`en`, `en-GB`, `en_US.UTF-8`).
fn is_english(tag: &str) -> bool {
    tag.trim()
        .split(['-', '_', '.', '@'])
        .next()
        .is_some_and(|language| language.eq_ignore_ascii_case(ENGLISH))
}

/// `rtl` for a locale written right to left, else `ltr`.
pub fn text_direction(locale: &str) -> &'static str {
    match resolve(locale) {
        "ar" => "rtl",
        _ => "ltr",
    }
}

/// The supported locale a stored tag names, or `None` for a missing or blank
/// tag (the caller then uses the node's locale).
pub fn stored(tag: Option<&str>) -> Option<&'static str> {
    tag.map(str::trim)
        .filter(|tag| !tag.is_empty())
        .map(resolve)
}

/// What joins two sentences of one paragraph.
pub fn sentence_separator(locale: &str) -> &'static str {
    match resolve(locale) {
        "ja" | "zh-CN" => "",
        _ => " ",
    }
}

/// The locale for the node's own channels (webhook, Telegram, email, the
/// desktop toast, and pushes to devices that registered no locale): the
/// `ui-language` preference, where `auto` follows the OS language.
pub async fn node_locale() -> &'static str {
    let raw = match crate::server::preferences::PreferencesStore::open_default() {
        Ok(store) => store.get(UI_LANGUAGE_PREF_KEY).await.ok().flatten(),
        Err(_) => None,
    };
    // The first read may spawn a process (see `platform_locale`); keep it off
    // the async workers.
    let os = tokio::task::spawn_blocking(os_locale).await.ok().flatten();
    locale_from_preference(raw.as_deref(), os.as_deref())
}

/// The locale the user fixed in the `ui-language` preference, or `None` in
/// `auto` mode (or with no preference), where a request's own language wins.
pub async fn fixed_node_locale() -> Option<&'static str> {
    let raw = match crate::server::preferences::PreferencesStore::open_default() {
        Ok(store) => store.get(UI_LANGUAGE_PREF_KEY).await.ok().flatten(),
        Err(_) => None,
    };
    fixed_locale_from_preference(raw.as_deref())
}

/// Pure half of [`fixed_node_locale`].
pub fn fixed_locale_from_preference(raw: Option<&str>) -> Option<&'static str> {
    let preference = serde_json::from_str::<serde_json::Value>(raw?).ok()?;
    (preference.get("mode").and_then(serde_json::Value::as_str) == Some("fixed"))
        .then(|| locale_from_preference(raw, None))
}

/// Pure half of [`node_locale`]: the preference JSON plus the OS locale.
pub fn locale_from_preference(raw: Option<&str>, os: Option<&str>) -> &'static str {
    let parsed = raw.and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok());
    let follow_os = || os.map_or(ENGLISH, resolve);
    let Some(preference) = parsed else {
        return follow_os();
    };
    if preference.get("mode").and_then(serde_json::Value::as_str) != Some("fixed") {
        // Desktop records the locale it shows in auto mode (resolved from the
        // OS language list, live); prefer it over this process's OS probe.
        return preference
            .get("locale")
            .and_then(serde_json::Value::as_str)
            .filter(|locale| !locale.trim().is_empty())
            .map_or_else(follow_os, resolve);
    }
    // `null` is an explicit English choice; a pack id ends in its locale
    // (`official/pt-br`). A pack the catalog has no locale for is English.
    preference
        .get("packId")
        .and_then(serde_json::Value::as_str)
        .and_then(|pack| pack.rsplit('/').next())
        .map_or(ENGLISH, resolve)
}

/// The OS language: the POSIX locale variables (`C`/`POSIX` mean none), else
/// the desktop's own setting, since an app launched from the macOS Dock or the
/// Windows Start menu usually has no `LANG`. Read once and cached.
fn os_locale() -> Option<String> {
    static OS_LOCALE: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    OS_LOCALE
        .get_or_init(|| env_locale().or_else(platform_locale))
        .clone()
}

fn env_locale() -> Option<String> {
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .into_iter()
        .filter_map(|key| std::env::var(key).ok())
        .map(|value| value.trim().to_owned())
        .find(|value| {
            !value.is_empty() && value != "C" && value != "POSIX" && !value.starts_with("C.")
        })
}

/// The user's region-and-language setting (`ja_JP`, `de-DE`), when the OS has
/// one outside the environment.
fn platform_locale() -> Option<String> {
    let (program, args): (&str, &[&str]) = if cfg!(target_os = "macos") {
        ("defaults", &["read", "-g", "AppleLocale"])
    } else if cfg!(windows) {
        (
            "powershell",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "(Get-UICulture).Name",
            ],
        )
    } else {
        return None;
    };
    use crate::win_process::NoWindow;
    let output = std::process::Command::new(program)
        .no_window()
        .args(args)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    let tag = String::from_utf8(output.stdout).ok()?.trim().to_owned();
    (output.status.success() && !tag.is_empty()).then_some(tag)
}
