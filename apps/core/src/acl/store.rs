//! Persistence for per-resource overwrites.
//!
//! [`super::ResourceAcl`] is a pure in-memory value; this is where one lives
//! between requests. Keyed by `(kind, id)` — `("workflow", "wf_123")` — because a
//! resource id is only unique within its kind, and a store that ignored kind
//! would let a workflow's grants leak onto a Space that happened to share an id.
//!
//! ## Why a single JSON file
//!
//! Overwrites are EXCEPTIONS, not the common case: the base role grant answers
//! almost every request, and a resource only appears here once someone has
//! deliberately carved out an exception on it. So the expected size is small
//! (tens to hundreds of entries), and the whole set is read on nearly every
//! permission check — which makes one cached file strictly better than a table
//! requiring a query per check. If that assumption ever breaks, the seam to
//! change is this module alone; nothing above it knows how the bytes are stored.
//!
//! The file is 0600 and cached in memory, invalidated on write, mirroring
//! `crate::pairing`'s paired-client store for the same reason: the read sits on
//! an authorization hot path and must not stat + parse per request.

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::{Overwrite, OverwriteTarget, ResourceAcl};

/// A resource's identity in the store. Ordered so the serialized map has a
/// stable key order and a diff of the file is readable.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct ResourceKey {
    pub kind: String,
    pub id: String,
}

impl ResourceKey {
    pub fn new(kind: impl Into<String>, id: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            id: id.into(),
        }
    }

    /// The flat string the JSON map is keyed by. `kind` is validated to exclude
    /// `:` on write, so this is unambiguous and round-trips.
    fn to_flat(&self) -> String {
        format!("{}:{}", self.kind, self.id)
    }

    fn from_flat(flat: &str) -> Option<Self> {
        let (kind, id) = flat.split_once(':')?;
        if kind.is_empty() || id.is_empty() {
            return None;
        }
        Some(Self::new(kind, id))
    }
}

/// The wire/disk shape of one overwrite. Deliberately its own type rather than
/// `#[derive(Serialize)]` on [`Overwrite`]: the resolver's types are free to
/// change shape, and the on-disk format is a compatibility surface that must not
/// move with them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredOverwrite {
    /// One of `org` | `team` | `role` | `member`.
    pub target_type: String,
    pub target_id: String,
    #[serde(default)]
    pub allow: Vec<String>,
    #[serde(default)]
    pub deny: Vec<String>,
}

impl StoredOverwrite {
    fn to_overwrite(&self) -> Option<Overwrite> {
        let target = match self.target_type.as_str() {
            "org" => OverwriteTarget::Org(self.target_id.clone()),
            "team" => OverwriteTarget::Team(self.target_id.clone()),
            "role" => OverwriteTarget::Role(self.target_id.clone()),
            "member" => OverwriteTarget::Member(self.target_id.clone()),
            // An unknown target type is DROPPED, not defaulted. Guessing would
            // apply a grant to the wrong tier, and the safe direction for an
            // unreadable rule is for it not to exist.
            _ => return None,
        };
        Some(Overwrite {
            target,
            allow: self.allow.iter().cloned().collect(),
            deny: self.deny.iter().cloned().collect(),
        })
    }

    pub fn from_overwrite(o: &Overwrite) -> Self {
        let (target_type, target_id) = match &o.target {
            OverwriteTarget::Org(id) => ("org", id),
            OverwriteTarget::Team(id) => ("team", id),
            OverwriteTarget::Role(id) => ("role", id),
            OverwriteTarget::Member(id) => ("member", id),
        };
        Self {
            target_type: target_type.to_owned(),
            target_id: target_id.clone(),
            allow: o.allow.iter().cloned().collect(),
            deny: o.deny.iter().cloned().collect(),
        }
    }
}

/// The whole persisted set, flat-keyed by `"kind:id"`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AclStore {
    #[serde(default)]
    pub resources: BTreeMap<String, Vec<StoredOverwrite>>,
}

pub fn store_path() -> std::path::PathBuf {
    crate::paths::state_path("resource-acl.json")
}

static CACHE: Mutex<Option<AclStore>> = Mutex::new(None);
/// Serializes read-modify-write mutations so two concurrent edits to different
/// resources cannot each save a snapshot that drops the other's change.
static MUTATION: Mutex<()> = Mutex::new(());

fn load_from_disk() -> AclStore {
    let Ok(bytes) = std::fs::read(store_path()) else {
        return AclStore::default();
    };
    // A corrupt file yields an EMPTY store, which denies every exception rather
    // than granting one. Losing a carve-out is recoverable; honouring half a
    // parsed rule is not.
    serde_json::from_slice(&bytes).unwrap_or_default()
}

fn cached() -> AclStore {
    let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    guard.get_or_insert_with(load_from_disk).clone()
}

fn with_cached<R>(read: impl FnOnce(&AclStore) -> R) -> R {
    let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let store = guard.get_or_insert_with(load_from_disk);
    read(store)
}

pub fn invalidate_cache() {
    let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    *guard = None;
}

fn save(store: &AclStore) -> std::io::Result<()> {
    let path = store_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_string_pretty(store)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

    // Atomic (temp + fsync + rename) and owner-only: a torn write would read
    // back as an empty store and silently drop every overwrite.
    crate::atomic_file::write_atomic(&path, body.as_bytes())?;
    invalidate_cache();
    Ok(())
}

