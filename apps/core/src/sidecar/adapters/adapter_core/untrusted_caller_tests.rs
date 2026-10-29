use super::*;

#[cfg(test)]
mod untrusted_caller_policy_tests {
    use super::*;

    fn untrusted_request() -> ChatStreamRequest {
        ChatStreamRequest {
            untrusted_caller: true,
            ..ChatStreamRequest::default()
        }
    }

    #[test]
    fn untrusted_caller_tools_keep_only_the_reviewed_safe_set() {
        let effective = untrusted_caller_tools(
            [
                "notify.desktop",
                "spaces.list_documents",
                "search_conversations.search",
                "composio.GMAIL_SEND_EMAIL",
                "files.read_file",
                "shell.exec",
                "plugin_server.new_tool",
            ]
            .map(str::to_owned),
        );
        assert_eq!(effective, vec!["notify.desktop"]);
    }

    #[test]
    fn untrusted_caller_turns_never_run_on_runtimes_with_their_own_tools() {
        let gateway = AgentRoute::OpenAiCompat {
            base_url: "https://gateway.example.com/v1".to_owned(),
            model: "managed-model".to_owned(),
            api_key: None,
            via_gateway: true,
        };
        let direct = AgentRoute::OpenAiCompat {
            base_url: "https://provider.example.com/v1".to_owned(),
            model: "direct-model".to_owned(),
            api_key: None,
            via_gateway: false,
        };
        let local = AgentRoute::LocalEngine {
            engine: "llamacpp".to_owned(),
            base_url: "http://127.0.0.1:1234".to_owned(),
            model: Some("local-model".to_owned()),
        };
        assert!(untrusted_caller_route_supported(&gateway));
        assert!(untrusted_caller_route_supported(&direct));
        assert!(untrusted_caller_route_supported(&local));
        for own_tool_loop in [
            AgentRoute::Acp {
                spawn_cmd: "provider-agent".to_owned(),
            },
            AgentRoute::A2a {
                peer_id: "peer-1".to_owned(),
            },
            AgentRoute::SdkApp {
                base_url: "http://127.0.0.1:1234".to_owned(),
                model: "app-model".to_owned(),
            },
        ] {
            assert!(!untrusted_caller_route_supported(&own_tool_loop));
        }
    }

    /// An unverified caller's allowlist is explicit and can only narrow the
    /// agent's own; an owner turn keeps the agent's allowlist untouched.
    #[tokio::test]
    async fn caller_scope_narrows_untrusted_turns_and_leaves_owner_turns_alone() {
        let registry = McpRegistry::empty();
        assert_eq!(caller_scoped_tool_allowlist(false, &registry, None), None);
        let agent_list = Some(vec!["spaces".to_owned()]);
        assert_eq!(
            caller_scoped_tool_allowlist(false, &registry, agent_list.clone()),
            agent_list
        );

        assert_eq!(
            caller_scoped_tool_allowlist(true, &registry, None),
            Some(vec!["notify.desktop".to_owned()])
        );
        assert_eq!(
            caller_scoped_tool_allowlist(true, &registry, agent_list),
            Some(Vec::new()),
            "an agent that never had notify.desktop does not gain it"
        );
        assert_eq!(
            caller_scoped_tool_allowlist(true, &registry, Some(Vec::new())),
            Some(Vec::new())
        );
        assert_eq!(
            caller_scoped_tool_allowlist(true, &registry, Some(vec!["notify".to_owned()])),
            Some(vec!["notify.desktop".to_owned()]),
            "a server-level grant still matches the safe tool"
        );
    }

