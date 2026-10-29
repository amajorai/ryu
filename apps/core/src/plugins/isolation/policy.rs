//! The host-access trust policy: the user allowlist, enforcement flag and
//! revocation list, and the decisions made from them.

use super::*;

/// Whether `entry` (`id` or `id@version`) revokes `id` at `version`.
#[must_use]
pub fn revocation_matches(entry: &str, id: &str, version: &str) -> bool {
    if entry == id {
        return true;
    }
    entry
        .strip_prefix(id)
        .and_then(|rest| rest.strip_prefix('@'))
        .is_some_and(|pinned| pinned == version)
}

impl TrustPolicy {
    /// Resolve the trust basis for one plugin.
    ///
    /// The ordering is deliberate and **fail-closed**: the user allowlist is
    /// consulted *last* and can only re-label a plugin whose provenance already
    /// vouches for its publisher. Listing a sideloaded id does nothing. Without
    /// that rule the preference is a universal sandbox bypass that any process
    /// able to write one preference key could arm.
    #[must_use]
    pub fn resolve_trust(&self, id: &str, provenance: Option<&PluginProvenance>) -> TrustBasis {
        if crate::plugins::builtins::is_system_plugin(id) {
            return TrustBasis::SystemPlugin;
        }
        // No provenance captured ⇒ nothing is known ⇒ nothing is trusted. This is
        // the migration path for every record installed before the column existed.
        let Some(p) = provenance else {
            return TrustBasis::Untrusted;
        };
        // A compiled manifest is an official Ryu artifact, but compilation is
        // not the same thing as being part of the system. Only the explicit
        // SYSTEM_PLUGINS allowlist above receives the non-removable
        // SystemPlugin basis. This distinction lets ordinary first-party
        // packages move to the verified marketplace without changing their
        // trust semantics.
        if p.builtin {
            return TrustBasis::OfficialMarketplace;
        }
        let from_official = p.source_id.as_deref() == Some(OFFICIAL_MARKETPLACE_SOURCE_ID);
        let signed_official = from_official && p.signature_verified;
        let basis = if p.org_verified && signed_official {
            TrustBasis::VerifiedPublisher {
                org: p.publisher_org.clone(),
                tier: p.org_verified_tier.clone(),
            }
        } else if signed_official {
            TrustBasis::OfficialMarketplace
        } else {
            // A third-party source can claim `orgVerified` in its own JSON. Ryu's
            // blue check is an admin decision in Ryu's own control plane, so a
            // claim carried by any other source is publisher-controlled data and
            // is not a trust signal.
            TrustBasis::Untrusted
        };
        if self.trusted_ids.contains(id) && basis.vouches() {
            return TrustBasis::UserAllowlisted;
        }
        basis
    }

    /// [`Self::resolve_trust`] bound to the manifest Core actually loaded.
    ///
    /// Provenance vouches for the manifest that was accepted at install, not for
    /// whatever later sits on disk under the same id. When the loaded manifest no
    /// longer matches the recorded binding ([`manifest_drifted`]) trust is
    /// downgraded to [`TrustBasis::Untrusted`] for every plugin, not only Core
    /// ids. A record with no provenance whose manifest is the exact one compiled
    /// into this binary reads like compiled provenance: those bytes are Ryu's own.
    #[must_use]
    pub fn resolve_trust_for_manifest(
        &self,
        manifest: &PluginManifest,
        provenance: Option<&PluginProvenance>,
    ) -> TrustBasis {
        if crate::plugins::builtins::is_system_plugin(&manifest.id) {
            return TrustBasis::SystemPlugin;
        }
        if manifest_drifted(manifest, provenance) {
            return TrustBasis::Untrusted;
        }
        if provenance.is_none() && crate::plugins::builtins::is_exact_compiled_manifest(manifest) {
            return self.resolve_trust(&manifest.id, Some(&PluginProvenance::builtin()));
        }
        self.resolve_trust(&manifest.id, provenance)
    }

    /// The revocation entry that blocks `id` at `version`, if any.
    #[must_use]
    pub fn revocation_for(&self, id: &str, version: &str) -> Option<&str> {
        self.revoked
            .iter()
            .find(|entry| revocation_matches(entry, id, version))
            .map(String::as_str)
    }

    /// Whether Core must refuse to enable this plugin or run its host-access
    /// lanes (native sidecars, external runtimes, MCP servers, Pi extensions and
    /// LSP servers). `version` is the INSTALLED record's version.
    ///
    /// Revocation applies whatever the plugin declares. The trust requirement
    /// applies only when [`REQUIRE_TRUST_PREF`] is on and the plugin actually
    /// declares a host-access lane that nothing vouches for.
    #[must_use]
    pub fn host_access_refusal(
        &self,
        manifest: &PluginManifest,
        version: &str,
        provenance: Option<&PluginProvenance>,
    ) -> Option<HostAccessRefusal> {
        if let Some(entry) = self.revocation_for(&manifest.id, version) {
            return Some(HostAccessRefusal::Revoked {
                entry: entry.to_owned(),
            });
        }
        if !self.require_trust_for_host_access {
            return None;
        }
        resolve(manifest, provenance, self)
            .should_refuse_host_access(self)
            .then_some(HostAccessRefusal::UntrustedHostAccess)
    }
}

/// Load the node's host-access trust policy: the two preference keys plus the
/// local revocation list.
///
/// Preference reads fail SAFE: an unreadable allowlist is an empty one (nothing
/// extra trusted), and an unreadable enforcement flag is off (report, don't break).
/// Neither direction can be turned into a bypass by breaking the preferences store.
/// The revocation list lives in the plugin lifecycle store and is passed in by the
/// caller that already holds it.
pub async fn load_trust_policy(store: Option<&crate::plugins::PluginStore>) -> TrustPolicy {
    let revoked = match store {
        Some(store) => match store.list_revocations().await {
            Ok(rows) => rows.into_iter().map(|row| row.entry).collect(),
            Err(error) => {
                tracing::warn!("plugin revocation list unreadable: {error}");
                BTreeSet::new()
            }
        },
        None => BTreeSet::new(),
    };
    let Ok(prefs) = crate::server::preferences::PreferencesStore::open_default() else {
        return TrustPolicy {
            revoked,
            ..TrustPolicy::default()
        };
    };
    let trusted_ids = match prefs.get(TRUSTED_IDS_PREF).await {
        Ok(Some(raw)) => serde_json::from_str::<Vec<String>>(&raw)
            .unwrap_or_default()
            .into_iter()
            .collect(),
        _ => BTreeSet::new(),
    };
    let require_trust_for_host_access = matches!(
        prefs.get(REQUIRE_TRUST_PREF).await,
        Ok(Some(v)) if v.trim() == "1" || v.trim().eq_ignore_ascii_case("true")
    );
    TrustPolicy {
        trusted_ids,
        require_trust_for_host_access,
        revoked,
    }
}
