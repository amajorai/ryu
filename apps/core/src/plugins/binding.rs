//! The **capability binding registry** — Track A of the platform-decomposition
//! handoff.
//!
//! A plugin declares an *abstract* dependency (`requires.capabilities = [{rag}]`)
//! instead of naming a concrete provider plugin. This module resolves each such
//! edge to the concrete provider app that `provides` the capability, so the app can
//! be built at any layer (raw `requires: [rag]` for control, `requires: [spaces]`
//! for convenience) and a provider can be swapped (rag → GraphRAG) without touching
//! consumers.
//!
//! ## The resolution ladder (mirrors the Gateway's `ModelRouter`)
//!
//! For one required capability, over the candidate manifest set:
//! 1. Collect every candidate that `provides` the capability.
//! 2. **No provider** ⇒ [`BindingError::Unprovided`].
//! 3. A **user override** (`BindingConfig.overrides[cap] = app-id`) picks the
//!    provider explicitly — it must be among the candidates, else
//!    [`BindingError::OverrideNotProvider`].
//! 4. Exactly **one** provider ⇒ that one (the zero-config happy path).
//! 5. **Two or more** with no override ⇒ [`BindingError::Ambiguous`], an *explicit
//!    refusal* surfaced to the user — never a silent first-match pick.
//! 6. The chosen provider's [`ProvidesEntry::version`] must satisfy the consumer's
//!    [`CapabilityReq::min_version`] floor, else [`BindingError::VersionUnsatisfied`].
//!    The floor is checked against the *capability* version, not the provider app's
//!    semver.
//!
//! ## Graph lowering (why the topological machinery is untouched)
//!
//! Once a capability binds to a provider app-id, [`lower_manifests`] materializes it
//! as a **bare** [`AppDependency`] (`min_version: None`) appended to the consumer's
//! `requires.apps`. `crate::plugins::graph` reads edges only through
//! [`PluginManifest::dependencies`], so a lowered capability edge is indistinguishable
//! from a hand-written app dep: enable order, cycle detection, `dependents_of`, and
//! disable-blast-radius all work unchanged. The edge is **bare** deliberately — the
//! graph's `min_version` gate compares against the provider's *app* version, which is
//! the wrong number for a *capability* floor; that floor is enforced here at bind
//! time instead.
//!
//! ## The enabled-set invariant (why disable-safety holds without a binding record)
//!
//! Governance enforces: **every enabled consumer binds deterministically over the
//! ENABLED set** (single provider, or an override — never ambiguous, never unbound).
//! Two enable-time gates keep it true:
//! 1. A consumer with an ambiguous/unbound capability cannot enable.
//! 2. Enabling a plugin re-validates the WHOLE post-enable enabled set (every
//!    consumer, not just the target) — so enabling a *second* provider that would
//!    render an already-enabled consumer ambiguous is refused, naming that consumer.
//!
//! Both gates resolve over the ENABLED set (what the broker actually sees at call
//! time), not the installed set — a merely-installed-but-disabled second provider
//! introduces no ambiguity. Because the invariant holds, the same lowering run over
//! the enabled set at disable time reconstructs the identical consumer→provider edge,
//! so disable-safety (a bound consumer blocks its provider's disable) holds
//! symmetrically without persisting a per-consumer binding record.

use std::collections::BTreeMap;
use std::sync::{OnceLock, RwLock};

use crate::plugin_manifest::PluginManifest;
use crate::plugin_manifest::{parse_min_version, AppDependency, CapabilityReq};

/// User-supplied binding overrides — the tie-breaker when two or more installed
/// plugins provide the same capability. Absent/empty for the zero-config case.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BindingConfig {
    /// `capability name → chosen provider app-id`. An entry wins over the
    /// auto-pick, exactly as a user `model_map` entry shadows a built-in rule in
    /// the Gateway's `ModelRouter`.
    pub overrides: BTreeMap<String, String>,
}

