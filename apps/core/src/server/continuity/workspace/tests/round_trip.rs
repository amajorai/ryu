use super::super::blob_routes::{get_blob, read_staged_blob};
use super::super::export::{export_inner, inspect_inner};
use super::super::resume::{resume_inner, set_continued_inner};
use super::*;

/// The temp directory, canonical (so macOS's `/private/tmp` link is resolved)
/// but, through the same [`canonical`] the resume path uses, without the `\\?\`
/// verbatim prefix `canonicalize` adds on Windows. A thread folder is stored the
/// way the desktop's folder picker reports it; `set_run_metadata` collapses a
/// leading `\\` like any doubled separator, so a verbatim folder came back as
/// `\?\C:\…` and the thread had no folder to hand off.
fn canonical_base(temp: &tempfile::TempDir) -> PathBuf {
    canonical(temp.path()).unwrap()
}

/// A file the resumed worktree checked out, with line endings as committed.
/// The destination clone is Core's own and inherits the host's Git config, so a
/// host `core.autocrlf=true` (Git for Windows' system default) checks the `\n`
/// files out as `\r\n`; the handoff carried the right content either way.
fn checked_out(path: &FsPath) -> String {
    std::fs::read_to_string(path).unwrap().replace("\r\n", "\n")
}

/// A source repository with no network remote, one local commit, a tracked
/// change and an untracked file.
fn source_repo(base: &FsPath) -> PathBuf {
    let source = base.join("home/src/app");
    std::fs::create_dir_all(&source).unwrap();
    git(&source, &["init", "--quiet", "-b", "main"]);
    git(&source, &["config", "user.email", "test@ryu"]);
    git(&source, &["config", "user.name", "Test"]);
    git(&source, &["config", "commit.gpgsign", "false"]);
    std::fs::write(source.join("README.md"), "one\n").unwrap();
    git(&source, &["add", "."]);
    git(&source, &["commit", "--quiet", "-m", "init"]);
    std::fs::write(source.join("README.md"), "one\ntwo\n").unwrap();
    std::fs::write(source.join("notes.txt"), "carry me\n").unwrap();
    std::fs::write(source.join(".env"), "SECRET=1\n").unwrap();
    source
}

fn owned(user: &str) -> Tenancy {
    Tenancy::Owned {
        user_id: user.to_owned(),
        org_id: Some("org-1".to_owned()),
    }
}

fn member(user: &str) -> Option<VerifiedCaller> {
    Some(VerifiedCaller {
        user_id: user.to_owned(),
        email: None,
        email_verified: false,
        org_id: Some("org-1".to_owned()),
        role: crate::identity_verify::OrgRole::Member,
        teams: Vec::new(),
    })
}

async fn relay(
    source_roots: &Roots,
    destination_roots: &Roots,
    caller: &Option<VerifiedCaller>,
    manifest: &RnpWorkspaceManifestV0,
) {
    for blob in [
        manifest.commits.as_ref().map(|c| &c.blob),
        manifest.diff.as_ref().map(|d| &d.blob),
    ]
    .into_iter()
    .flatten()
    {
        let staged = staged_blob(source_roots, &caller_key(caller), &blob.sha256).expect("staged");
        assert!(staged_blob(source_roots, &caller_key(&member("mallory")), &blob.sha256).is_none());
        let on_disk = std::fs::read(&staged).unwrap();
        assert!(
            on_disk.starts_with(SEALED_BLOB_MAGIC),
            "staged in the clear"
        );
        let bytes = read_blob(&staged, &blob.sha256).unwrap();
        store_blob(destination_roots, &blob.sha256, &bytes).unwrap();
    }
}

