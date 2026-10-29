use super::*;

#[test]
fn validate_write_target_rejects_traversal() {
    assert!(validate_write_target("../escape").is_err());
    assert!(validate_write_target("/absolute").is_err());
    assert!(validate_write_target("a/b").is_err());
    assert!(validate_write_target("a\\b").is_err());
    assert!(validate_write_target("").is_err());
    assert!(validate_write_target("..").is_err());
}

#[test]
fn validate_write_target_accepts_valid_id() {
    let result = validate_write_target("com.example.my-agent");
    assert!(result.is_ok(), "valid id should be accepted: {result:?}");
    let path = result.unwrap();
    assert!(path.ends_with("com.example.my-agent"));
}

#[test]
fn parse_runnable_kind_round_trips() {
    use crate::runnable::RunnableKind;
    assert!(matches!(
        parse_runnable_kind("agent"),
        Ok(RunnableKind::Agent)
    ));
    assert!(matches!(
        parse_runnable_kind("workflow"),
        Ok(RunnableKind::Workflow)
    ));
    assert!(parse_runnable_kind("unknown").is_err());
}

#[test]
fn tools_are_listed_with_correct_server() {
    let ts = tools();
    assert_eq!(ts.len(), 6);
    for t in &ts {
        assert_eq!(t.server, SERVER_NAME);
        assert!(t.id.starts_with("ryu_self_build."));
    }
}

#[tokio::test]
async fn hot_reload_inserts_and_replaces() {
    let store = Arc::new(RwLock::new(vec![]));
    let m1 = PluginManifest {
        id: "com.test.app".into(),
        name: "Test".into(),
        version: "1.0.0".into(),
        runnables: vec![],
        permission_grants: vec![],
        companion: None,
        ..Default::default()
    };
    hot_reload_manifest(m1.clone(), Arc::clone(&store)).await;
    {
        let r = store.read().await;
        assert_eq!(r.len(), 1);
    }

    let m2 = PluginManifest {
        id: "com.test.app".into(),
        name: "Test v2".into(),
        version: "2.0.0".into(),
        runnables: vec![],
        permission_grants: vec![],
        companion: None,
        ..Default::default()
    };
    hot_reload_manifest(m2, Arc::clone(&store)).await;
    {
        let r = store.read().await;
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].version, "2.0.0");
    }
}