/// The overwrites in force for one resource. Absent = no exceptions, which is the
/// overwhelmingly common case and resolves to the caller's base role grant.
pub fn acl_for(key: &ResourceKey) -> ResourceAcl {
    with_cached(|store| {
        let Some(rows) = store.resources.get(&key.to_flat()) else {
            return ResourceAcl::new();
        };
        ResourceAcl {
            overwrites: rows
                .iter()
                .filter_map(StoredOverwrite::to_overwrite)
                .collect(),
        }
    })
}

/// The raw stored rows for one resource, for the editing UI (which needs to show
/// what is persisted, including rows the resolver would drop).
pub fn stored_for(key: &ResourceKey) -> Vec<StoredOverwrite> {
    with_cached(|store| {
        store
            .resources
            .get(&key.to_flat())
            .cloned()
            .unwrap_or_default()
    })
}

/// Replace every overwrite on a resource. Passing an empty list REMOVES the
/// entry entirely rather than storing `[]`, so "no exceptions" has exactly one
/// representation on disk and the file does not accumulate empty rows.
pub fn set_overwrites(key: &ResourceKey, rows: Vec<StoredOverwrite>) -> std::io::Result<()> {
    if key.kind.contains(':') || key.kind.is_empty() || key.id.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "resource kind must be non-empty and contain no ':'; id must be non-empty",
        ));
    }
    let _mutation = MUTATION.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = cached();
    if rows.is_empty() {
        store.resources.remove(&key.to_flat());
    } else {
        store.resources.insert(key.to_flat(), rows);
    }
    save(&store)
}

/// Every resource that carries at least one overwrite, for an admin overview.
pub fn resources_with_overwrites() -> Vec<ResourceKey> {
    with_cached(|store| {
        store
            .resources
            .keys()
            .filter_map(|flat| ResourceKey::from_flat(flat))
            .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_keys_round_trip_and_keep_kind_separate() {
        let key = ResourceKey::new("workflow", "wf_123");
        assert_eq!(key.to_flat(), "workflow:wf_123");
        assert_eq!(ResourceKey::from_flat("workflow:wf_123"), Some(key));
        // An id containing a colon still round-trips: only the FIRST colon splits,
        // so a namespaced id is not silently truncated.
        assert_eq!(
            ResourceKey::from_flat("space:doc:abc"),
            Some(ResourceKey::new("space", "doc:abc"))
        );
        assert_eq!(ResourceKey::from_flat("nocolon"), None);
        assert_eq!(ResourceKey::from_flat(":empty"), None);
        assert_eq!(ResourceKey::from_flat("empty:"), None);
    }

    #[test]
    fn a_kind_containing_a_colon_is_rejected_on_write() {
        // Otherwise "a:b" + "c" and "a" + "b:c" would collide on one flat key,
        // silently merging two resources' grants.
        let err = set_overwrites(&ResourceKey::new("bad:kind", "x"), vec![]).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
        assert!(set_overwrites(&ResourceKey::new("", "x"), vec![]).is_err());
        assert!(set_overwrites(&ResourceKey::new("k", ""), vec![]).is_err());
    }

    #[test]
    fn every_target_type_round_trips() {
        for (ty, id) in [
            ("org", "o1"),
            ("team", "t1"),
            ("role", "admin"),
            ("member", "u1"),
        ] {
            let stored = StoredOverwrite {
                target_type: ty.to_owned(),
                target_id: id.to_owned(),
                allow: vec!["a".to_owned()],
                deny: vec!["d".to_owned()],
            };
            let back =
                StoredOverwrite::from_overwrite(&stored.to_overwrite().expect("known target type"));
            assert_eq!(back.target_type, ty);
            assert_eq!(back.target_id, id);
            assert_eq!(back.allow, vec!["a".to_owned()]);
            assert_eq!(back.deny, vec!["d".to_owned()]);
        }
    }

    #[test]
    fn an_unknown_target_type_is_dropped_not_defaulted() {
        // A rule we cannot read must not be applied to a guessed tier — that
        // would grant something nobody asked for.
        let stored = StoredOverwrite {
            target_type: "galaxy".to_owned(),
            target_id: "x".to_owned(),
            allow: vec!["space.read".to_owned()],
            deny: vec![],
        };
        assert!(stored.to_overwrite().is_none());
    }

    #[test]
    fn a_corrupt_store_denies_rather_than_grants() {
        // Mirrors `load_from_disk`'s `unwrap_or_default`: garbage yields an empty
        // store, so every carve-out disappears instead of half-parsing into an
        // unintended grant.
        let store: AclStore = serde_json::from_slice(b"{ not json").unwrap_or_default();
        assert!(store.resources.is_empty());
    }

    #[test]
    fn missing_resource_resolves_to_no_exceptions() {
        // The common path: almost no resource has overwrites, and one that does
        // not must fall through to the caller's base grant, not to a denial.
        let acl = acl_for(&ResourceKey::new(
            "workflow",
            "definitely-not-present-in-any-store",
        ));
        assert!(acl.overwrites.is_empty());
    }
}
