    const DENIED_AGENT_ID: &str = "agent-sync-denied-agent";
    const VISIBLE_AGENT_ID: &str = "agent-sync-visible-agent";
    static ACL_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct RestoredAgentAcl {
        key: crate::acl::store::ResourceKey,
        previous: Vec<crate::acl::store::StoredOverwrite>,
    }

    impl Drop for RestoredAgentAcl {
        fn drop(&mut self) {
            let _ = crate::acl::store::set_overwrites(&self.key, self.previous.clone());
        }
    }

    fn install_denied_agent_acl() -> RestoredAgentAcl {
        let key = crate::acl::store::ResourceKey::new(crate::acl::KIND_AGENT, DENIED_AGENT_ID);
        let previous = crate::acl::store::stored_for(&key);
        crate::acl::store::set_overwrites(
            &key,
            vec![crate::acl::store::StoredOverwrite {
                target_type: "member".to_owned(),
                target_id: "sync-bob".to_owned(),
                allow: Vec::new(),
                deny: vec![
                    crate::identity_verify::permissions::AGENT_RUN.to_owned(),
                    crate::identity_verify::permissions::AGENT_VIEW.to_owned(),
                ],
            }],
        )
        .expect("persist the agent sync ACL fixture");
        let restored = RestoredAgentAcl { key, previous };
        assert_eq!(crate::acl::store::stored_for(&restored.key).len(), 1);
        restored
    }

    fn sync_member(user_id: &str) -> crate::identity_verify::VerifiedCaller {
        crate::identity_verify::VerifiedCaller {
            user_id: user_id.to_owned(),
            email: None,
            email_verified: false,
            org_id: Some("sync-org".to_owned()),
            role: crate::identity_verify::OrgRole::Member,
            teams: Vec::new(),
        }
    }

    fn persisted_allowed_agent_ids(
        caller: &crate::identity_verify::VerifiedCaller,
    ) -> HashSet<String> {
        [DENIED_AGENT_ID, VISIBLE_AGENT_ID]
            .into_iter()
            .filter(|agent_id| {
                crate::acl::decide_with_context(
                    caller,
                    crate::acl::KIND_AGENT,
                    agent_id,
                    crate::identity_verify::permissions::AGENT_VIEW,
                    &HashSet::new(),
                    &HashSet::new(),
                ) == crate::acl::Decision::Allowed
            })
            .map(str::to_owned)
            .collect()
    }

    fn binding(conversation_id: &str, agent_id: &str) -> AcpBinding {
        AcpBinding {
            node_id: "sync-node".to_owned(),
            conversation_id: conversation_id.to_owned(),
            agent_id: agent_id.to_owned(),
            engine: "claude".to_owned(),
            native_session_id: format!("session-{conversation_id}"),
            conversation_generation: "test-generation".to_owned(),
            working_directory: None,
            capabilities: serde_json::json!({}),
            updated_at: 1,
        }
    }

    fn item(profile_id: &str, source_id: &str) -> SyncItemStatus {
        SyncItemStatus {
            profile_id: profile_id.to_owned(),
            kind: "instructions".to_owned(),
            source_id: source_id.to_owned(),
            source_hash: None,
            generated_hash: None,
            revision: 1,
            operation_id: None,
            state: "imported".to_owned(),
            conflict: None,
            updated_at: 1,
        }
    }

    fn template(name: &str) -> crate::agents::AgentTemplate {
        serde_json::from_value(serde_json::json!({
            "kind": "agent",
            "name": name,
            "version": "1.0.0",
            "agent_config": {}
        }))
        .expect("valid agent template")
    }

    #[test]
    fn persisted_agent_acl_filters_status_and_export_rows() {
        let _lock = ACL_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let _restore = install_denied_agent_acl();
        let caller = sync_member("sync-bob");
        let allowed_agent_ids = persisted_allowed_agent_ids(&caller);
        assert_eq!(
            allowed_agent_ids,
            [VISIBLE_AGENT_ID.to_owned()].into_iter().collect()
        );
        assert_eq!(
            crate::acl::decide_with_context(
                &caller,
                crate::acl::KIND_AGENT,
                DENIED_AGENT_ID,
                crate::identity_verify::permissions::AGENT_RUN,
                &HashSet::new(),
                &HashSet::new(),
            ),
            crate::acl::Decision::Denied
        );

        let readable_conversations = ["conversation-visible".to_owned()]
            .into_iter()
            .collect::<HashSet<_>>();
        let bindings = filter_status_bindings(
            vec![
                binding("conversation-denied-agent", DENIED_AGENT_ID),
                binding("conversation-visible", VISIBLE_AGENT_ID),
                binding("conversation-unreadable", VISIBLE_AGENT_ID),
            ],
            &allowed_agent_ids,
            &readable_conversations,
        );
        assert_eq!(
            bindings
                .iter()
                .map(|binding| binding.conversation_id.as_str())
                .collect::<Vec<_>>(),
            vec!["conversation-visible"]
        );

        let profile_agent_ids = HashMap::from([
            ("profile-denied".to_owned(), DENIED_AGENT_ID.to_owned()),
            ("profile-visible".to_owned(), VISIBLE_AGENT_ID.to_owned()),
        ]);
        let items = filter_status_items(
            vec![
                item("profile-denied", "private.md"),
                item("profile-visible", "shared.md"),
                item("profile-unmapped", "setup.md"),
            ],
            &profile_agent_ids,
            &allowed_agent_ids,
        );
        assert_eq!(
            items
                .iter()
                .map(|item| item.source_id.as_str())
                .collect::<Vec<_>>(),
            vec!["shared.md", "setup.md"]
        );

        let templates = filter_export_templates(
            vec![
                (DENIED_AGENT_ID.to_owned(), template("private agent")),
                (VISIBLE_AGENT_ID.to_owned(), template("visible agent")),
            ],
            &allowed_agent_ids,
        );
        assert_eq!(templates.len(), 1);
        assert_eq!(templates[0].name, "visible agent");
    }

    #[tokio::test]
    async fn duplicate_roots_are_idempotent_without_duplicate_profiles() {
        let store = AgentSyncStore::open_in_memory().unwrap();
        let dir = tempdir().unwrap();
        let first = store
            .upsert_profile(ProfileInput {
                id: None,
                provider: "claude".to_owned(),
                root: dir.path().to_string_lossy().to_string(),
                import_enabled: true,
                export_enabled: false,
                include_conversations: None,
            })
            .await
            .unwrap();
        let second = store
            .upsert_profile(ProfileInput {
                id: None,
                provider: "claude".to_owned(),
                root: dir.path().to_string_lossy().to_string(),
                import_enabled: false,
                export_enabled: true,
                include_conversations: None,
            })
            .await
            .unwrap();
        assert_eq!(first.id, second.id);
        assert!(!second.import_enabled);
        assert!(second.export_enabled);
        assert_eq!(store.profiles().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn conversation_export_is_opt_in_and_kept_until_changed() {
        let store = AgentSyncStore::open_in_memory().unwrap();
        let dir = tempdir().unwrap();
        let input = |include_conversations| ProfileInput {
            id: None,
            provider: "claude".to_owned(),
            root: dir.path().to_string_lossy().to_string(),
            import_enabled: false,
            export_enabled: true,
            include_conversations,
        };
        let created = store.upsert_profile(input(None)).await.unwrap();
        assert!(!created.include_conversations, "off by default");
        let opted_in = store.upsert_profile(input(Some(true))).await.unwrap();
        assert!(opted_in.include_conversations);
        // A toggle that does not mention it keeps the stored choice.
        let kept = store.upsert_profile(input(None)).await.unwrap();
        assert!(kept.include_conversations);
        let opted_out = store.upsert_profile(input(Some(false))).await.unwrap();
        assert!(!opted_out.include_conversations);
        let manual: ExportInput =
            serde_json::from_value(json!({ "destination": "/tmp/x" })).unwrap();
        assert!(!manual.include_conversations);
    }

    #[test]
    fn crashed_bundle_temporaries_are_swept_but_fresh_ones_kept() {
        let dir = tempdir().unwrap();
        let stale = dir.path().join(format!(".{BUNDLE_FILE_NAME}.old.tmp"));
        let fresh = dir.path().join(format!(".{BUNDLE_FILE_NAME}.new.tmp"));
        let other = dir.path().join("notes.tmp");
        for path in [&stale, &fresh, &other] {
            fs::write(path, "{}").unwrap();
        }
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(7200);
        fs::File::options()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_modified(old)
            .unwrap();
        assert_eq!(sweep_orphaned_bundle_temporaries(dir.path()), 1);
        assert!(!stale.exists());
        assert!(fresh.exists());
        assert!(other.exists());
        write_atomic(&dir.path().join(BUNDLE_FILE_NAME), b"{}").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.path().join(BUNDLE_FILE_NAME))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[tokio::test]
    async fn duplicate_roots_reject_a_different_explicit_profile() {
        let store = AgentSyncStore::open_in_memory().unwrap();
        let dir = tempdir().unwrap();
        store
            .upsert_profile(ProfileInput {
                id: Some("profile-a".to_owned()),
                provider: "claude".to_owned(),
                root: dir.path().to_string_lossy().to_string(),
                import_enabled: false,
                export_enabled: false,
                include_conversations: None,
            })
            .await
            .unwrap();
        let result = store
            .upsert_profile(ProfileInput {
                id: Some("profile-b".to_owned()),
                provider: "claude".to_owned(),
                root: dir.path().to_string_lossy().to_string(),
                import_enabled: false,
                export_enabled: false,
                include_conversations: None,
            })
            .await;
        assert!(result.is_err());
        assert_eq!(store.profiles().await.unwrap().len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn hash_rejects_symlink_traversal() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("target.txt");
        fs::write(&target, "secret").unwrap();
        let link = dir.path().join("link.txt");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&target, &link).unwrap();
        assert!(hash_path(&link).is_err());
    }

    #[test]
    fn hash_budget_rejects_cumulative_bytes() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("item.txt");
        fs::write(&file, "secret").unwrap();
        let metadata = fs::symlink_metadata(&file).unwrap();
        let mut budget = HashBudget {
            entries: 0,
            bytes: MAX_HASH_TOTAL_BYTES,
        };
        assert!(budget.visit(&metadata).is_err());
    }

    #[test]
    fn bundle_projection_hash_ignores_operation_metadata() {
        let first = Bundle {
            format: BUNDLE_FORMAT,
            version: BUNDLE_VERSION,
            operation_id: "one".to_owned(),
            generated_by: "ryu",
            node_id: "node-a".to_owned(),
            created_at: 1,
            agents: Vec::new(),
            skills: Vec::new(),
            conversations: Vec::new(),
            warnings: Vec::new(),
        };
        let mut second = first.clone();
        second.operation_id = "two".to_owned();
        second.created_at = 2;
        assert_eq!(
            bundle_projection_hash(&first).unwrap(),
            bundle_projection_hash(&second).unwrap()
        );
    }
