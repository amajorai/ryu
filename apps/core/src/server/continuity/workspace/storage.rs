//! On-disk handoff state: roots, resume records, and the sealed staging and
//! received blob stores.

use super::*;

/// Where handoff state and new clones live. Handlers use [`Roots::resolve`];
/// tests pass temporary folders.
#[derive(Debug, Clone)]
pub(crate) struct Roots {
    /// `rnp/` state: `staging/`, `blobs/`, `resumed/`.
    pub rnp: PathBuf,
    /// Parent of new clones (`~/Documents/Ryu/handoffs`).
    pub handoffs: PathBuf,
    /// The node's home folder; clones and existing checkouts must be inside it.
    pub home: PathBuf,
}

impl Roots {
    pub(super) fn resolve() -> Result<Self, Response> {
        let unavailable = |what: &str| {
            coded_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                format!("could not resolve the {what} directory"),
            )
        };
        let documents = dirs::document_dir().ok_or_else(|| unavailable("Documents"))?;
        let home = dirs::home_dir().ok_or_else(|| unavailable("home"))?;
        Ok(Self {
            rnp: rnp_dir(),
            handoffs: documents.join("Ryu").join("handoffs"),
            home,
        })
    }

    pub(super) fn staging(&self) -> PathBuf {
        self.rnp.join("staging")
    }

    pub(super) fn blobs(&self) -> PathBuf {
        self.rnp.join("blobs")
    }

    pub(super) fn resumed(&self) -> PathBuf {
        self.rnp.join("resumed")
    }

    /// Private scratch for the few seconds a resume needs a received blob as a
    /// plaintext file (git reads bundles and patches by path).
    pub(super) fn scratch(&self) -> PathBuf {
        self.rnp.join("opened")
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StagingOwner {
    pub(super) owner: Option<String>,
    pub(super) created_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ResumeRecord {
    pub(super) conversation_id: String,
    pub(super) folder_path: String,
    pub(super) worktree_path: String,
    pub(super) branch: String,
}

pub(super) fn caller_key(caller: &Option<VerifiedCaller>) -> Option<String> {
    caller.as_ref().map(|caller| caller.user_id.clone())
}

pub(super) fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Write `bytes` beside `target` and rename it into place, so a reader never
/// sees a partial file.
pub(super) fn write_atomically(target: &FsPath, bytes: &[u8]) -> std::io::Result<()> {
    let parent = target
        .parent()
        .ok_or_else(|| std::io::Error::other("target has no parent"))?;
    std::fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".{}.partial", uuid::Uuid::new_v4()));
    let result =
        std::fs::write(&temporary, bytes).and_then(|()| std::fs::rename(&temporary, target));
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

/// Magic for a handoff blob sealed at rest: `RYU-HB01 | nonce(12) | ciphertext`,
/// ChaCha20-Poly1305 under the node's master key. Staged and received patches
/// and bundles carry working-tree content (possibly credentials the reviewer
/// chose to include), so neither queue keeps them in the clear. The plaintext
/// digest names the file and is re-checked on every open.
pub(super) const SEALED_BLOB_MAGIC: &[u8; 8] = b"RYU-HB01";

pub(super) fn seal_blob(bytes: &[u8]) -> anyhow::Result<Vec<u8>> {
    let (nonce, ciphertext) = ryu_crypto::global_cipher()?.encrypt(bytes)?;
    let mut sealed = Vec::with_capacity(SEALED_BLOB_MAGIC.len() + nonce.len() + ciphertext.len());
    sealed.extend_from_slice(SEALED_BLOB_MAGIC);
    sealed.extend_from_slice(&nonce);
    sealed.extend_from_slice(&ciphertext);
    Ok(sealed)
}

/// Read a staged or received blob and return its plaintext, verifying it still
/// hashes to `sha`. Blobs written by older builds (plaintext, at most a day old
/// given the TTLs) are accepted; a sealed blob that cannot be opened is an error.
pub(super) fn read_blob(path: &FsPath, sha: &str) -> anyhow::Result<Vec<u8>> {
    let stored = std::fs::read(path)?;
    let plain = match stored.strip_prefix(SEALED_BLOB_MAGIC.as_slice()) {
        Some(body) => {
            anyhow::ensure!(body.len() >= 12, "sealed handoff blob is truncated");
            let (nonce, ciphertext) = body.split_at(12);
            ryu_crypto::global_cipher()?.decrypt(nonce, ciphertext)?
        }
        None => stored,
    };
    anyhow::ensure!(
        sha256_hex(&plain) == sha,
        "handoff blob does not match its digest"
    );
    Ok(plain)
}

/// Seal `bytes` and write them atomically to `target`. Fails closed when the
/// master key is unavailable.
pub(super) fn write_sealed_blob(target: &FsPath, bytes: &[u8]) -> std::io::Result<()> {
    let sealed = seal_blob(bytes).map_err(|error| std::io::Error::other(error.to_string()))?;
    write_atomically(target, &sealed)
}

pub(super) fn older_than(path: &FsPath, ttl: Duration) -> bool {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age > ttl)
}

