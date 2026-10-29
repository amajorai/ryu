//! Local witnesses for per-listing statistics. Discovery is never publication.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Deserialize, Serialize)]
struct PublicSkillInstall {
    listing_id: String,
    source_path: PathBuf,
    fingerprint: String,
}

#[derive(Deserialize, Serialize)]
struct WitnessStore {
    version: u32,
    installs: BTreeMap<String, PublicSkillInstall>,
}

fn store_path() -> PathBuf {
    crate::paths::state_path("skills-public-statistics.json")
}

fn read_store() -> BTreeMap<String, PublicSkillInstall> {
    std::fs::read(store_path())
        .ok()
        .and_then(|bytes| serde_json::from_slice::<WitnessStore>(&bytes).ok())
        .filter(|store| store.version == 1)
        .map(|store| store.installs)
        .unwrap_or_default()
}

pub(crate) fn fingerprint(record: &ryu_skills::SkillRecord) -> Option<String> {
    // Activation is local presentation state, not part of the installed artifact.
    let bytes = serde_json::to_vec(&(
        &record.id,
        &record.name,
        &record.description,
        &record.instructions,
        &record.allowed_tools,
        record.always_on,
    ))
    .ok()?;
    Some(format!("{:x}", Sha256::digest(bytes)))
}

pub(crate) fn artifact_fingerprint(slug: &str, content: &str) -> Option<String> {
    fingerprint(&ryu_skills::parse_skill_md(slug, content).ok()?)
}

/// Called only after the installing catalog independently proves a public listing.
/// The fingerprint was captured from its artifact before installation, not from
/// a later local file that another writer may have replaced.
pub(crate) fn record_public_install(listing_id: &str, result: &super::InstallResult) {
    let Some(fingerprint) = result.artifact_fingerprint.as_ref() else {
        return;
    };
    let Ok(source_path) = std::fs::canonicalize(&result.path) else {
        return;
    };
    static WRITER: OnceLock<Mutex<()>> = OnceLock::new();
    let Ok(_writer) = WRITER.get_or_init(|| Mutex::new(())).lock() else {
        return;
    };
    let path = store_path();
    let Some(parent) = path.parent() else {
        return;
    };
    let saved = (|| -> anyhow::Result<()> {
        std::fs::create_dir_all(parent)?;
        let mut store = read_store();
        store.insert(
            result.slug.clone(),
            PublicSkillInstall {
                listing_id: listing_id.to_owned(),
                source_path,
                fingerprint: fingerprint.clone(),
            },
        );
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        temporary.write_all(&serde_json::to_vec(&WitnessStore {
            version: 1,
            installs: store,
        })?)?;
        temporary.as_file().sync_all()?;
        temporary.persist(&path)?;
        Ok(())
    })();
    if let Err(error) = saved {
        tracing::warn!(%error, "public skill statistics witness could not be saved");
    }
}

fn matches_loaded(
    witness: &PublicSkillInstall,
    record: &ryu_skills::SkillRecord,
    resolved: &Path,
) -> bool {
    std::fs::canonicalize(resolved).ok().as_ref() == Some(&witness.source_path)
        && fingerprint(record).as_deref() == Some(witness.fingerprint.as_str())
}

pub(crate) fn loaded_identity(record: &ryu_skills::SkillRecord) -> Option<String> {
    let store = read_store();
    let witness = store.get(&record.id)?;
    let resolved = ryu_skills::resolve_skill_md(&record.id)?;
    matches_loaded(witness, record, &resolved).then(|| witness.listing_id.clone())
}

pub(crate) fn download_identity(listing_id: &str) -> Option<String> {
    let store = read_store();
    let (slug, witness) = store
        .iter()
        .find(|(_, witness)| witness.listing_id == listing_id)?;
    let resolved = ryu_skills::resolve_skill_md(slug)?;
    let content = std::fs::read_to_string(&resolved).ok()?;
    let record = ryu_skills::parse_skill_md(slug, &content).ok()?;
    matches_loaded(witness, &record, &resolved).then(|| witness.listing_id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_replacements_and_colliding_paths_do_not_match_a_public_install() {
        let dir = tempfile::tempdir().expect("temporary directory");
        let public = dir.path().join("public.md");
        let private = dir.path().join("private.md");
        let content = "---\nname: Public skill\n---\nPublic instructions";
        std::fs::write(&public, content).expect("public artifact");
        std::fs::write(&private, content).expect("same content at another origin");
        let mut record = ryu_skills::parse_skill_md("shared-slug", content).expect("record");
        let witness = PublicSkillInstall {
            listing_id: "publisher/repo/shared-slug".into(),
            source_path: std::fs::canonicalize(&public).expect("canonical public path"),
            fingerprint: fingerprint(&record).expect("fingerprint"),
        };
        assert!(matches_loaded(&witness, &record, &public));
        record.enabled = false;
        assert!(matches_loaded(&witness, &record, &public));
        assert!(!matches_loaded(&witness, &record, &private));
        record.instructions = "Private merger review".into();
        assert!(!matches_loaded(&witness, &record, &public));
    }
}
