//! Actual shipped agent bytes through ZIP verification and production activation.
use super::*;
use std::io::{Cursor, Write};

fn archive(manifest: &[u8], artifact: &[u8]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in [("ryu.package.json", manifest), ("agent.json", artifact)] {
        writer
            .start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

fn install_agent(manifest: &[u8], artifact: &[u8]) -> crate::portable_packages::InstalledPackage {
    let manifest: serde_json::Value = serde_json::from_slice(manifest).unwrap();
    let archive = archive(&serde_json::to_vec(&manifest).unwrap(), artifact);
    let extracted = crate::portable_packages::extract_archive(&archive).unwrap();
    crate::portable_packages::install(
        "agent",
        manifest["id"].as_str().unwrap(),
        &archive,
        Some(&extracted.package_digest),
        Some(&hex::encode(Sha256::digest(&archive))),
        manifest["version"].as_str(),
        false,
    )
    .unwrap()
}

fn assert_record(record: &crate::agents::AgentRecord, expected: &crate::agents::AgentTemplate) {
    let config = &expected.agent_config;
    assert_eq!(record.name, expected.name);
    assert_eq!(record.version, expected.version);
    assert_eq!(record.description, config.description);
    assert_eq!(record.system_prompt, config.system_prompt);
    let expected_tools = if config.tools.is_empty() {
        vec![crate::agents::NO_AGENT_CAPABILITIES.to_owned()]
    } else {
        config.tools.clone()
    };
    assert_eq!(record.tools, expected_tools);
    assert_eq!(record.skills, config.skills);
    assert_eq!(record.engine, config.engine);
    assert_eq!(record.model, config.model);
    let expected_chat_model = config.chat_model.clone().or_else(|| {
        (config.model.is_some() || config.engine.is_some()).then(|| crate::agents::ModelSlot {
            model_id: config.model.clone(),
            engine: config.engine.clone(),
        })
    });
    assert_eq!(record.chat_model, expected_chat_model);
    assert!(record.identity_profile_ids.is_empty());
    assert!(record.composio_actions.is_empty());
    assert!(record.memory.is_none());
    assert!(record.policy_ref.is_none());
    assert!(!record.built_in);
    assert!(!record.can_create_agents_enabled());
    assert!(matches!(
        record.safety_profile,
        crate::agents::AgentSafetyProfile::ReadOnly
    ));
}

#[tokio::test]
async fn marketplace_store_all_shipped_agents_zip_activation_readback_and_lifecycle() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../marketplace-store/agents");
    let mut paths: Vec<_> = std::fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.is_dir())
        .collect();
    paths.sort();
    assert_eq!(
        paths.len(),
        11,
        "new shipped agents need lifecycle coverage"
    );
    let store = crate::agents::AgentStore::open_in_memory(
        &crate::sidecar::adapters::acp::AcpAgentRegistry::new(),
    )
    .unwrap();
    for path in paths {
        let artifact = std::fs::read(path.join("agent.json")).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&artifact).unwrap();
        let template: crate::agents::AgentTemplate =
            serde_json::from_value(value["template"].clone()).unwrap();
        let schedules = template.agent_config.schedules.clone();
        let (safe, _) = template.sanitize_for_untrusted_install();
        let package = install_agent(
            &std::fs::read(path.join("ryu.package.json")).unwrap(),
            &artifact,
        );
        assert!(!package.enabled);
        let files = package_files("agent", &package.id).unwrap();
        assert_eq!(files["agent.json"], artifact);
        let enabled = enable_agent_in_store(&store, "agent", &package.id, &package, &files)
            .await
            .unwrap();
        assert!(enabled.enabled);
        assert_eq!(enabled.runtime_ids.len(), 1);
        let runtime_id = &enabled.runtime_ids[0];
        assert_record(&store.get(runtime_id).await.unwrap().unwrap(), &safe);
        let jobs = crate::scheduler::store::list_jobs();
        let owned: Vec<_> = jobs.iter().filter(|job| matches!(&job.target, crate::scheduler::store::JobTarget::Agent {agent_id, ..} if agent_id == runtime_id)).collect();
        assert_eq!(owned.len(), schedules.len(), "{}", package.id);
        for schedule in &schedules {
            let job = owned
                .iter()
                .find(|job| job.name == schedule.name.trim())
                .unwrap();
            assert_eq!(job.schedule, schedule.schedule);
            assert_eq!(job.enabled, schedule.enabled);
            assert_eq!(job.require_approval, schedule.require_approval);
            match &job.target {
                crate::scheduler::store::JobTarget::Agent {
                    prompt,
                    conversation_id,
                    ..
                } => {
                    assert_eq!(prompt, schedule.instructions.trim());
                    assert_eq!(conversation_id, &schedule.conversation_id);
                }
                _ => unreachable!(),
            }
        }
        let repeated = enable_agent_in_store(&store, "agent", &package.id, &enabled, &files)
            .await
            .unwrap();
        assert_eq!(repeated.runtime_ids, enabled.runtime_ids);
        assert_eq!(crate::scheduler::store::list_jobs().len(), jobs.len());
        let disabled = disable_agent_in_store(&store, "agent", &package.id)
            .await
            .unwrap();
        assert!(!disabled.enabled);
        assert!(store.get(runtime_id).await.unwrap().is_none());
        assert!(super::super::agent_schedule_templates(runtime_id).is_empty());
        let restored = enable_agent_in_store(&store, "agent", &package.id, &disabled, &files)
            .await
            .unwrap();
        assert_ne!(restored.runtime_ids, enabled.runtime_ids);
        assert_record(
            &store.get(&restored.runtime_ids[0]).await.unwrap().unwrap(),
            &safe,
        );
        disable_agent_in_store(&store, "agent", &package.id)
            .await
            .unwrap();
        crate::portable_packages::uninstall("agent", &package.id).unwrap();
        assert!(crate::portable_packages::get("agent", &package.id)
            .unwrap()
            .is_none());
        assert!(store.get(&restored.runtime_ids[0]).await.unwrap().is_none());
        assert!(super::super::agent_schedule_templates(&restored.runtime_ids[0]).is_empty());
    }
}