/// The process-wide active binding config the lifecycle reads (loaded from
/// preferences at startup, refreshable via [`set_active_config`]). Kept as an
/// ambient global — like [`crate::profile`]'s node profile — so the many
/// `enable_app`/`disable_app` call sites need no extra parameter. Defaults to
/// no overrides (the zero-config path), so an ambiguous multi-provider capability
/// is refused until the user sets an override.
fn cell() -> &'static RwLock<BindingConfig> {
    static ACTIVE: OnceLock<RwLock<BindingConfig>> = OnceLock::new();
    ACTIVE.get_or_init(|| RwLock::new(BindingConfig::default()))
}

/// A snapshot of the active binding config (cheap clone; overrides are few).
pub fn active_config() -> BindingConfig {
    cell().read().map(|c| c.clone()).unwrap_or_default()
}

/// Replace the active binding config (e.g. after loading overrides from
/// preferences, or when the user changes a binding). Re-running enable/disable
/// resolution afterwards re-checks cycles + dependents against the new bindings.
pub fn set_active_config(cfg: BindingConfig) {
    if let Ok(mut c) = cell().write() {
        *c = cfg;
    }
}

/// The preferences key under which the user's capability→provider overrides are
/// persisted (a JSON object `{ "<capability>": "<provider-app-id>" }`).
pub const BINDING_OVERRIDES_PREF_KEY: &str = "binding.overrides";

/// Parse a persisted overrides JSON object into a [`BindingConfig`]. An empty or
/// malformed value yields the default (no overrides) — never an error that would
/// block startup.
pub fn config_from_overrides_json(json: &str) -> BindingConfig {
    let overrides = serde_json::from_str::<BTreeMap<String, String>>(json).unwrap_or_default();
    BindingConfig { overrides }
}

/// Serialize a [`BindingConfig`]'s overrides to the persisted JSON object form.
pub fn overrides_to_json(config: &BindingConfig) -> String {
    serde_json::to_string(&config.overrides).unwrap_or_else(|_| "{}".to_owned())
}

/// One resolved capability→provider binding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    /// The capability that was required.
    pub capability: String,
    /// The provider plugin's app-id the capability bound to.
    pub provider_id: String,
    /// The provider's declared capability version (from its [`ProvidesEntry`]).
    pub provided_version: String,
}

/// Why a required capability could not be bound. Every variant is an *explicit*,
/// user-surfaceable refusal — the registry never silently drops or guesses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BindingError {
    /// No candidate plugin provides the capability at all.
    Unprovided { capability: String },
    /// Two or more candidates provide it and no override disambiguates — the user
    /// must choose (set an override) before the consumer can enable.
    Ambiguous {
        capability: String,
        providers: Vec<String>,
    },
    /// An override names a plugin that does not provide the capability.
    OverrideNotProvider { capability: String, chosen: String },
    /// The chosen provider's capability version does not satisfy the floor.
    VersionUnsatisfied {
        capability: String,
        provider: String,
        required: String,
        provided: String,
    },
    /// The floor string is malformed (defence in depth; load-validation already
    /// rejects it).
    InvalidVersionReq {
        capability: String,
        requirement: String,
        reason: String,
    },
}

impl BindingError {
    /// A stable machine token (for JSON error payloads / logging).
    pub fn code(&self) -> &'static str {
        match self {
            BindingError::Unprovided { .. } => "capability_unprovided",
            BindingError::Ambiguous { .. } => "capability_ambiguous",
            BindingError::OverrideNotProvider { .. } => "capability_override_not_provider",
            BindingError::VersionUnsatisfied { .. } => "capability_version_unsatisfied",
            BindingError::InvalidVersionReq { .. } => "capability_invalid_version_req",
        }
    }
}

