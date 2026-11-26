    #[test]
    fn selection_hash_keys_keep_kinds_distinct() {
        let skill = ImportSelection {
            kind: "skill".to_owned(),
            id: "shared-id".to_owned(),
        };
        let agent = ImportSelection {
            kind: "agent".to_owned(),
            id: "shared-id".to_owned(),
        };
        assert_ne!(selection_key(&skill), selection_key(&agent));
    }

    #[test]
    fn duplicate_import_selections_are_rejected_before_hashing() {
        let selection = ImportSelection {
            kind: "skill".to_owned(),
            id: "same".to_owned(),
        };
        assert_eq!(
            duplicate_selection_key(&[selection.clone(), selection]),
            Some("skill:same".to_owned())
        );
    }

    #[test]
    fn chat_export_items_are_fingerprinted_so_automatic_import_queues_them() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("conversations.json"), "[]").unwrap();
        fs::create_dir_all(root.join("projects")).unwrap();
        fs::write(root.join("projects/p.json"), "{}").unwrap();
        let chats = ImportSelection {
            kind: crate::import::kind::CONVERSATIONS.to_owned(),
            id: "conversations/conversations.json#chats".to_owned(),
        };
        // Split exports have no `conversations.json`; nothing is resolved.
        let saved = ImportSelection {
            kind: crate::import::kind::MEMORY.to_owned(),
            id: "memory/conversations-000.json#saved-context".to_owned(),
        };
        let mut budget = HashBudget::default();
        let first = hash_selected_item_with_budget(root, &chats, &mut budget)
            .unwrap()
            .expect("a chat export item has a fingerprint");
        assert_eq!(
            hash_selected_item_with_budget(root, &saved, &mut budget).unwrap(),
            Some(first.clone())
        );
        assert_eq!(budget.bytes, 0, "fingerprinting reads no file contents");
        fs::write(root.join("projects/p.json"), "{\"uuid\":\"x\"}").unwrap();
        assert_ne!(chat_export_fingerprint(root).unwrap(), first);
    }

    #[test]
    fn automatic_hash_budget_is_shared_across_items() {
        let dir = tempdir().unwrap();
        let first = dir.path().join("first.txt");
        let second = dir.path().join("second.txt");
        fs::write(&first, "a").unwrap();
        fs::write(&second, "b").unwrap();
        let mut budget = HashBudget {
            entries: 0,
            bytes: MAX_HASH_TOTAL_BYTES - 1,
        };
        assert!(hash_path_with_budget(&first, &mut budget).is_ok());
        assert!(hash_path_with_budget(&second, &mut budget).is_err());
    }

    #[test]
    fn skill_projection_is_safe_and_does_not_emit_credentials() {
        let skill = ryu_skills::SkillRecord {
            id: "safe-skill".to_owned(),
            name: "Safe skill".to_owned(),
            description: Some("A test skill".to_owned()),
            instructions: "Use the tool carefully.".to_owned(),
            allowed_tools: vec!["web.search".to_owned()],
            enabled: true,
            always_on: false,
        };
        let rendered = render_skill(&skill).unwrap();
        assert!(rendered.contains("safe-skill") || rendered.contains("Safe skill"));
        assert!(rendered.contains("web.search"));
        assert!(!rendered.contains("api_key"));
        assert!(safe_projection_segment("../escape").is_none());
        assert!(safe_projection_segment("safe-skill").is_some());
    }

    #[tokio::test]
    async fn automatic_import_skips_ryus_own_skill_projections_and_installs() {
        let store = AgentSyncStore::open_in_memory().unwrap();
        let dir = tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let profile = store
            .upsert_profile(ProfileInput {
                id: None,
                provider: "codex".to_owned(),
                root: root.to_string_lossy().to_string(),
                import_enabled: true,
                export_enabled: true,
                include_conversations: None,
            })
            .await
            .unwrap();
        let skill = ryu_skills::SkillRecord {
            id: "pdf".to_owned(),
            name: "pdf".to_owned(),
            description: Some("Read PDFs".to_owned()),
            instructions: "Use the scripts.".to_owned(),
            allowed_tools: Vec::new(),
            enabled: false,
            always_on: false,
        };
        project_skills(&store, &profile, &root, &[skill], "op-export", false, None)
            .await
            .unwrap();
        let selection = ImportSelection {
            kind: crate::import::kind::SKILL.to_owned(),
            id: "skill/skills/pdf".to_owned(),
        };
        let skill_dir = root.join("skills").join("pdf");
        fs::write(skill_dir.join("notes.md"), "extra").unwrap();
        assert_eq!(
            own_skill_skip_reason(&store, &profile.id, &root, &selection).await,
            Some("generated output")
        );

        let edited = "---\nname: pdf\n---\nEdited.";
        fs::write(skill_dir.join("SKILL.md"), edited).unwrap();
        assert_eq!(
            own_skill_skip_reason(&store, &profile.id, &root, &selection).await,
            None
        );

        // "Keep external" adopts the edit; it is the user's content, not Ryu's
        // projection, so it must stay importable.
        let adopted_hash = sha256_bytes(edited.as_bytes());
        store
            .upsert_item(
                &profile.id,
                "skill",
                "skills/pdf/SKILL.md",
                None,
                Some(&adopted_hash),
                "op-resolve",
                "external",
                Some(&json!({
                    "resolution": "keep_external",
                    "adopted_hash": adopted_hash,
                })),
            )
            .await
            .unwrap();
        assert_eq!(
            own_skill_skip_reason(&store, &profile.id, &root, &selection).await,
            None
        );

        let inside_install_dir = {
            let _env = ryu_skills::SKILLS_ENV_LOCK
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            std::env::set_var("RYU_SKILLS_DIR", root.join("skills"));
            let inside = is_inside_skills_install_dir(&skill_dir);
            std::env::remove_var("RYU_SKILLS_DIR");
            inside
        };
        assert!(inside_install_dir);
    }

    #[tokio::test]
    async fn acp_binding_is_device_scoped_and_updated_in_place() {
        let store = AgentSyncStore::open_in_memory().unwrap();
        store
            .record_acp_binding(
                "conversation-1",
                "agent-1",
                "claude",
                "session-a",
                None,
                &json!({ "loadSession": true }),
                "test-generation",
            )
            .unwrap();
        store
            .record_acp_binding(
                "conversation-1",
                "agent-1",
                "claude",
                "session-b",
                None,
                &json!({ "loadSession": false }),
                "test-generation",
            )
            .unwrap();
        let bindings = store.bindings().await.unwrap();
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].native_session_id, "session-b");
        assert_eq!(bindings[0].node_id, "test-node");
    }

    #[tokio::test]
    async fn deleted_incarnations_cannot_resume_or_overwrite_recreated_bindings() {
        let root = tempdir().unwrap();
        let canonical = Connection::open(root.path().join("conversations.db")).unwrap();
        canonical.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE conversations (id TEXT PRIMARY KEY, owner TEXT); INSERT INTO conversations VALUES ('chat', 'alice');").unwrap();
        crate::server::conversation_lifecycle::initialize(&canonical).unwrap();
        let path = root.path().join("agent-sync.db");
        let store = AgentSyncStore::open(path.clone()).unwrap();
        let old = store.current_generation("chat").unwrap().unwrap();
        // Pre-migration rows must not inherit the generation of an existing ID.
        store.conn.lock().await.execute("INSERT INTO acp_bindings (node_id, conversation_id, agent_id, engine, native_session_id, capabilities_json, updated_at) VALUES (?1, 'chat', 'agent', 'claude', 'legacy', '{}', 1)", [store.node_id()]).unwrap();
        assert!(store
            .binding_for_agent("chat", "agent")
            .await
            .unwrap()
            .is_none());
        store
            .record_acp_binding_async(
                "chat",
                "agent",
                "claude",
                "alice-session",
                None,
                &json!({}),
                &old,
            )
            .await
            .unwrap();
        assert_eq!(
            store
                .binding_for("chat")
                .await
                .unwrap()
                .unwrap()
                .native_session_id,
            "alice-session"
        );
        drop(store);
        let store = AgentSyncStore::open(path.clone()).unwrap();
        assert_eq!(
            store.current_generation("chat").unwrap().as_deref(),
            Some(old.as_str())
        );
        assert_eq!(store.bindings().await.unwrap().len(), 1);
        canonical
            .execute("DELETE FROM conversations WHERE owner = 'alice'", [])
            .unwrap();
        assert!(store
            .binding_for_agent("chat", "agent")
            .await
            .unwrap()
            .is_none());
        assert!(store.binding_for("chat").await.unwrap().is_none());
        assert!(store.bindings().await.unwrap().is_empty());
        assert!(store
            .record_acp_binding_async(
                "chat",
                "agent",
                "claude",
                "late-old",
                None,
                &json!({}),
                &old
            )
            .await
            .is_err());
        canonical
            .execute("INSERT INTO conversations VALUES ('chat', 'bob')", [])
            .unwrap();
        let new = store.current_generation("chat").unwrap().unwrap();
        assert_ne!(old, new);
        assert!(store.binding_for("chat").await.unwrap().is_none());
        store
            .record_acp_binding_async(
                "chat",
                "agent",
                "claude",
                "bob-session",
                None,
                &json!({}),
                &new,
            )
            .await
            .unwrap();
        assert!(store
            .record_acp_binding_async(
                "chat",
                "agent",
                "claude",
                "late-old",
                None,
                &json!({}),
                &old
            )
            .await
            .is_err());
        assert_eq!(
            store
                .binding_for("chat")
                .await
                .unwrap()
                .unwrap()
                .native_session_id,
            "bob-session"
        );
        drop(store);
        let store = AgentSyncStore::open(path).unwrap();
        assert_eq!(
            store
                .binding_for("chat")
                .await
                .unwrap()
                .unwrap()
                .native_session_id,
            "bob-session"
        );
        canonical.execute("DELETE FROM conversations", []).unwrap();
        assert!(store.bindings().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn sync_item_revisions_increment_on_retry() {
        let store = AgentSyncStore::open_in_memory().unwrap();
        let dir = tempdir().unwrap();
        let profile = store
            .upsert_profile(ProfileInput {
                id: None,
                provider: "claude".to_owned(),
                root: dir.path().to_string_lossy().to_string(),
                import_enabled: false,
                export_enabled: false,
                include_conversations: None,
            })
            .await
            .unwrap();
        store
            .upsert_item(
                &profile.id,
                "instructions",
                "AGENTS.md",
                Some("source-a"),
                None,
                "op-a",
                "imported",
                None,
            )
            .await
            .unwrap();
        store
            .upsert_item(
                &profile.id,
                "instructions",
                "AGENTS.md",
                Some("source-b"),
                None,
                "op-b",
                "imported",
                None,
            )
            .await
            .unwrap();
        assert_eq!(
            store
                .item(&profile.id, "instructions", "AGENTS.md")
                .await
                .unwrap()
                .unwrap()
                .revision,
            2
        );
    }