#[tokio::test]
async fn marketplace_store_agent_raw_compatibility_and_invalid_templates_leave_no_agent() {
    let store = crate::agents::AgentStore::open_in_memory(
        &crate::sidecar::adapters::acp::AcpAgentRegistry::new(),
    )
    .unwrap();
    let baseline = store.list().await.unwrap().len();
    let manifest = serde_json::json!({"schemaVersion":1,"kind":"agent","id":"fixture/marketplace-agent-errors","name":"Fixture","version":"1.0.0","artifacts":["agent.json"],"targets":["ryu-desktop"],"scopes":["agent"]});
    let raw = serde_json::json!({"kind":"agent","name":"Raw compatible","version":"1.0.0","agent_config":{"system_prompt":"exact raw prompt","tools":["__ryu_none__"],"identity_profile_ids":["foreign"],"composio_actions":["WRITE"],"engine":"acp-exec:/tmp/unsafe"}});
    for (artifact, expected_error) in [
        (b"not json".to_vec(), Some("portable agent template is invalid")),
        (serde_json::to_vec(&serde_json::json!({"template":{"kind":"workflow","name":"Wrong","version":"1.0.0","agent_config":{}}})).unwrap(), Some("kind must be agent")),
        (serde_json::to_vec(&serde_json::json!({"kind":"agent","name":"Bad schedule","version":"1.0.0","agent_config":{"schedules":[{"name":"bad","schedule":{"kind":"every","interval":"not-a-duration"},"instructions":"check"}]}})).unwrap(), Some("agent schedules could not be saved")),
        (serde_json::to_vec(&raw).unwrap(), None),
    ] {
        let package = install_agent(&serde_json::to_vec(&manifest).unwrap(), &artifact);
        let files = package_files("agent", &package.id).unwrap();
        let result = enable_agent_in_store(&store, "agent", &package.id, &package, &files).await;
        if let Some(message) = expected_error {
            assert!(result.unwrap_err().to_string().contains(message));
            assert_eq!(store.list().await.unwrap().len(), baseline);
            let readback = crate::portable_packages::get("agent", &package.id).unwrap().unwrap();
            assert!(!readback.enabled);
            assert!(readback.runtime_ids.is_empty());
        } else {
            let enabled = result.unwrap();
            let record = store.get(&enabled.runtime_ids[0]).await.unwrap().unwrap();
            assert_eq!(record.system_prompt.as_deref(), Some("exact raw prompt"));
            assert_eq!(record.tools, vec!["__ryu_none__"]);
            assert!(record.engine.is_none());
            assert!(record.identity_profile_ids.is_empty());
            assert!(record.composio_actions.is_empty());
            disable_agent_in_store(&store, "agent", &package.id).await.unwrap();
        }
        crate::portable_packages::uninstall("agent", &package.id).unwrap();
    }
}