    /// Enforcement happens at dispatch: a model that names a denied tool is
    /// refused by the registry call gate even though nothing hid it, the safe
    /// tool still runs, and an owner turn is not refused by this profile.
    #[tokio::test]
    async fn untrusted_caller_dispatch_refuses_denied_tools_and_runs_allowed_ones() {
        let registry = McpRegistry::empty();
        let request = untrusted_request();
        let allowlist = caller_scoped_tool_allowlist(request.untrusted_caller, &registry, None)
            .expect("an unverified caller always gets an explicit allowlist");

        for denied in ["spaces.list_documents", "search_conversations.search"] {
            let error = registry
                .call_tool(
                    denied,
                    serde_json::json!({ "space_id": "owner-space", "query": "bank" }),
                    Some(&allowlist),
                )
                .await
                .expect_err("a denied tool must not run for an unverified caller");
            assert!(
                error.to_string().contains("not in this agent's allowlist"),
                "{denied} must be refused by the allowlist gate: {error}"
            );
        }

        let message = registry
            .call_tool(
                "notify.desktop",
                serde_json::json!({ "title": "Message from a caller", "body": "Please call back." }),
                Some(&allowlist),
            )
            .await;
        assert!(message.is_ok(), "the safe tool still runs: {message:?}");

        let owner = ChatStreamRequest::default();
        let owner_allowlist = caller_scoped_tool_allowlist(owner.untrusted_caller, &registry, None);
        assert!(owner_allowlist.is_none(), "owner turns stay unrestricted");
        let owner_call = registry
            .call_tool(
                "spaces.list_documents",
                serde_json::json!({ "space_id": "owner-space" }),
                owner_allowlist.as_deref(),
            )
            .await;
        if let Err(error) = owner_call {
            assert!(
                !error.to_string().contains("allowlist"),
                "the owner's call is not refused by the caller profile: {error}"
            );
        }
    }

    /// The untrusted-caller header rides every unverified caller's Gateway hop
    /// and never an owner's turn or a raw provider request.
    #[test]
    fn untrusted_caller_header_is_sent_only_for_untrusted_gateway_turns() {
        let notify = vec!["notify.desktop".to_owned()];
        assert_eq!(
            caller_trust_headers(true, true, false, Some(&notify)),
            vec![("x-ryu-untrusted-caller", "1")]
        );
        assert_eq!(
            caller_trust_headers(true, true, false, Some(&[])),
            vec![("x-ryu-raw-tools", "on"), ("x-ryu-untrusted-caller", "1")]
        );
        assert!(caller_trust_headers(true, false, false, None).is_empty());
        assert!(caller_trust_headers(true, false, false, Some(&notify)).is_empty());
        assert!(caller_trust_headers(false, true, false, Some(&[])).is_empty());
        assert_eq!(
            caller_trust_headers(false, false, true, None),
            vec![("x-ryu-raw-tools", "on")],
            "Core's own tools keep raw-tools passthrough as before"
        );
    }

    /// The proved host conversation rides only the Gateway hop, so the
    /// Gateway's tool loop can carry the turn owner to Core; a raw provider
    /// never sees the proof, and an id Core's tool route rejects is not sent.
    #[test]
    fn host_conversation_headers_ride_only_the_gateway_hop() {
        assert_eq!(
            host_conversation_headers(true, Some("conv-1")),
            vec![
                ("x-ryu-host-conversation-id", "conv-1".to_owned()),
                (
                    "x-ryu-host-conversation-proof",
                    crate::server::host_conversation_proof("conv-1"),
                ),
            ]
        );
        assert!(host_conversation_headers(false, Some("conv-1")).is_empty());
        assert!(host_conversation_headers(true, None).is_empty());
        assert!(host_conversation_headers(true, Some("")).is_empty());
        assert!(host_conversation_headers(true, Some("../conv")).is_empty());
    }

    fn member(user_id: &str, org_id: &str) -> crate::identity_verify::VerifiedCaller {
        crate::identity_verify::VerifiedCaller {
            user_id: user_id.to_owned(),
            email: None,
            email_verified: false,
            org_id: Some(org_id.to_owned()),
            role: crate::identity_verify::OrgRole::Member,
            teams: Vec::new(),
        }
    }