#[tokio::test]
async fn handoff_round_trip_is_idempotent_and_stamps_the_destination() {
    crate::crypto_host::install();
    let temp = tempfile::tempdir().unwrap();
    let base = canonical_base(&temp);
    let source_state = crate::server::isolated_plugin_hook_test_state(&base.join("s"));
    let destination_state = crate::server::isolated_plugin_hook_test_state(&base.join("d"));
    let source_roots = roots(&base.join("source"));
    let destination_roots = roots(&base.join("destination"));
    std::fs::create_dir_all(&destination_roots.home).unwrap();
    let source = source_repo(&base);
    let id = "conversation-handoff-1";
    source_state
        .conversations
        .ensure_sync_conversation(id, None, Some("Thread"), 1, 2, Tenancy::Unattributed)
        .await
        .unwrap();
    source_state
        .conversations
        .set_run_metadata(id, Some(source.to_str().unwrap()), Some("main"), None)
        .await
        .unwrap();

    let inspection = inspect_inner(&source_state, &None, id).await.unwrap();
    assert_eq!(inspection.repo.remote_url, None);
    assert!(inspection
        .untracked_candidates
        .iter()
        .any(|candidate| candidate.path == ".env" && candidate.sensitive));

    let summary = source_state
        .conversations
        .get_summary(id)
        .await
        .unwrap()
        .unwrap();
    let manifest = export_inner(
        &source_state,
        &None,
        id,
        RnpWorkspaceExportRequestV0 {
            version: 0,
            if_updated_at: Some(summary.updated_at),
            if_head: inspection.repo.base_commit.clone(),
            include_untracked: vec!["notes.txt".to_owned()],
        },
        &source_roots,
    )
    .await
    .unwrap();
    assert!(manifest.commits.as_ref().unwrap().prerequisites.is_empty());
    assert!(manifest.omitted.iter().any(|o| o.path == ".env"));

    // The destination refuses a resume before the blobs arrive.
    destination_state
        .conversations
        .ensure_sync_conversation(id, None, Some("Thread"), 1, 2, Tenancy::Unattributed)
        .await
        .unwrap();
    let request = |manifest: &RnpWorkspaceManifestV0| RnpWorkspaceResumeRequestV0 {
        version: 0,
        manifest: manifest.clone(),
        destination: RnpWorkspaceDestinationV0::NewClone { folder_name: None },
    };
    let missing = resume_inner(
        &destination_state,
        &None,
        id,
        request(&manifest),
        &destination_roots,
    )
    .await
    .unwrap_err();
    assert_eq!(missing.status(), StatusCode::CONFLICT);

    // A node that only staged a blob for its own export (a hand-back of
    // the same unchanged work) must not report it as present, or the
    // relay would skip the upload and resume would fail with 409.
    for blob in [
        &manifest.commits.as_ref().unwrap().blob,
        &manifest.diff.as_ref().unwrap().blob,
    ] {
        assert!(staged_blob(&source_roots, &None, &blob.sha256).is_some());
        assert!(!received_blob_present(&source_roots, &blob.sha256));
        assert!(received_blob(&source_roots, blob).is_err());
    }

    // v1 resumes into a new clone only; an existing checkout would let the
    // worktree inherit that checkout's workspace trust.
    let existing = resume_inner(
        &destination_state,
        &None,
        id,
        RnpWorkspaceResumeRequestV0 {
            version: 0,
            manifest: manifest.clone(),
            destination: RnpWorkspaceDestinationV0::ExistingCheckout {
                checkout_path: source.to_string_lossy().into_owned(),
            },
        },
        &destination_roots,
    )
    .await
    .unwrap_err();
    assert_eq!(existing.status(), StatusCode::UNPROCESSABLE_ENTITY);

    relay(&source_roots, &destination_roots, &None, &manifest).await;
    for blob in [
        &manifest.commits.as_ref().unwrap().blob,
        &manifest.diff.as_ref().unwrap().blob,
    ] {
        assert!(received_blob_present(&destination_roots, &blob.sha256));
    }
    let first = resume_inner(
        &destination_state,
        &None,
        id,
        request(&manifest),
        &destination_roots,
    )
    .await
    .unwrap();
    assert_eq!(first.status, "created");
    assert_eq!(first.warnings, vec!["workspace-untrusted".to_owned()]);
    assert!(first.branch.starts_with("handoff/"));
    let worktree = PathBuf::from(&first.worktree_path);
    assert_eq!(checked_out(&worktree.join("README.md")), "one\ntwo\n");
    assert_eq!(checked_out(&worktree.join("notes.txt")), "carry me\n");
    assert!(!worktree.join(".env").exists());
    assert!(handoff::is_handoff_worktree(&worktree));

    let stamped = destination_state
        .conversations
        .get_summary(id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        stamped.folder_path.as_deref(),
        Some(first.worktree_path.as_str())
    );
    assert_eq!(
        stamped.worktree_path.as_deref(),
        Some(first.worktree_path.as_str())
    );
    assert_eq!(stamped.branch.as_deref(), Some(first.branch.as_str()));

    let replay = resume_inner(
        &destination_state,
        &None,
        id,
        request(&manifest),
        &destination_roots,
    )
    .await
    .unwrap();
    assert_eq!(replay.status, "unchanged");
    assert_eq!(replay.worktree_path, first.worktree_path);
    assert_eq!(replay.folder_path, first.folder_path);

    // The source is untouched.
    assert_eq!(
        std::fs::read_to_string(source.join(".env")).unwrap(),
        "SECRET=1\n"
    );
    assert_eq!(
        git(&source, &["status", "--porcelain=v1"]).lines().count(),
        3
    );
}

