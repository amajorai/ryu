//! The user's per-brand managed-provider pins, applied to calls Core forwards.
//!
//! The Integrations Store writes one pin per brand (`treg` or `composio`) to
//! the `integrations-provider-pins` preference. Core is the only party that
//! reads it: before forwarding an app's or an agent's provider call to
//! Gateway, Core works out which brand the call belongs to and forwards that
//! brand's pin as `providerPin`, a field the app cannot set. Gateway then keeps
//! a Composio-pinned call on Composio and refuses to run it on Treg.
//!
//! Every uncertainty fails toward Composio, the provider the user can always
//! choose: unreadable preferences, or a Treg catalog that cannot say which
//! brand an endpoint belongs to while some brand is pinned to Composio.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use serde_json::Value;

use crate::catalog_source::{integration_brand_slug, parse_provider_pins};

/// A user's managed-provider pin for one brand.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProviderPin {
    Treg,
    Composio,
}

impl ProviderPin {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Treg => "treg",
            Self::Composio => "composio",
        }
    }

    fn parse(source: &str) -> Option<Self> {
        match source {
            "treg" => Some(Self::Treg),
            "composio" => Some(Self::Composio),
            _ => None,
        }
    }
}

/// The pins, keyed by Integrations Store brand id.
#[derive(Debug, Clone, Default)]
pub(crate) struct ProviderPins(HashMap<String, String>);

impl ProviderPins {
    /// Pins from the raw preference read. A failed read is an error, never
    /// "no pins": a caller fails closed on it.
    pub(crate) fn from_read<E: std::fmt::Display>(raw: Result<Option<String>, E>) -> Result<Self> {
        let raw = raw.map_err(|error| anyhow!("reading provider pins: {error}"))?;
        Ok(Self(parse_provider_pins(raw.as_deref())))
    }

    /// The pins from this node's preferences store.
    pub(crate) async fn load_default() -> Result<Self> {
        let store = crate::server::preferences::PreferencesStore::open_default()
            .map_err(|error| anyhow!("opening preferences: {error}"))?;
        Self::from_read(
            store
                .get(crate::catalog_source::INTEGRATION_PROVIDER_PINS_PREF)
                .await,
        )
    }

    #[cfg(test)]
    pub(crate) fn from_pairs(pairs: &[(&str, &str)]) -> Self {
        Self(
            pairs
                .iter()
                .map(|(brand, source)| ((*brand).to_owned(), (*source).to_owned()))
                .collect(),
        )
    }

    /// Whether any brand is pinned to Composio. Without one there is nothing
    /// to enforce and no brand lookup is needed.
    pub(crate) fn any_composio(&self) -> bool {
        self.0.values().any(|source| source == "composio")
    }

    pub(crate) fn for_brand(&self, brand: &str) -> Option<ProviderPin> {
        self.0
            .get(brand)
            .and_then(|source| ProviderPin::parse(source))
    }

    /// The strongest pin among candidate brands: Composio over Treg, so an
    /// ambiguous call never escapes a Composio pin.
    pub(crate) fn strongest<'a>(
        &self,
        brands: impl IntoIterator<Item = &'a str>,
    ) -> Option<ProviderPin> {
        let pins: Vec<ProviderPin> = brands
            .into_iter()
            .filter_map(|brand| self.for_brand(brand))
            .collect();
        if pins.contains(&ProviderPin::Composio) {
            Some(ProviderPin::Composio)
        } else {
            pins.first().copied()
        }
    }
}

/// Which store brand a Treg endpoint belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TregBrand {
    Brand(String),
    /// The catalog does not list the endpoint (or names no platform).
    NotListed,
    /// The catalog could not be read.
    Unreadable,
}

/// Reads a Treg endpoint's brand. A trait so tests need no network.
#[async_trait::async_trait]
pub(crate) trait BrandLookup: Send + Sync {
    async fn treg_brand(&self, endpoint_id: &str) -> TregBrand;
}