impl std::fmt::Display for BindingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BindingError::Unprovided { capability } => {
                write!(
                    f,
                    "no available provider for capability '{capability}' (none installed, or the provider is disabled)"
                )
            }
            BindingError::Ambiguous {
                capability,
                providers,
            } => write!(
                f,
                "capability '{capability}' is provided by multiple plugins ({}) — set a binding override to choose one",
                providers.join(", ")
            ),
            BindingError::OverrideNotProvider { capability, chosen } => write!(
                f,
                "binding override for '{capability}' names '{chosen}', which does not provide it"
            ),
            BindingError::VersionUnsatisfied {
                capability,
                provider,
                required,
                provided,
            } => write!(
                f,
                "provider '{provider}' offers capability '{capability}' v{provided}, which does not satisfy the required '{required}'"
            ),
            BindingError::InvalidVersionReq {
                capability,
                requirement,
                reason,
            } => write!(
                f,
                "capability '{capability}' has an invalid version requirement '{requirement}': {reason}"
            ),
        }
    }
}

impl std::error::Error for BindingError {}

/// The binding registry — a thin resolver over a candidate manifest set plus the
/// user override config. Borrows both; constructing it is free.
pub struct BindingRegistry<'a> {
    config: &'a BindingConfig,
    candidates: &'a [PluginManifest],
}

impl<'a> BindingRegistry<'a> {
    /// Build a registry over `candidates` (the manifest set a capability may bind
    /// to — the *installed* set at enable time, the *enabled* set at disable time)
    /// and the user override `config`.
    pub fn new(config: &'a BindingConfig, candidates: &'a [PluginManifest]) -> Self {
        Self { config, candidates }
    }

    /// Resolve one required capability to a concrete provider binding, applying the
    /// ladder in the module docs. Pure — no I/O, no mutation.
    pub fn resolve(&self, req: &CapabilityReq) -> Result<Binding, BindingError> {
        // 1. Collect providers of this capability (the provider's own ProvidesEntry
        //    carries the served capability version).
        let providers: Vec<(&PluginManifest, &crate::plugin_manifest::ProvidesEntry)> =
            self.candidates
                .iter()
                .filter_map(|m| {
                    m.provided_capabilities()
                        .iter()
                        .find(|p| p.capability == req.capability)
                        .map(|p| (m, p))
                })
                .collect();

        if providers.is_empty() {
            return Err(BindingError::Unprovided {
                capability: req.capability.clone(),
            });
        }

        // 2. Pick: override > single provider > ambiguous.
        let (provider, entry) = if let Some(chosen) = self.config.overrides.get(&req.capability) {
            *providers
                .iter()
                .find(|(m, _)| &m.id == chosen)
                .ok_or_else(|| BindingError::OverrideNotProvider {
                    capability: req.capability.clone(),
                    chosen: chosen.clone(),
                })?
        } else if providers.len() == 1 {
            providers[0]
        } else {
            let mut ids: Vec<String> = providers.iter().map(|(m, _)| m.id.clone()).collect();
            ids.sort();
            return Err(BindingError::Ambiguous {
                capability: req.capability.clone(),
                providers: ids,
            });
        };

        // 3. Capability-version floor (checked against ProvidesEntry.version).
        if let Some(min) = &req.min_version {
            let want =
                parse_min_version(min).map_err(|reason| BindingError::InvalidVersionReq {
                    capability: req.capability.clone(),
                    requirement: min.clone(),
                    reason,
                })?;
            let have = semver::Version::parse(&entry.version).map_err(|e| {
                BindingError::InvalidVersionReq {
                    capability: req.capability.clone(),
                    requirement: entry.version.clone(),
                    reason: format!("provider version is not valid semver: {e}"),
                }
            })?;
            if !want.matches(&have) {
                return Err(BindingError::VersionUnsatisfied {
                    capability: req.capability.clone(),
                    provider: provider.id.clone(),
                    required: min.clone(),
                    provided: entry.version.clone(),
                });
            }
        }

        Ok(Binding {
            capability: req.capability.clone(),
            provider_id: provider.id.clone(),
            provided_version: entry.version.clone(),
        })
    }