    /// A member who may write in a colleague's shared conversation must not get
    /// a proof that makes the Gateway's tool loop run as that colleague (their
    /// connected accounts, OAuth tokens and user tool layer).
    #[test]
    fn only_the_owning_author_lets_the_gateway_act_for_a_conversation() {
        let shared = crate::identity_verify::ResourceTenancy {
            owner_user_id: Some("alice".to_owned()),
            org_id: Some("org_1".to_owned()),
            visibility: "org".to_owned(),
            team_id: None,
            collaborators: vec![crate::identity_verify::ResourceCollaborator {
                user_id: "bob".to_owned(),
                access: crate::identity_verify::Access::Write,
            }],
        };
        let alice = member("alice", "org_1");
        assert!(turn_author_owns_host_conversation(
            &shared,
            Some(&alice),
            Some("org_1"),
            true
        ));
        // A same-org member or write collaborator is not the owner.
        assert!(!turn_author_owns_host_conversation(
            &shared,
            Some(&member("bob", "org_1")),
            Some("org_1"),
            true
        ));
        // The owner's id under another org, or on another org's node.
        assert!(!turn_author_owns_host_conversation(
            &shared,
            Some(&member("alice", "org_2")),
            Some("org_1"),
            true
        ));
        assert!(!turn_author_owns_host_conversation(
            &shared,
            Some(&alice),
            Some("org_2"),
            true
        ));
        // No verified author: never on a bound node, and never for an owned row.
        assert!(!turn_author_owns_host_conversation(
            &shared, None, None, false
        ));
        let unowned = crate::identity_verify::ResourceTenancy {
            owner_user_id: None,
            org_id: None,
            visibility: "private".to_owned(),
            team_id: None,
            collaborators: Vec::new(),
        };
        assert!(turn_author_owns_host_conversation(
            &unowned, None, None, false
        ));
        assert!(!turn_author_owns_host_conversation(
            &unowned,
            None,
            Some("org_1"),
            true
        ));
        assert!(!turn_author_owns_host_conversation(
            &unowned,
            Some(&alice),
            Some("org_1"),
            true
        ));
    }

    #[tokio::test]
    async fn gateway_host_conversation_is_kept_for_the_owner_and_dropped_for_a_writer() {
        use crate::sidecar::control_plane::{
            with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
        };
        let conversations = ConversationStore::open_in_memory().unwrap();
        conversations
            .ensure_conversation(
                "alice-shared",
                None,
                None,
                Tenancy::Owned {
                    user_id: "alice".to_owned(),
                    org_id: Some("org_1".to_owned()),
                },
            )
            .await
            .unwrap();
        assert!(conversations
            .set_visibility("alice-shared", "org", None, false)
            .await
            .unwrap());
        let node = RegisteredNode {
            org: RegisteredOrg {
                id: "org_1".to_owned(),
                name: "Acme".to_owned(),
                slug: None,
            },
            node_id: "node_1".to_owned(),
            scope: NodeScope::Org,
            team_id: None,
            owner_user_id: None,
        };
        let alice = member("alice", "org_1");
        let bob = member("bob", "org_1");
        with_test_node_binding(false, Some(node), async {
            // Bob may write here (org visibility), but the Gateway loop gets no
            // proof for his turn, so it stays unresolved instead of Alice.
            let meta = conversations.get_access_meta("alice-shared").await.unwrap();
            assert!(crate::server::require_resource_write(Ok(meta), Some(&bob), "missing").is_ok());
            assert_eq!(
                gateway_host_conversation_for_turn(
                    &conversations,
                    Some("alice-shared"),
                    Some(&bob)
                )
                .await,
                None
            );
            assert_eq!(
                gateway_host_conversation_for_turn(
                    &conversations,
                    Some("alice-shared"),
                    Some(&alice)
                )
                .await
                .as_deref(),
                Some("alice-shared")
            );
            assert_eq!(
                gateway_host_conversation_for_turn(&conversations, Some("alice-shared"), None)
                    .await,
                None
            );
            assert_eq!(
                gateway_host_conversation_for_turn(&conversations, Some("missing"), Some(&alice))
                    .await,
                None
            );
        })
        .await;
    }

    #[test]
    fn gateway_managed_tools_are_suppressed_only_for_an_untrusted_turn_with_no_tools() {
        let notify = vec!["notify.desktop".to_owned()];
        assert!(suppress_gateway_managed_tools(true, Some(&[])));
        assert!(suppress_gateway_managed_tools(true, None));
        assert!(!suppress_gateway_managed_tools(true, Some(&notify)));
        assert!(!suppress_gateway_managed_tools(false, Some(&[])));
        assert!(!suppress_gateway_managed_tools(false, None));
    }

    /// The flag is server-only: request JSON can neither set nor read it, so a
    /// browser cannot clear it and the voice session is its only source.
    #[test]
    fn untrusted_caller_flag_is_not_part_of_the_request_wire_format() {
        let decoded: ChatStreamRequest =
            serde_json::from_value(serde_json::json!({ "untrusted_caller": true }))
                .expect("decode request");
        assert!(!decoded.untrusted_caller);
        let serialized = serde_json::to_value(untrusted_request()).expect("serialize request");
        assert!(serialized.get("untrusted_caller").is_none());
    }
}