#[tokio::test]
async fn access_is_enforced_and_running_turns_are_refused() {
    crate::crypto_host::install();
    let temp = tempfile::tempdir().unwrap();
    let base = canonical_base(&temp);
    let state = crate::server::isolated_plugin_hook_test_state(&base.join("s"));
    let roots = roots(&base);
    let source = source_repo(&base);
    let id = "conversation-private";
    state
        .conversations
        .ensure_sync_conversation(id, None, Some("Private"), 1, 2, owned("alice"))
        .await
        .unwrap();
    state
        .conversations
        .set_run_metadata(id, Some(source.to_str().unwrap()), None, None)
        .await
        .unwrap();
    let bob = member("bob");
    let alice = member("alice");

    assert_eq!(
        inspect_inner(&state, &bob, id).await.unwrap_err().status(),
        StatusCode::FORBIDDEN
    );
    let head = inspect_inner(&state, &alice, id)
        .await
        .unwrap()
        .repo
        .base_commit;
    let export = |caller: Option<VerifiedCaller>| {
        let state = state.clone();
        let roots = roots.clone();
        let head = head.clone();
        async move {
            export_inner(
                &state,
                &caller,
                id,
                RnpWorkspaceExportRequestV0 {
                    version: 0,
                    if_updated_at: None,
                    if_head: head,
                    include_untracked: Vec::new(),
                },
                &roots,
            )
            .await
        }
    };
    assert_eq!(
        export(bob.clone()).await.unwrap_err().status(),
        StatusCode::FORBIDDEN
    );
    let manifest = export(alice.clone()).await.unwrap();
    let resume = resume_inner(
        &state,
        &bob,
        id,
        RnpWorkspaceResumeRequestV0 {
            version: 0,
            manifest,
            destination: RnpWorkspaceDestinationV0::NewClone { folder_name: None },
        },
        &roots,
    )
    .await
    .unwrap_err();
    assert_eq!(resume.status(), StatusCode::FORBIDDEN);

    let record = RnpContinuedOnV0 {
        node_label: "Mac".to_owned(),
        bundle_id: Some("bundle-1".to_owned()),
        workspace_id: None,
        at: 5,
    };
    assert_eq!(
        set_continued_inner(&state, &bob, id, Some(record.clone()))
            .await
            .unwrap_err()
            .status(),
        StatusCode::FORBIDDEN
    );
    set_continued_inner(&state, &alice, id, Some(record))
        .await
        .unwrap();
    let marked = state.conversations.get_summary(id).await.unwrap().unwrap();
    assert_eq!(marked.continued_on.unwrap()["nodeLabel"], "Mac");
    set_continued_inner(&state, &alice, id, None).await.unwrap();
    assert!(state
        .conversations
        .get_summary(id)
        .await
        .unwrap()
        .unwrap()
        .continued_on
        .is_none());

    state
        .conversations
        .set_run_status(id, "running")
        .await
        .unwrap();
    let running = inspect_inner(&state, &alice, id).await.unwrap_err();
    assert_eq!(running.status(), StatusCode::CONFLICT);
    assert_eq!(
        export(alice).await.unwrap_err().status(),
        StatusCode::CONFLICT
    );
}

async fn body_bytes(response: Response) -> Vec<u8> {
    axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap()
        .to_vec()
}

#[tokio::test]
async fn staged_blobs_are_served_by_digest_only_to_their_exporter() {
    crate::crypto_host::install();
    let temp = tempfile::tempdir().unwrap();
    let base = canonical_base(&temp);
    let state = crate::server::isolated_plugin_hook_test_state(&base.join("s"));
    let roots = roots(&base);
    let source = source_repo(&base);
    let id = "conversation-blobs";
    state
        .conversations
        .ensure_sync_conversation(id, None, Some("Blobs"), 1, 2, owned("alice"))
        .await
        .unwrap();
    state
        .conversations
        .set_run_metadata(id, Some(source.to_str().unwrap()), None, None)
        .await
        .unwrap();
    let alice = member("alice");
    let head = inspect_inner(&state, &alice, id)
        .await
        .unwrap()
        .repo
        .base_commit;
    let manifest = export_inner(
        &state,
        &alice,
        id,
        RnpWorkspaceExportRequestV0 {
            version: 0,
            if_updated_at: None,
            if_head: head,
            include_untracked: vec!["notes.txt".to_owned()],
        },
        &roots,
    )
    .await
    .unwrap();
    let diff = manifest.diff.as_ref().expect("the export stages a diff");

    // The exporter downloads the plaintext blob, which hashes to its digest.
    let served = read_staged_blob(&roots, &alice, diff.blob.sha256.clone()).await;
    assert_eq!(served.status(), StatusCode::OK);
    assert_eq!(
        served.headers()[header::CONTENT_TYPE],
        "application/octet-stream"
    );
    let bytes = body_bytes(served).await;
    assert_eq!(sha256_hex(&bytes), diff.blob.sha256);
    assert!(String::from_utf8_lossy(&bytes).contains("README.md"));

    // Another caller, and an unknown digest, get a 404 and no bytes.
    let other = read_staged_blob(&roots, &member("bob"), diff.blob.sha256.clone()).await;
    assert_eq!(other.status(), StatusCode::NOT_FOUND);
    let other: serde_json::Value = serde_json::from_slice(&body_bytes(other).await).unwrap();
    assert_eq!(other["code"], "blob-missing");
    let unknown = read_staged_blob(&roots, &alice, sha256_hex(b"never staged")).await;
    assert_eq!(unknown.status(), StatusCode::NOT_FOUND);

    // A malformed digest is a 400, before any lookup.
    for bad in [
        "not-a-digest",
        &diff.blob.sha256[..40],
        &diff.blob.sha256.to_uppercase(),
    ] {
        let response = read_staged_blob(&roots, &alice, bad.to_owned()).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{bad}");
    }
    let response = get_blob(Extension(alice.clone()), Path("../../etc".to_owned())).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}