    /// Resolve every required capability of one plugin. Returns the successful
    /// bindings and, separately, every capability that failed — so a caller can
    /// refuse enable with the full list rather than one error at a time.
    pub fn resolve_all(
        &self,
        manifest: &PluginManifest,
    ) -> (Vec<Binding>, Vec<BindingError>) {
        let mut ok = Vec::new();
        let mut errs = Vec::new();
        for req in manifest.required_capabilities() {
            match self.resolve(req) {
                Ok(b) => ok.push(b),
                Err(e) => errs.push(e),
            }
        }
        (ok, errs)
    }
}

/// Scan a candidate set (the **post-enable enabled set** at the enable gate, or the
/// enabled set generally) and return the first consumer whose required capabilities
/// do not all bind, with the failing [`BindingError`]. `None` ⇒ every consumer binds
/// deterministically — the enabled-set invariant (see module docs) holds.
///
/// This is the gate that catches the "enable a second provider ⇒ orphan an existing
/// consumer" hole: run over `currently_enabled ∪ about_to_enable`, it flags the
/// pre-existing consumer that the new provider would make ambiguous, so the enable is
/// refused instead of silently breaking that consumer's broker calls + disable-safety.
pub fn first_binding_error(
    candidates: &[PluginManifest],
    config: &BindingConfig,
) -> Option<(String, BindingError)> {
    let registry = BindingRegistry::new(config, candidates);
    for m in candidates {
        if let Some(err) = registry.resolve_all(m).1.into_iter().next() {
            return Some((m.id.clone(), err));
        }
    }
    None
}

