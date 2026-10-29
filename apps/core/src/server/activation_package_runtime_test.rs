//! Executes the production activation driver with real local stores/handlers.
use super::*;

const TEST: &str = "server::activation_package_runtime::shipped_activation_matching_registration_and_failure_recovery";

fn package_body(root: &std::path::Path, relative: &str) -> Result<String, String> {
    let path = std::path::Path::new(relative);
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err(format!("invalid package body path: {relative}"));
    }
    let resolved = root
        .join(path)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !resolved.starts_with(root) {
        return Err(format!("package body escapes its package root: {relative}"));
    }
    std::fs::read_to_string(resolved).map_err(|error| error.to_string())
}

async fn app_ids(mcp: &McpRegistry) -> std::collections::BTreeSet<String> {
    mcp.list_all_tools()
        .await
        .into_iter()
        .filter(|tool| tool.server == "app")
        .map(|tool| tool.id)
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shipped_activation_matching_registration_and_failure_recovery() {
    if std::env::var_os("RYU_ACTIVATION_PACKAGE_CHILD").is_none() {
        let dir = tempfile::tempdir().unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST, "--nocapture"])
            .env("RYU_ACTIVATION_PACKAGE_CHILD", "1")
            .env("RYU_PROFILE", "dev")
            .env("RYU_KEYCHAIN", "off")
            .env("RYU_DIR", dir.path())
            .env(
                ryu_output_styles::ENV_OUTPUT_STYLES_DIR,
                dir.path().join("profiles"),
            )
            .env(
                ryu_output_styles::ENV_SELECTION_FILE,
                dir.path().join("selection.json"),
            )
            .status()
            .unwrap();
        assert!(status.success());
        return;
    }
    crate::runnable::reset_activation_events_for_test();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../generated/ryu-runtime/plugins-store");
    let mut wildcard_count = 0;
    let mut all_shipped = Vec::new();
    for cluster in ["plugins", "lsp", "external_plugins"] {
        for item in std::fs::read_dir(root.join(cluster)).unwrap() {
            let path = item.unwrap().path().join("manifest.json");
            if !path.is_file() {
                continue;
            }
            let package_root = path.parent().unwrap().canonicalize().unwrap();
            assert!(package_body(&package_root, "../manifest.json").is_err());
            assert!(package_body(&package_root, "/manifest.json").is_err());
            let manifest = crate::plugin_manifest::PluginManifest::parse_and_validate_with_code(
                &std::fs::read_to_string(&path).unwrap(),
                |relative| package_body(&package_root, relative),
            )
            .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
            assert!(manifest.activation_events.is_empty() || manifest.activation_events == ["*"]);
            if !manifest.activation_events.is_empty() {
                wildcard_count += 1;
            }
            all_shipped.push(manifest.clone());
            for events in [
                vec![],
                vec!["onStartup"],
                vec!["onChat"],
                vec!["onCommand:fixture"],
                vec!["onTool:fixture"],
            ] {
                let fired = events.into_iter().map(str::to_owned).collect();
                assert!(
                    crate::runnable::manifest_should_activate(&manifest, &fired),
                    "{}",
                    manifest.id
                );
            }
        }
    }
    assert!(wildcard_count >= 40);
    let agent_comms_root = root.join("plugins/agent-comms").canonicalize().unwrap();
    let authored = include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/agent-comms/manifest.json");
    assert_eq!(
        std::fs::read_to_string(agent_comms_root.join("manifest.json")).unwrap(),
        authored
    );
    let mut shipped = crate::plugin_manifest::PluginManifest::parse_and_validate_with_code(
        authored,
        |relative| package_body(&agent_comms_root, relative),
    )
    .unwrap();
    let store = PluginStore::open_in_memory().unwrap();
    let runtime = crate::plugins::runtime::PluginRuntime::new();
    let mcp = Arc::new(McpRegistry::empty());
    let agents = AgentStore::open_in_memory(&AcpAgentRegistry::new()).unwrap();
    let skills = SkillRegistry::empty();
    let contributions = crate::plugins::app_contrib::AppContribRegistry::default();
    let registry = build_runnable_registry_from_parts(&agents, &mcp, &skills, &contributions);
    let manifests = tokio::sync::RwLock::new(vec![shipped.clone()]);
    store.insert(&shipped.id, &shipped.version).await.unwrap();
    fire_activation_event_from_parts(&store, &runtime, &manifests, &registry, &mcp, "onChat").await;
    assert!(
        !runtime.is_active(&shipped.id).await,
        "installed but disabled must stay inactive"
    );
    assert!(app_ids(&mcp).await.is_empty());
    store
        .set_enabled(&shipped.id, &shipped.permission_grants)
        .await
        .unwrap()
        .unwrap();
    fire_activation_event_from_parts(&store, &runtime, &manifests, &registry, &mcp, "onChat").await;
    let expected: std::collections::BTreeSet<_> = shipped
        .runnables
        .iter()
        .map(|entry| {
            let config: crate::plugin_manifest::schema::ToolConfig =
                serde_json::from_value(entry.config.clone().unwrap()).unwrap();
            crate::sidecar::mcp::app_tool_registered_id(&config)
        })
        .collect();
    let actual: std::collections::BTreeSet<_> = app_ids(&mcp).await;
    assert_eq!(actual, expected);
    let generation = runtime
        .acquire(&shipped.id)
        .await
        .unwrap()
        .generation()
        .clone();
    fire_activation_event_from_parts(&store, &runtime, &manifests, &registry, &mcp, "onStartup")
        .await;
    assert!(
        runtime.is_current(&generation).await,
        "already active registration stays idempotent"
    );

    let styles_root = root.join("plugins/output-styles").canonicalize().unwrap();
    let authored = include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/output-styles/manifest.json");
    assert_eq!(
        std::fs::read_to_string(styles_root.join("manifest.json")).unwrap(),
        authored
    );
    let styles = crate::plugin_manifest::PluginManifest::parse_and_validate_with_code(
        authored,
        |relative| package_body(&styles_root, relative),
    )
    .unwrap();
    store.insert(&styles.id, &styles.version).await.unwrap();
    store
        .set_enabled(&styles.id, &styles.permission_grants)
        .await
        .unwrap();
    *manifests.write().await = vec![styles.clone()];
    fire_activation_event_from_parts(&store, &runtime, &manifests, &registry, &mcp, "onStartup")
        .await;
    assert!(runtime.is_active(&styles.id).await);
    for style in &styles.contributes.as_ref().unwrap().output_styles {
        assert_eq!(
            output_style_registry().source_of(&style.id).as_deref(),
            style.source.as_deref()
        );
    }
    sync_plugin_output_styles(&styles, false);

    // Mutated declaration tests gated driver semantics; shipped declarations above remain unchanged.
    drop(runtime.begin_deactivation(&shipped.id).await);
    for id in &expected {
        mcp.unregister_app_tool(id);
    }
    shipped.activation_events = vec!["onCommand:activation-fixture".to_owned()];
    *manifests.write().await = vec![shipped.clone()];
    fire_activation_event_from_parts(
        &store,
        &runtime,
        &manifests,
        &registry,
        &mcp,
        "onTool:activation-fixture",
    )
    .await;
    assert!(!runtime.is_active(&shipped.id).await);
    assert!(app_ids(&mcp).await.is_empty());
    let valid = shipped.clone();
    shipped.runnables[0].config = None;
    *manifests.write().await = vec![shipped];
    fire_activation_event_from_parts(
        &store,
        &runtime,
        &manifests,
        &registry,
        &mcp,
        "onCommand:activation-fixture",
    )
    .await;
    let failed_generation = runtime
        .acquire(&valid.id)
        .await
        .unwrap()
        .generation()
        .clone();
    assert_eq!(
        app_ids(&mcp).await.len(),
        expected.len() - 1,
        "valid siblings still register on partial failure"
    );
    *manifests.write().await = vec![valid.clone()];
    fire_activation_event_from_parts(
        &store,
        &runtime,
        &manifests,
        &registry,
        &mcp,
        "onCommand:activation-fixture",
    )
    .await;
    assert_eq!(
        app_ids(&mcp).await.len(),
        expected.len() - 1,
        "current semantics do not retry a committed partial activation"
    );
    store.set_disabled(&valid.id).await.unwrap();
    drop(runtime.begin_deactivation(&valid.id).await);
    store
        .set_enabled(&valid.id, &valid.permission_grants)
        .await
        .unwrap();
    fire_activation_event_from_parts(
        &store,
        &runtime,
        &manifests,
        &registry,
        &mcp,
        "onCommand:activation-fixture",
    )
    .await;
    assert!(!runtime.is_current(&failed_generation).await);
    let actual: std::collections::BTreeSet<_> = app_ids(&mcp).await;
    assert_eq!(
        actual, expected,
        "deactivation/reactivation repairs failed registrations"
    );
    for manifest in all_shipped {
        let store = PluginStore::open_in_memory().unwrap();
        let runtime = crate::plugins::runtime::PluginRuntime::new();
        let mcp = Arc::new(McpRegistry::empty());
        let agents = AgentStore::open_in_memory(&AcpAgentRegistry::new()).unwrap();
        let skills = SkillRegistry::empty();
        let contributions = crate::plugins::app_contrib::AppContribRegistry::default();
        let registry = build_runnable_registry_from_parts(&agents, &mcp, &skills, &contributions);
        let manifests = tokio::sync::RwLock::new(vec![manifest.clone()]);
        store.insert(&manifest.id, &manifest.version).await.unwrap();
        fire_activation_event_from_parts(&store, &runtime, &manifests, &registry, &mcp, "onChat")
            .await;
        assert!(
            !runtime.is_active(&manifest.id).await,
            "{}: disabled",
            manifest.id
        );
        assert!(
            app_ids(&mcp).await.is_empty(),
            "{}: disabled tool refusal",
            manifest.id
        );
        assert!(
            skills.list_all().is_empty(),
            "{}: disabled skill refusal",
            manifest.id
        );
        store
            .set_enabled(&manifest.id, &manifest.permission_grants)
            .await
            .unwrap()
            .unwrap();
        fire_activation_event_from_parts(&store, &runtime, &manifests, &registry, &mcp, "onChat")
            .await;
        let first = runtime
            .acquire(&manifest.id)
            .await
            .unwrap()
            .generation()
            .clone();
        assert!(store.get(&manifest.id).await.unwrap().unwrap().enabled);
        for entry in &manifest.runnables {
            use crate::plugin_manifest::schema::{
                AgentConfig, SkillConfig, ToolConfig, WorkflowConfig,
            };
            use crate::runnable::RunnableKind;
            let config = entry.config.clone().unwrap();
            match entry.kind {
                RunnableKind::Tool => {
                    let cfg: ToolConfig = serde_json::from_value(config).unwrap();
                    let id = crate::sidecar::mcp::app_tool_registered_id(&cfg);
                    assert!(app_ids(&mcp).await.contains(&id), "{}: {}", manifest.id, id);
                }
                RunnableKind::Skill => {
                    let cfg: SkillConfig = serde_json::from_value(config).unwrap();
                    let id = format!("app__{}", cfg.skill_id);
                    let skill = skills
                        .list_all()
                        .into_iter()
                        .find(|skill| skill.id == id)
                        .unwrap();
                    assert_eq!(skill.name, entry.name);
                    assert!(skill.enabled);
                    assert!(
                        skill.instructions.is_empty(),
                        "registration supplies identity, not a materialized skill body"
                    );
                }
                RunnableKind::Agent => {
                    let cfg: AgentConfig = serde_json::from_value(config).unwrap();
                    let record = agents
                        .get(&format!("app__{}", entry.id))
                        .await
                        .unwrap()
                        .unwrap();
                    assert_eq!(record.name, entry.name);
                    assert_eq!(record.system_prompt, cfg.system_prompt);
                }
                RunnableKind::Workflow => {
                    let cfg: WorkflowConfig = serde_json::from_value(config).unwrap();
                    let workflow =
                        crate::workflow::store::load_workflow(&format!("app__{}", entry.id))
                            .unwrap();
                    assert_eq!(workflow.name, entry.name);
                    assert_eq!(workflow.description, Some(format!("entry: {}", cfg.entry)));
                    assert!(
                        workflow.nodes.is_empty(),
                        "registration does not execute workflow steps"
                    );
                }
                RunnableKind::Policy => {
                    assert!(crate::plugin_manifest::schema::validate_runnable(entry).is_ok());
                    // Policy handler validates only; Gateway application is a separate runtime seam.
                }
                other => panic!("new shipped handler kind needs readback proof: {other:?}"),
            }
        }
        let tools_before = app_ids(&mcp).await;
        fire_activation_event_from_parts(
            &store,
            &runtime,
            &manifests,
            &registry,
            &mcp,
            "onCommand:shipped-activation-matrix",
        )
        .await;
        assert!(
            runtime.is_current(&first).await,
            "{}: idempotent generation",
            manifest.id
        );
        assert_eq!(app_ids(&mcp).await, tools_before);
        store.set_disabled(&manifest.id).await.unwrap().unwrap();
        drop(runtime.begin_deactivation(&manifest.id).await);
        fire_activation_event_from_parts(&store, &runtime, &manifests, &registry, &mcp, "onChat")
            .await;
        assert!(
            !runtime.is_active(&manifest.id).await,
            "{}: disabled recovery gate",
            manifest.id
        );
        assert!(!runtime.is_current(&first).await);
        store
            .set_enabled(&manifest.id, &manifest.permission_grants)
            .await
            .unwrap()
            .unwrap();
        fire_activation_event_from_parts(
            &store,
            &runtime,
            &manifests,
            &registry,
            &mcp,
            "onCommand:shipped-activation-matrix",
        )
        .await;
        assert!(runtime.is_active(&manifest.id).await);
        assert!(
            !runtime.is_current(&first).await,
            "{}: recovered generation is new",
            manifest.id
        );
        assert_eq!(app_ids(&mcp).await, tools_before);
        println!("activation matrix: {} runnables={} wildcard={} phase=disabled/active/idempotent/disabled/recovered", manifest.id, manifest.runnables.len(), !manifest.activation_events.is_empty());
    }
}
