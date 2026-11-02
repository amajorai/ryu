//! The Gateway owner's UI language, the fallback for senders whose platform
//! reports no locale (Slack, WhatsApp, iMessage, a plain Discord message).
//!
//! Read from Core's `ui-language` preference (`GET /api/preferences/ui-language`,
//! `{ "mode": "auto" | "fixed", "packId": "official/ja" | null, "locale"? }`),
//! cached for a few minutes, falling back to the process locale when Core is
//! unreachable or has no preference.

use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::sync::Mutex;
use tracing::debug;

use super::{resolve, ENGLISH};

/// Core preference key the desktop and the Island write the UI language to.
pub const UI_LANGUAGE_PREF_KEY: &str = "ui-language";

/// How long a read stays fresh: a language change reaches chat replies within it.
const TTL: Duration = Duration::from_secs(5 * 60);
/// A Core that does not answer quickly must not hold up a pairing prompt.
const FETCH_TIMEOUT: Duration = Duration::from_secs(3);

/// Cached owner locale for one channel runtime.
#[derive(Debug)]
pub struct OwnerLocale {
    cached: Mutex<Option<(Instant, &'static str)>>,
    /// Set by tests and embedders that already know the locale: never fetched.
    fixed: Option<&'static str>,
}

/// Read from Core. Unit tests get English instead, so they never depend on a
/// Core or a process locale that happens to be on the machine running them.
impl Default for OwnerLocale {
    fn default() -> Self {
        Self {
            cached: Mutex::default(),
            fixed: cfg!(test).then_some(ENGLISH),
        }
    }
}

impl OwnerLocale {
    /// An owner locale read from Core (what [`Default`] gives outside tests).
    pub fn from_core() -> Self {
        Self {
            cached: Mutex::default(),
            fixed: None,
        }
    }

    /// An owner locale that is never fetched.
    pub fn fixed(tag: &str) -> Self {
        Self {
            cached: Mutex::default(),
            fixed: Some(resolve(tag)),
        }
    }

    /// The owner's locale, read from Core at `core_url` at most once per TTL.
    pub async fn get(&self, http: &reqwest::Client, core_url: &str) -> &'static str {
        if let Some(locale) = self.fixed {
            return locale;
        }
        let mut cached = self.cached.lock().await;
        if let Some((read_at, locale)) = *cached {
            if read_at.elapsed() < TTL {
                return locale;
            }
        }
        let raw = fetch_preference(http, core_url).await;
        let locale = locale_from_preference(raw.as_deref(), env_locale().as_deref());
        *cached = Some((Instant::now(), locale));
        locale
    }
}

/// The stored preference JSON, or `None` when Core is unreachable, refuses the
/// read, or has nothing stored.
async fn fetch_preference(http: &reqwest::Client, core_url: &str) -> Option<String> {
    let url = format!(
        "{}/api/preferences/{UI_LANGUAGE_PREF_KEY}",
        core_url.trim_end_matches('/')
    );
    let response = match http.get(&url).timeout(FETCH_TIMEOUT).send().await {
        Ok(response) if response.status().is_success() => response,
        Ok(response) => {
            debug!(status = %response.status(), "owner ui-language preference unavailable");
            return None;
        }
        Err(err) => {
            debug!(%err, "owner ui-language preference unreachable");
            return None;
        }
    };
    let body: Value = response.json().await.ok()?;
    body.get("value")?.as_str().map(str::to_owned)
}

/// Core's rule (`locale_from_preference` in `apps/core/src/i18n/locale.rs`):
/// `fixed` uses the pack's locale (`null` is an explicit English choice);
/// `auto` uses the locale the desktop recorded, else the OS locale.
pub fn locale_from_preference(raw: Option<&str>, os: Option<&str>) -> &'static str {
    let parsed = raw.and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    let follow_os = || os.map_or(ENGLISH, resolve);
    let Some(preference) = parsed else {
        return follow_os();
    };
    if preference.get("mode").and_then(Value::as_str) != Some("fixed") {
        return preference
            .get("locale")
            .and_then(Value::as_str)
            .filter(|locale| !locale.trim().is_empty())
            .map_or_else(follow_os, resolve);
    }
    preference
        .get("packId")
        .and_then(Value::as_str)
        .and_then(|pack| pack.rsplit('/').next())
        .map_or(ENGLISH, resolve)
}

/// The process locale from the POSIX variables (`C`/`POSIX` mean none).
fn env_locale() -> Option<String> {
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .into_iter()
        .filter_map(|key| std::env::var(key).ok())
        .map(|value| value.trim().to_owned())
        .find(|value| {
            !value.is_empty() && value != "C" && value != "POSIX" && !value.starts_with("C.")
        })
}