/// Lower every plugin's required capabilities in `manifests` into **bare** app-id
/// graph edges, returning a cloned manifest set the `graph` resolver can consume
/// unchanged. A capability that fails to bind (unprovided / ambiguous) is **skipped**
/// here — the graph is a statement about presence and order; bind *errors* are
/// surfaced separately by the enable path via [`BindingRegistry::resolve_all`], which
/// refuses enable before this lowering ever runs. Duplicate edges (a capability that
/// resolves to a plugin already named in `requires.apps`) are de-duplicated so the
/// graph's diamond handling isn't relied on for a self-inflicted double.
pub fn lower_manifests(manifests: &[PluginManifest], config: &BindingConfig) -> Vec<PluginManifest> {
    let registry = BindingRegistry::new(config, manifests);
    manifests
        .iter()
        .map(|m| {
            let (bindings, _errs) = registry.resolve_all(m);
            if bindings.is_empty() {
                return m.clone();
            }
            let mut lowered = m.clone();
            let requires = lowered
                .requires
                .get_or_insert_with(crate::plugin_manifest::Requires::default);
            for b in bindings {
                // Never self-edge (a plugin providing a capability it also requires),
                // and never duplicate an existing app edge.
                if b.provider_id == m.id {
                    continue;
                }
                if requires.apps.iter().any(|a| a.id == b.provider_id) {
                    continue;
                }
                requires.apps.push(AppDependency {
                    id: b.provider_id,
                    min_version: None,
                });
            }
            lowered
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_manifest::{ProvidesEntry, Requires};

    fn provider(id: &str, cap: &str, version: &str) -> PluginManifest {
        PluginManifest {
            id: id.to_owned(),
            name: id.to_owned(),
            version: "1.0.0".to_owned(),
            provides: vec![ProvidesEntry {
                capability: cap.to_owned(),
                version: version.to_owned(),
                sidecar: None,
                route: None,
                grant: None,
            }],
            ..Default::default()
        }
    }

    fn consumer(id: &str, cap: &str, min: Option<&str>) -> PluginManifest {
        PluginManifest {
            id: id.to_owned(),
            name: id.to_owned(),
            version: "1.0.0".to_owned(),
            requires: Some(Requires {
                capabilities: vec![CapabilityReq {
                    capability: cap.to_owned(),
                    min_version: min.map(str::to_owned),
                }],
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    fn req(cap: &str, min: Option<&str>) -> CapabilityReq {
        CapabilityReq {
            capability: cap.to_owned(),
            min_version: min.map(str::to_owned),
        }
    }

    #[test]
    fn overrides_json_round_trips_and_tolerates_garbage() {
        let mut cfg = BindingConfig::default();
        cfg.overrides.insert("rag".to_owned(), "graphrag".to_owned());
        cfg.overrides.insert("tts".to_owned(), "piper".to_owned());
        let json = overrides_to_json(&cfg);
        assert_eq!(config_from_overrides_json(&json), cfg);
        // Malformed / empty ⇒ default (never blocks startup).
        assert_eq!(config_from_overrides_json("not json"), BindingConfig::default());
        assert_eq!(config_from_overrides_json("{}"), BindingConfig::default());
    }

    #[test]
    fn single_provider_binds_zero_config() {
        let set = vec![provider("rag-app", "rag", "1.5.0"), consumer("spaces", "rag", None)];
        let cfg = BindingConfig::default();
        let reg = BindingRegistry::new(&cfg, &set);
        let b = reg.resolve(&req("rag", None)).expect("binds");
        assert_eq!(b.provider_id, "rag-app");
        assert_eq!(b.provided_version, "1.5.0");
    }

    #[test]
    fn no_provider_is_unprovided() {
        let set = vec![consumer("spaces", "rag", None)];
        let cfg = BindingConfig::default();
        let reg = BindingRegistry::new(&cfg, &set);
        assert_eq!(
            reg.resolve(&req("rag", None)).unwrap_err(),
            BindingError::Unprovided {
                capability: "rag".to_owned()
            }
        );
    }

    #[test]
    fn two_providers_no_override_is_ambiguous_not_silent_pick() {
        let set = vec![
            provider("graphrag", "rag", "2.0.0"),
            provider("vecrag", "rag", "1.0.0"),
        ];
        let cfg = BindingConfig::default();
        let reg = BindingRegistry::new(&cfg, &set);
        match reg.resolve(&req("rag", None)).unwrap_err() {
            BindingError::Ambiguous { providers, .. } => {
                assert_eq!(providers, vec!["graphrag".to_owned(), "vecrag".to_owned()]);
            }
            other => panic!("expected Ambiguous, got {other:?}"),
        }
    }

    #[test]
    fn override_disambiguates_two_providers() {
        let set = vec![
            provider("graphrag", "rag", "2.0.0"),
            provider("vecrag", "rag", "1.0.0"),
        ];
        let mut cfg = BindingConfig::default();
        cfg.overrides.insert("rag".to_owned(), "vecrag".to_owned());
        let reg = BindingRegistry::new(&cfg, &set);
        assert_eq!(reg.resolve(&req("rag", None)).unwrap().provider_id, "vecrag");
    }

    #[test]
    fn override_naming_non_provider_is_rejected() {
        let set = vec![provider("rag-app", "rag", "1.0.0")];
        let mut cfg = BindingConfig::default();
        cfg.overrides.insert("rag".to_owned(), "ghost".to_owned());
        let reg = BindingRegistry::new(&cfg, &set);
        assert_eq!(
            reg.resolve(&req("rag", None)).unwrap_err(),
            BindingError::OverrideNotProvider {
                capability: "rag".to_owned(),
                chosen: "ghost".to_owned()
            }
        );
    }

    #[test]
    fn version_floor_checks_capability_version_not_app_version() {
        // Provider APP version 1.0.0 but CAPABILITY version 2.0.0 satisfies a
        // floor of 1.5.0 — proving the floor uses provides.version, not app semver.
        let set = vec![provider("rag-app", "rag", "2.0.0")];
        let cfg = BindingConfig::default();
        let reg = BindingRegistry::new(&cfg, &set);
        assert!(reg.resolve(&req("rag", Some("1.5.0"))).is_ok());
    }

    #[test]
    fn version_floor_unsatisfied_is_rejected() {
        let set = vec![provider("rag-app", "rag", "1.0.0")];
        let cfg = BindingConfig::default();
        let reg = BindingRegistry::new(&cfg, &set);
        assert_eq!(
            reg.resolve(&req("rag", Some("2.0.0"))).unwrap_err(),
            BindingError::VersionUnsatisfied {
                capability: "rag".to_owned(),
                provider: "rag-app".to_owned(),
                required: "2.0.0".to_owned(),
                provided: "1.0.0".to_owned(),
            }
        );
    }

    #[test]
    fn lowering_appends_bare_app_edge() {
        let set = vec![
            provider("rag-app", "rag", "1.5.0"),
            consumer("spaces", "rag", Some("1.0.0")),
        ];
        let cfg = BindingConfig::default();
        let lowered = lower_manifests(&set, &cfg);
        let spaces = lowered.iter().find(|m| m.id == "spaces").unwrap();
        // Exactly one bare app edge to the provider (min_version stripped).
        assert_eq!(spaces.dependencies().len(), 1);
        assert_eq!(spaces.dependencies()[0].id, "rag-app");
        assert_eq!(spaces.dependencies()[0].min_version, None);
    }

    #[test]
    fn lowering_skips_unbindable_capability() {
        // No provider for 'rag' ⇒ the edge is skipped (enable path refuses
        // separately); lowering never panics or fabricates an edge.
        let set = vec![consumer("spaces", "rag", None)];
        let cfg = BindingConfig::default();
        let lowered = lower_manifests(&set, &cfg);
        let spaces = lowered.iter().find(|m| m.id == "spaces").unwrap();
        assert_eq!(spaces.dependencies().len(), 0);
    }

    #[test]
    fn finetune_builtin_loads_after_the_kind_tag_fix() {
        // Regression: com.ryu.finetune (default-on, a Python-sidecar app) silently
        // never loaded — the SidecarProcess `#[serde(tag="kind")]` consumed the inner
        // ExternalRuntimeConfig.kind, so its manifest failed to parse and it was
        // absent from the built-in set. The inner kind now defaults; it must load.
        let builtins = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        assert!(
            builtins.iter().any(|m| m.id == "com.ryu.finetune"),
            "com.ryu.finetune now loads as a built-in"
        );
    }

    #[test]
    fn builtin_rag_capability_resolves_to_engines_through_the_real_graph() {
        // End-to-end over the SHIPPED manifests (not synthetic): com.ryu.rag declares
        // `requires.capabilities=[engines]`, the `engines` built-in declares
        // `provides=[engines]`, so the binding resolves + lowers to a real app edge
        // and the graph orders engines before rag / refuses disabling engines.
        use crate::plugins::graph;
        let builtins = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let cfg = BindingConfig::default();

        // rag requires the `engines` capability, bound to the `engines` app.
        let rag = builtins
            .iter()
            .find(|m| m.id == "com.ryu.rag")
            .expect("com.ryu.rag built-in");
        let reg = BindingRegistry::new(&cfg, &builtins);
        let (bindings, errs) = reg.resolve_all(rag);
        assert!(errs.is_empty(), "rag's capabilities all bind: {errs:?}");
        assert!(
            bindings.iter().any(|b| b.provider_id == "engines"),
            "rag's `engines` capability binds to the engines app"
        );

        // Lowered, the graph pulls engines in before rag and lists rag as a dependent
        // of engines (so engines can't be disabled out from under it).
        let lowered = lower_manifests(&builtins, &cfg);
        let order = graph::resolve_enable_order("com.ryu.rag", &lowered).expect("resolves");
        let ei = order.iter().position(|id| id == "engines");
        let ri = order.iter().position(|id| id == "com.ryu.rag");
        assert!(
            ei < ri,
            "engines enabled before rag (order: {order:?})"
        );
        assert!(
            graph::dependents_of("engines", &lowered).contains(&"com.ryu.rag".to_owned()),
            "rag is a dependent of engines"
        );

        // The L2 chain: spaces requires the `rag` capability, so the enable order is
        // engines → rag → spaces, and disabling rag is blocked while spaces is enabled.
        let spaces_order =
            graph::resolve_enable_order("com.ryu.spaces", &lowered).expect("spaces resolves");
        let si = spaces_order.iter().position(|id| id == "com.ryu.spaces");
        let sri = spaces_order.iter().position(|id| id == "com.ryu.rag");
        let sei = spaces_order.iter().position(|id| id == "engines");
        assert!(
            sei < sri && sri < si,
            "engines → rag → spaces (order: {spaces_order:?})"
        );
        assert!(
            graph::dependents_of("com.ryu.rag", &lowered).contains(&"com.ryu.spaces".to_owned()),
            "spaces is a dependent of rag (rag can't be disabled under spaces)"
        );
    }

    #[test]
    fn enabling_second_provider_that_orphans_a_consumer_is_caught() {
        // The invariant the enable gate must uphold. C requires `rag`, bound to the
        // sole provider P1 → the enabled set binds cleanly.
        let one = vec![provider("p1", "rag", "1.0.0"), consumer("c", "rag", None)];
        assert!(
            first_binding_error(&one, &BindingConfig::default()).is_none(),
            "single provider ⇒ every consumer binds"
        );

        // Now a SECOND provider P2 joins the enabled set. C would become ambiguous —
        // `first_binding_error` (run by enable_app over the post-enable enabled set)
        // flags C, so enabling P2 is refused instead of silently 409-ing C's broker
        // calls and orphaning it on disable.
        let two = vec![
            provider("p1", "rag", "1.0.0"),
            provider("p2", "rag", "1.0.0"),
            consumer("c", "rag", None),
        ];
        let (plugin, err) =
            first_binding_error(&two, &BindingConfig::default()).expect("ambiguity caught");
        assert_eq!(plugin, "c", "the pre-existing consumer is named");
        assert!(matches!(err, BindingError::Ambiguous { .. }));

        // With an override the second provider is fine — C binds to the chosen one.
        let mut cfg = BindingConfig::default();
        cfg.overrides.insert("rag".to_owned(), "p2".to_owned());
        assert!(
            first_binding_error(&two, &cfg).is_none(),
            "override disambiguates ⇒ enable allowed"
        );
    }

    #[test]
    fn lowered_capability_drives_real_graph_enable_and_disable() {
        // The end-to-end governance seam: a capability edge, once lowered, is honored
        // by the REAL graph resolver — enable pulls the provider in first, and
        // disabling the provider while the consumer is enabled is refused.
        use crate::plugins::graph;
        let set = vec![
            provider("rag-app", "rag", "1.0.0"),
            consumer("spaces", "rag", None),
        ];
        let cfg = BindingConfig::default();
        let lowered = lower_manifests(&set, &cfg);

        // Enable order: provider before consumer.
        let order = graph::resolve_enable_order("spaces", &lowered).expect("resolves");
        assert_eq!(order, vec!["rag-app".to_owned(), "spaces".to_owned()]);

        // Disable safety: `spaces` is a dependent of `rag-app`, so disabling the
        // provider is blocked (BlockedByDependents blast radius includes it).
        let dependents = graph::dependents_of("rag-app", &lowered);
        assert_eq!(dependents, vec!["spaces".to_owned()]);
    }

    #[test]
    fn lowering_dedups_against_existing_app_edge() {
        // A consumer that names the provider BOTH as an app dep and via a capability
        // must end up with a single edge, not a self-inflicted duplicate.
        let mut spaces = consumer("spaces", "rag", None);
        spaces.requires.as_mut().unwrap().apps.push(AppDependency {
            id: "rag-app".to_owned(),
            min_version: Some("1.0.0".to_owned()),
        });
        let set = vec![provider("rag-app", "rag", "1.0.0"), spaces];
        let cfg = BindingConfig::default();
        let lowered = lower_manifests(&set, &cfg);
        let s = lowered.iter().find(|m| m.id == "spaces").unwrap();
        assert_eq!(s.dependencies().len(), 1, "no duplicate edge");
        // The original app edge (with its min_version) is preserved.
        assert_eq!(s.dependencies()[0].min_version, Some("1.0.0".to_owned()));
    }
}