/// The Integrations Store brand id of a Treg endpoint detail: the slug of its
/// platform label, else of its platform slug, as the store merge derives it.
pub(crate) fn endpoint_brand(detail: &Value) -> Option<String> {
    let endpoint = detail.get("endpoint").unwrap_or(detail);
    ["platform_label", "platform"]
        .into_iter()
        .filter_map(|field| endpoint.get(field).and_then(Value::as_str))
        .map(integration_brand_slug)
        .find(|slug| !slug.is_empty())
}

/// How long a resolved endpoint brand is reused.
const BRAND_CACHE_TTL: Duration = Duration::from_secs(60);
/// Bound on cached endpoint brands; the cache is cleared when full.
const BRAND_CACHE_MAX: usize = 1024;

static BRAND_CACHE: LazyLock<Mutex<HashMap<String, (TregBrand, Instant)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// [`BrandLookup`] over Treg's public catalog, with a short cache. Only
/// definite answers are cached; an unreadable catalog is asked again.
pub(crate) struct CatalogBrandLookup;

#[async_trait::async_trait]
impl BrandLookup for CatalogBrandLookup {
    async fn treg_brand(&self, endpoint_id: &str) -> TregBrand {
        if let Some(cached) = BRAND_CACHE.lock().ok().and_then(|cache| {
            cache
                .get(endpoint_id)
                .filter(|(_, at)| at.elapsed() < BRAND_CACHE_TTL)
                .map(|(brand, _)| brand.clone())
        }) {
            return cached;
        }
        let brand = match crate::treg_catalog::describe_endpoint(endpoint_id).await {
            Ok(Some(detail)) => {
                endpoint_brand(&detail).map_or(TregBrand::NotListed, TregBrand::Brand)
            }
            Ok(None) => TregBrand::NotListed,
            Err(error) => {
                tracing::debug!(
                    endpoint_id,
                    "provider pins: Treg catalog unreadable: {error}"
                );
                return TregBrand::Unreadable;
            }
        };
        if let Ok(mut cache) = BRAND_CACHE.lock() {
            if cache.len() >= BRAND_CACHE_MAX {
                cache.clear();
            }
            cache.insert(endpoint_id.to_owned(), (brand.clone(), Instant::now()));
        }
        brand
    }
}