/// Drop expired staging folders and received blobs. Runs on each export and
/// resume instead of from a startup hook.
pub(super) fn sweep(roots: &Roots) {
    if let Ok(entries) = std::fs::read_dir(roots.staging()) {
        for entry in entries.flatten() {
            if older_than(&entry.path(), STAGING_TTL) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(roots.blobs()) {
        for entry in entries.flatten() {
            if older_than(&entry.path(), RECEIVED_TTL) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    // Plaintext opened for a resume lives only for that request.
    if let Ok(entries) = std::fs::read_dir(roots.scratch()) {
        for entry in entries.flatten() {
            if older_than(&entry.path(), Duration::from_secs(10 * 60)) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// The staged blob `sha` exported by `owner`, if any.
pub(super) fn staged_blob(roots: &Roots, owner: &Option<String>, sha: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(roots.staging()).ok()?;
    entries.flatten().find_map(|entry| {
        let record: StagingOwner =
            serde_json::from_slice(&std::fs::read(entry.path().join("owner.json")).ok()?).ok()?;
        let blob = entry.path().join(sha);
        (record.owner == *owner && blob.is_file() && !older_than(&entry.path(), STAGING_TTL))
            .then_some(blob)
    })
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum StoredBlob {
    Created,
    Unchanged,
}

/// Store a received blob under its digest. Re-uploading the same bytes is a
/// no-op; a digest mismatch leaves nothing behind.
pub(crate) fn store_blob(roots: &Roots, sha: &str, bytes: &[u8]) -> Result<StoredBlob, Response> {
    if !is_sha256(sha) {
        return Err(coded_error(
            StatusCode::BAD_REQUEST,
            "invalid-digest",
            "blob digest is invalid",
        ));
    }
    if bytes.len() as u64 > handoff::MAX_BUNDLE_BYTES {
        return Err(coded_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "too-large",
            "workspace blob is too large",
        ));
    }
    if sha256_hex(bytes) != sha {
        return Err(coded_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "digest-mismatch",
            "blob content does not match its digest",
        ));
    }
    let target = roots.blobs().join(sha);
    if target.is_file() {
        return Ok(StoredBlob::Unchanged);
    }
    write_sealed_blob(&target, bytes).map_err(|error| {
        coded_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            format!("could not store the blob: {error}"),
        )
    })?;
    Ok(StoredBlob::Created)
}

/// Whether `sha` is in the received store that resume reads from.
pub(super) fn received_blob_present(roots: &Roots, sha: &str) -> bool {
    roots.blobs().join(sha).is_file()
}

/// Open a received blob for `materialize_handoff`, which reads files by path.
/// The plaintext goes to an owner-only temporary file in the private
/// `rnp/opened` scratch dir that is deleted when the returned handle drops
/// (right after the resume); `sweep` clears anything a crash left there.
pub(super) fn received_blob(
    roots: &Roots,
    blob: &RnpBlobRefV0,
) -> Result<tempfile::TempPath, Response> {
    let missing = || {
        coded_error(
            StatusCode::CONFLICT,
            "blob-missing",
            format!("blob {} has not been uploaded", blob.sha256),
        )
    };
    let path = roots.blobs().join(&blob.sha256);
    if !path.is_file() {
        return Err(missing());
    }
    let plain = read_blob(&path, &blob.sha256).map_err(|_| missing())?;
    if plain.len() as u64 != blob.bytes {
        return Err(missing());
    }
    let scratch = roots.scratch();
    let written = ryu_backup::archive::private_directory(&scratch)
        .map_err(std::io::Error::other)
        .and_then(|()| {
            let mut file = tempfile::Builder::new()
                .prefix(".handoff-")
                .tempfile_in(&scratch)?;
            std::io::Write::write_all(file.as_file_mut(), &plain)?;
            file.as_file().sync_all()?;
            Ok(file.into_temp_path())
        });
    written.map_err(|error| {
        coded_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            format!("could not open the blob: {error}"),
        )
    })
}
