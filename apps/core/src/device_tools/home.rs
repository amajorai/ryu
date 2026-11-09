//! The Home security class (design §3.2).
//!
//! Core decides whether a `device.home.set` is a physical-access action from
//! the signed accessory cache the phone posts after every `device.home.list`
//! (`POST /api/device-tools/home-accessories`), never from model text. An
//! accessory that is unknown, older than 24 hours, or that has a lock, garage
//! door, security system, door or window service is security class: it can be
//! approved only on the target phone after biometrics.

use serde::Deserialize;
use serde_json::Value;

use super::declaration::clean_label;
use super::registry::DeviceToolStore;

/// A cached snapshot older than this no longer proves an accessory is safe.
pub(crate) const STALE_AFTER_MS: i64 = 24 * 60 * 60 * 1000;
/// Bounds on one post.
pub(crate) const MAX_ACCESSORIES: usize = 500;
const MAX_SERVICES: usize = 32;
const MAX_ID_CHARS: usize = 256;
const MAX_NAME_CHARS: usize = 60;

/// HomeKit service types that make an accessory security class, in the
/// normalized form of [`normalize_service`].
const SECURITY_SERVICES: &[&str] = &[
    "lockmechanism",
    "garagedooropener",
    "securitysystem",
    "door",
    "window",
];

/// One accessory as the phone reported it, already validated.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HomeAccessory {
    pub(crate) id: String,
    /// The accessory name the phone reported (control characters stripped),
    /// the only accessory text a card ever shows.
    pub(crate) name: String,
    /// Normalized HomeKit service types.
    pub(crate) services: Vec<String>,
}

/// `HMServiceTypeLockMechanism`, `LockMechanism` and `lock_mechanism` all
/// normalize to `lockmechanism`.
pub(crate) fn normalize_service(service: &str) -> String {
    let lowered: String = service
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect::<String>()
        .to_ascii_lowercase();
    lowered
        .strip_prefix("hmservicetype")
        .map_or_else(|| lowered.clone(), str::to_owned)
}

#[derive(Deserialize)]
struct WireAccessory {
    accessory_id: String,
    #[serde(default)]
    name: String,
    services: Vec<String>,
}

/// Parse the `accessories` array of a home-accessories post. `None` when the
/// post is malformed or over a bound (the whole post is refused, so a partial
/// snapshot never replaces a complete one).
pub(crate) fn parse_accessories(value: &Value) -> Option<Vec<HomeAccessory>> {
    let wire: Vec<WireAccessory> = serde_json::from_value(value.clone()).ok()?;
    if wire.len() > MAX_ACCESSORIES {
        return None;
    }
    wire.into_iter()
        .map(|accessory| {
            let id = accessory.accessory_id.trim();
            if id.is_empty()
                || id.chars().count() > MAX_ID_CHARS
                || id.chars().any(char::is_control)
                || accessory.services.len() > MAX_SERVICES
            {
                return None;
            }
            let mut services: Vec<String> = accessory
                .services
                .iter()
                .map(|service| normalize_service(service))
                .filter(|service| !service.is_empty() && service.len() <= 64)
                .collect();
            services.sort();
            services.dedup();
            Some(HomeAccessory {
                id: id.to_owned(),
                name: clean_label(&accessory.name, MAX_NAME_CHARS),
                services,
            })
        })
        .collect()
}

/// What Core knows about the accessory a `device.home.set` targets.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HomeTarget {
    /// The call must be confirmed on the target phone with biometrics.
    pub(crate) security_class: bool,
    /// The cached accessory name, for the card (never model text).
    pub(crate) name: Option<String>,
}

/// Classify the accessory of a `device.home.set` on its target device.
pub(crate) fn classify(
    store: &DeviceToolStore,
    principal_id: &str,
    device_id: &str,
    accessory_id: &str,
    now_ms: i64,
) -> HomeTarget {
    let Some(cached) = store.home_accessory(principal_id, device_id, accessory_id) else {
        return HomeTarget {
            security_class: true,
            name: None,
        };
    };
    let stale = now_ms - cached.updated_ms > STALE_AFTER_MS;
    let security_service = cached
        .accessory
        .services
        .iter()
        .any(|service| SECURITY_SERVICES.contains(&service.as_str()));
    let name = Some(cached.accessory.name).filter(|name| !name.is_empty());
    HomeTarget {
        security_class: stale || security_service,
        name,
    }
}