/// Whether a tool id is a Composio action slug (`TOOLKIT_ACTION`, upper case),
/// as opposed to a Treg endpoint id (`vendor.platform.job`, lower case).
pub(crate) fn is_composio_action_slug(tool_id: &str) -> bool {
    tool_id.contains('_')
        && !tool_id.contains('.')
        && tool_id
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

/// The store brands a Composio action slug may belong to. The toolkit is a
/// prefix of the slug but its length is not marked (`GOOGLE_MAPS_GEOCODE` is
/// toolkit `googlemaps`), so every leading run of words is a candidate. Over-
/// matching is the safe direction: it can only keep more calls on Composio.
pub(crate) fn composio_brand_candidates(slug: &str) -> Vec<String> {
    let words: Vec<&str> = slug.split('_').filter(|word| !word.is_empty()).collect();
    (1..=words.len())
        .map(|count| integration_brand_slug(&words[..count].concat()))
        .filter(|brand| !brand.is_empty())
        .collect()
}

/// A provider tool id as Gateway will use it: trimmed, and refused when it
/// could name a different path segment than the one Core checked (a slash,
/// a backslash or a control character). The pin is decided on, and the call
/// forwarded with, exactly this id.
pub(crate) fn normalized_tool_id(raw: &str) -> Option<String> {
    let id = raw.trim();
    (!id.is_empty() && !id.contains(['/', '\\']) && !id.chars().any(char::is_control))
        .then(|| id.to_owned())
}

/// The pin Core forwards for one call.
///
/// - Composio-shaped ids (`GMAIL_SEND_EMAIL`) and account operations on a
///   toolkit (`connect` on `gmail`) are matched by their toolkit brand.
/// - Treg endpoint ids are matched by the brand their catalog row names.
/// - With no brand pinned to Composio, a Treg pin can only keep the default
///   order, so no catalog read is made for it.
pub(crate) async fn pin_for_call(
    pins: &Result<ProviderPins>,
    tool_id: &str,
    operation: Option<&str>,
    lookup: &dyn BrandLookup,
) -> Option<ProviderPin> {
    let pins = match pins {
        Ok(pins) => pins,
        // Unreadable preferences: the user's choice is unknown, so keep the
        // call on the provider they can always pick.
        Err(_) => return Some(ProviderPin::Composio),
    };
    if !pins.any_composio() {
        return None;
    }
    if is_composio_action_slug(tool_id) {
        let candidates = composio_brand_candidates(tool_id);
        return pins.strongest(candidates.iter().map(String::as_str));
    }
    let by_endpoint = async {
        match lookup.treg_brand(tool_id).await {
            TregBrand::Brand(brand) => pins.for_brand(&brand),
            // A brand is pinned to Composio and this endpoint cannot be tied to
            // one: Gateway may still serve it on Treg (an operator-priced id, a
            // catalog Core reads differently), so keep it on Composio.
            TregBrand::NotListed | TregBrand::Unreadable => Some(ProviderPin::Composio),
        }
    };
    if matches!(operation, Some("connect" | "disconnect" | "capabilities")) {
        let by_toolkit = pins.for_brand(&integration_brand_slug(tool_id));
        // A Treg endpoint id has dots; a toolkit id never does. An account
        // operation naming one must not dodge the endpoint's own brand pin, so
        // the stronger of the two readings wins (Gateway also refuses account
        // operations on Treg).
        if !tool_id.contains('.') {
            return by_toolkit;
        }
        return match (by_toolkit, by_endpoint.await) {
            (Some(ProviderPin::Composio), _) | (_, Some(ProviderPin::Composio)) => {
                Some(ProviderPin::Composio)
            }
            (first, second) => first.or(second),
        };
    }
    by_endpoint.await
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    struct FakeLookup {
        answer: TregBrand,
        reads: AtomicUsize,
    }

    impl FakeLookup {
        fn new(answer: TregBrand) -> Self {
            Self {
                answer,
                reads: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait::async_trait]
    impl BrandLookup for FakeLookup {
        async fn treg_brand(&self, _endpoint_id: &str) -> TregBrand {
            self.reads.fetch_add(1, Ordering::SeqCst);
            self.answer.clone()
        }
    }

    #[tokio::test]
    async fn no_composio_pin_needs_no_catalog_read() {
        let lookup = FakeLookup::new(TregBrand::Brand("x".to_owned()));
        for pins in [
            ProviderPins::default(),
            ProviderPins::from_pairs(&[("x", "treg")]),
        ] {
            assert_eq!(
                pin_for_call(&Ok(pins), "x.post.create", None, &lookup).await,
                None
            );
        }
        assert_eq!(lookup.reads.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_treg_endpoint_takes_its_brands_pin() {
        let pins = Ok(ProviderPins::from_pairs(&[
            ("x", "composio"),
            ("youtube", "treg"),
        ]));
        let x = FakeLookup::new(TregBrand::Brand("x".to_owned()));
        assert_eq!(
            pin_for_call(&pins, "x.post.create", None, &x).await,
            Some(ProviderPin::Composio)
        );
        let youtube = FakeLookup::new(TregBrand::Brand("youtube".to_owned()));
        assert_eq!(
            pin_for_call(&pins, "youtube.video.detail", None, &youtube).await,
            Some(ProviderPin::Treg)
        );
        let other = FakeLookup::new(TregBrand::Brand("reddit".to_owned()));
        assert_eq!(
            pin_for_call(&pins, "reddit.post.list", None, &other).await,
            None
        );
    }

    #[tokio::test]
    async fn an_account_operation_on_a_treg_endpoint_id_keeps_the_endpoints_pin() {
        let pins = Ok(ProviderPins::from_pairs(&[("x", "composio")]));
        let x = FakeLookup::new(TregBrand::Brand("x".to_owned()));
        for operation in ["connect", "disconnect", "capabilities"] {
            assert_eq!(
                pin_for_call(&pins, "x.post.create", Some(operation), &x).await,
                Some(ProviderPin::Composio),
                "{operation}"
            );
        }
        // A toolkit id is still read by its toolkit brand alone.
        let unused = FakeLookup::new(TregBrand::Brand("reddit".to_owned()));
        assert_eq!(
            pin_for_call(&pins, "x", Some("connect"), &unused).await,
            Some(ProviderPin::Composio)
        );
        assert_eq!(unused.reads.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn an_unreadable_catalog_or_preferences_fails_toward_composio() {
        let pins = Ok(ProviderPins::from_pairs(&[("x", "composio")]));
        let unreadable = FakeLookup::new(TregBrand::Unreadable);
        assert_eq!(
            pin_for_call(&pins, "youtube.video.detail", None, &unreadable).await,
            Some(ProviderPin::Composio)
        );
        // An endpoint that cannot be tied to a brand stays on Composio too.
        let not_listed = FakeLookup::new(TregBrand::NotListed);
        assert_eq!(
            pin_for_call(&pins, "nowhere.endpoint", None, &not_listed).await,
            Some(ProviderPin::Composio)
        );
        let unreadable_prefs: Result<ProviderPins> =
            ProviderPins::from_read::<&str>(Err("database is locked"));
        assert_eq!(
            pin_for_call(&unreadable_prefs, "anything", None, &not_listed).await,
            Some(ProviderPin::Composio)
        );
    }

    #[tokio::test]
    async fn composio_slugs_and_toolkit_operations_match_by_toolkit_brand() {
        let pins = Ok(ProviderPins::from_pairs(&[
            ("googlemaps", "composio"),
            ("youtube", "treg"),
        ]));
        let lookup = FakeLookup::new(TregBrand::Unreadable);
        assert_eq!(
            pin_for_call(&pins, "GOOGLE_MAPS_GEOCODE", Some("execute"), &lookup).await,
            Some(ProviderPin::Composio)
        );
        assert_eq!(
            pin_for_call(&pins, "YOUTUBE_VIDEOS_LIST", Some("execute"), &lookup).await,
            Some(ProviderPin::Treg)
        );
        assert_eq!(
            pin_for_call(&pins, "GMAIL_SEND_EMAIL", Some("execute"), &lookup).await,
            None
        );
        assert_eq!(
            pin_for_call(&pins, "googlemaps", Some("connect"), &lookup).await,
            Some(ProviderPin::Composio)
        );
        assert_eq!(lookup.reads.load(Ordering::SeqCst), 0, "no catalog read");
    }

    #[test]
    fn tool_ids_are_normalized_as_gateway_reads_them() {
        assert_eq!(
            normalized_tool_id(" x.post.create ").as_deref(),
            Some("x.post.create")
        );
        assert_eq!(
            normalized_tool_id("x.post.create\u{a0}").as_deref(),
            Some("x.post.create")
        );
        for bad in ["", "  ", "x/post", "x\\post", "x.post\u{0}"] {
            assert_eq!(normalized_tool_id(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn composio_brand_candidates_cover_every_toolkit_prefix() {
        assert_eq!(
            composio_brand_candidates("GOOGLE_MAPS_GEOCODE"),
            vec!["google", "googlemaps", "googlemapsgeocode"]
        );
        assert_eq!(
            composio_brand_candidates("HACKERNEWS_GET_USER")[0],
            "hackernews"
        );
        assert!(is_composio_action_slug("GMAIL_SEND_EMAIL"));
        assert!(!is_composio_action_slug("x.post.create"));
        assert!(!is_composio_action_slug("gmail"));
    }

    #[test]
    fn endpoint_brand_matches_the_store_slug() {
        let detail = serde_json::json!({"endpoint": {
            "id": "crawl4ai.github.repo.files",
            "platform": "github",
            "platform_label": "GitHub"
        }});
        assert_eq!(endpoint_brand(&detail).as_deref(), Some("github"));
        let slug_only = serde_json::json!({"endpoint": {"platform": "google-ads"}});
        assert_eq!(endpoint_brand(&slug_only).as_deref(), Some("googleads"));
        assert_eq!(endpoint_brand(&serde_json::json!({"endpoint": {}})), None);
    }
}
