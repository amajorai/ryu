//! Definition witnesses: a public listing's run counts only while the runtime
//! still holds the exact definition that was installed from that listing.
//!
//! The fingerprint is over canonical JSON (object keys sorted recursively):
//! `serde_json/preserve_order` is on for the whole build, so the plain bytes
//! follow the order a definition's free-form JSON (tool `args`, `params`) was
//! saved in, and a rewrite that only reorders keys must not stop the count.
//! Witnesses saved before hold the digest of those insertion-order bytes; they
//! still match the same definition and are rewritten to the canonical form the
//! first time they do.

use serde::Serialize;

use super::{
    associate_marketplace_runtime, marketplace_runtime_identity, public_items_store,
    record_identity, save_public_items,
};

/// The fingerprint new witnesses store, and the insertion-order fingerprint
/// witnesses saved before the canonical form hold.
struct Fingerprints {
    canonical: String,
    legacy: String,
}

fn definition_fingerprints(definition: &impl Serialize) -> Option<Fingerprints> {
    use sha2::{Digest, Sha256};
    Some(Fingerprints {
        canonical: ryu_safe_actions::sha256_canonical(definition).ok()?,
        legacy: format!("{:x}", Sha256::digest(serde_json::to_vec(definition).ok()?)),
    })
}

/// How a stored witness relates to the definition being run.
#[derive(Debug, PartialEq, Eq)]
enum Witness {
    Canonical,
    Legacy,
    Mismatch,
}

fn compare(stored: Option<&String>, fingerprints: &Fingerprints) -> Witness {
    match stored {
        Some(stored) if *stored == fingerprints.canonical => Witness::Canonical,
        Some(stored) if *stored == fingerprints.legacy => Witness::Legacy,
        _ => Witness::Mismatch,
    }
}

pub fn witness_runtime_definition(
    kind: &str,
    listing: &str,
    runtime: &str,
    definition: &impl Serialize,
) {
    let Some(fingerprints) = definition_fingerprints(definition) else {
        return;
    };
    associate_marketplace_runtime(kind, listing, runtime);
    if let Ok(mut items) = public_items_store().lock() {
        if items.listing_ids.contains(&format!("{kind}:{listing}")) {
            items
                .definitions
                .insert(format!("{kind}:{runtime}"), fingerprints.canonical);
            if let Err(error) = save_public_items(&items) {
                tracing::warn!(%error, "public definition witness could not be saved");
            }
        }
    }
}

pub fn record_definition_run(kind: &str, runtime: &str, definition: &impl Serialize) {
    let Some(fingerprints) = definition_fingerprints(definition) else {
        return;
    };
    let key = format!("{kind}:{runtime}");
    let verified = public_items_store().lock().ok().is_some_and(|mut items| {
        match compare(items.definitions.get(&key), &fingerprints) {
            Witness::Canonical => true,
            Witness::Legacy => {
                items.definitions.insert(key, fingerprints.canonical);
                if let Err(error) = save_public_items(&items) {
                    tracing::warn!(%error, "public definition witness could not be upgraded");
                }
                true
            }
            Witness::Mismatch => false,
        }
    });
    if !verified {
        return;
    }
    let Some((kind, id)) = marketplace_runtime_identity(kind, runtime) else {
        return;
    };
    record_identity(kind, id, false);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn definition(args: &str) -> serde_json::Value {
        serde_json::from_str(&format!(
            r#"{{"id":"wf","nodes":[{{"id":"search","kind":{{"type":"tool","args":{args}}}}}]}}"#
        ))
        .expect("fixture definition parses")
    }

    #[test]
    fn a_reordered_rewrite_keeps_its_witness_and_a_real_change_does_not() {
        let original = definition_fingerprints(&definition(r#"{"query":"x","limit":5}"#)).unwrap();
        let rewritten = definition_fingerprints(&definition(r#"{"limit":5,"query":"x"}"#)).unwrap();
        let changed = definition_fingerprints(&definition(r#"{"query":"x","limit":6}"#)).unwrap();
        // The fixture really is reordered: the insertion-order bytes differ.
        assert_ne!(original.legacy, rewritten.legacy);
        assert_eq!(
            compare(Some(&original.canonical), &rewritten),
            Witness::Canonical
        );
        assert_eq!(
            compare(Some(&original.canonical), &changed),
            Witness::Mismatch
        );
        assert_eq!(compare(None, &original), Witness::Mismatch);
    }

    #[test]
    fn a_witness_saved_before_the_canonical_fingerprint_still_counts() {
        let original = definition(r#"{"query":"x","limit":5}"#);
        let fingerprints = definition_fingerprints(&original).unwrap();
        let saved = {
            use sha2::{Digest, Sha256};
            format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&original).unwrap())
            )
        };
        assert_ne!(saved, fingerprints.canonical);
        assert_eq!(compare(Some(&saved), &fingerprints), Witness::Legacy);
        let changed = definition_fingerprints(&definition(r#"{"query":"x","limit":6}"#)).unwrap();
        assert_eq!(compare(Some(&saved), &changed), Witness::Mismatch);
    }
}
