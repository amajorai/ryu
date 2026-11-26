use super::*;

#[test]
fn safe_segment_accepts_valid_identifiers() {
    assert!(safe_segment("abc123").is_ok());
    assert!(safe_segment("run-id_01").is_ok());
    assert!(safe_segment("A-Z_0-9").is_ok());
    assert!(safe_segment(&"x".repeat(128)).is_ok());
}

#[test]
fn safe_segment_rejects_path_traversal() {
    assert!(safe_segment("../etc/passwd").is_err());
    assert!(safe_segment("../../secret").is_err());
    assert!(safe_segment("foo/bar").is_err());
    assert!(safe_segment("foo\\bar").is_err());
    assert!(safe_segment("foo\0bar").is_err());
    assert!(safe_segment(".hidden").is_err());
    assert!(safe_segment("").is_err());
    assert!(safe_segment(&"x".repeat(129)).is_err());
}

#[test]
fn checkpoint_dir_rejects_traversal_in_run_id() {
    let key = FanoutCheckpointKey {
        run_id: "../evil".to_string(),
        node_id: "node-1".to_string(),
    };
    assert!(
        checkpoint_dir(&key).is_err(),
        "traversal in run_id must be rejected"
    );
}

#[test]
fn checkpoint_dir_rejects_traversal_in_node_id() {
    let key = FanoutCheckpointKey {
        run_id: "run-1".to_string(),
        node_id: "../../etc".to_string(),
    };
    assert!(
        checkpoint_dir(&key).is_err(),
        "traversal in node_id must be rejected"
    );
}

#[test]
fn fanout_checkpoints_are_sealed_and_bound_to_their_place() {
    let run_id = format!("run{}", uuid::Uuid::new_v4().simple());
    let key = FanoutCheckpointKey {
        run_id: run_id.clone(),
        node_id: "node-1".to_string(),
    };
    let marker = format!("delegatemarker{}", uuid::Uuid::new_v4().simple());
    let result = DelegateResult::ok("d0".into(), PermissionPreset::default(), marker.clone());
    save_delegate_checkpoint(&key, &result);
    let dir = checkpoint_dir(&key).unwrap();
    let raw = std::fs::read_to_string(dir.join("d0.json")).unwrap();
    assert!(raw.starts_with("encb:v1:"));
    assert!(!raw.contains(&marker));
    assert_eq!(
        load_delegate_checkpoint(&key, "d0").and_then(|r| r.output),
        Some(marker.clone())
    );
    // Copied to another delegate: does not open, so that delegate reruns.
    std::fs::copy(dir.join("d0.json"), dir.join("d1.json")).unwrap();
    assert!(load_delegate_checkpoint(&key, "d1").is_none());
    // A legacy plaintext checkpoint still reads.
    std::fs::write(
        dir.join("d2.json"),
        serde_json::to_vec(&DelegateResult::ok(
            "d2".into(),
            PermissionPreset::default(),
            "legacy".into(),
        ))
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        load_delegate_checkpoint(&key, "d2").and_then(|r| r.output),
        Some("legacy".to_owned())
    );
    let _ = std::fs::remove_dir_all(checkpoint_root().join(run_id));
}

#[test]
fn boot_pass_seals_legacy_checkpoints_and_drops_finished_runs() {
    use super::super::super::store::RunStatus;
    let root = tempfile::tempdir().unwrap();
    let marker = format!("legacyoutput{}", uuid::Uuid::new_v4().simple());
    let legacy = |run: &str, delegate: &str| {
        let dir = root.path().join(run).join("node-1");
        std::fs::create_dir_all(&dir).unwrap();
        let body = serde_json::to_vec(&DelegateResult::ok(
            delegate.into(),
            PermissionPreset::default(),
            marker.clone(),
        ))
        .unwrap();
        std::fs::write(dir.join(format!("{delegate}.json")), &body).unwrap();
        // A crashed write's leftover copy.
        std::fs::write(dir.join(format!("{delegate}.json.tmp")), &body).unwrap();
        dir
    };
    let live = legacy("runlive", "d0");
    let finished = legacy("rundone", "d0");
    let status = |run: &str| match run {
        "rundone" => Some(RunStatus::Completed),
        _ => Some(RunStatus::AwaitingInput),
    };
    // Fresh temps may belong to a write in flight: age them past the gate.
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(600);
    std::fs::File::options()
        .write(true)
        .open(live.join("d0.json.tmp"))
        .unwrap()
        .set_modified(old)
        .unwrap();

    // Sealed d0, removed temp, removed finished run.
    assert_eq!(reseal_fanout_checkpoints_in(root.path(), status), 3);
    assert!(
        !finished.exists(),
        "a completed run's checkpoints are dead state"
    );
    assert!(!live.join("d0.json.tmp").exists());
    let raw = std::fs::read_to_string(live.join("d0.json")).unwrap();
    assert!(raw.starts_with("encb:v1:"));
    assert!(!raw.contains(&marker));
    let key = FanoutCheckpointKey {
        run_id: "runlive".into(),
        node_id: "node-1".into(),
    };
    let stored = std::fs::read(live.join("d0.json")).unwrap();
    let opened: DelegateResult =
        serde_json::from_slice(&decode_checkpoint(&key, "d0", &stored).unwrap()).unwrap();
    assert_eq!(opened.output, Some(marker.clone()));
    // Run twice: nothing left to do.
    assert_eq!(reseal_fanout_checkpoints_in(root.path(), status), 0);
    assert_eq!(std::fs::read(live.join("d0.json")).unwrap(), stored);
}
