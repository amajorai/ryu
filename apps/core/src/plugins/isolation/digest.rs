//! Manifest digests that bind provenance and compiled first-party trust.

use crate::plugin_manifest::PluginManifest;

#[must_use]
pub fn manifest_sha256(manifest: &PluginManifest) -> String {
    use sha2::{Digest, Sha256};
    let bytes = serde_json::to_vec(manifest).unwrap_or_default();
    format!("{:x}", Sha256::digest(bytes))
}

/// Digest the capability-bearing manifest shape used for compiled first-party
/// trust decisions.
///
/// Standalone bundles add `ui_code_sha256` and, for inline backends,
/// `backend_sha256` after reading the satellite's carriage. Those fields protect
/// the carried bytes at the install boundary, but they are not capability or
/// lifecycle declarations. Including them in the compiled-manifest identity
/// would make every standalone build look like a modified Community package and
/// would disable its manifest-owned sidecar/MCP lanes. Signed marketplace
/// provenance continues to use [`manifest_sha256`] over the exact accepted
/// manifest bytes.
///
/// The digest is over canonical JSON (object keys sorted recursively), not the
/// map's own order: `agent-client-protocol` turns on `serde_json/preserve_order`
/// for the whole build, where `Map::remove` swaps the last key into the removed
/// slot, so dropping the carriage fields would otherwise reorder the object and
/// change the digest.
#[must_use]
pub fn manifest_sha256_for_trust(manifest: &PluginManifest) -> String {
    let mut value = serde_json::to_value(manifest).unwrap_or_default();
    if let Some(object) = value.as_object_mut() {
        object.remove("ui_code_sha256");
        object.remove("backend_sha256");
    }
    ryu_safe_actions::sha256_canonical(&value).unwrap_or_default()
}
