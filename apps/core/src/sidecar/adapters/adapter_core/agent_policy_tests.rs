use super::*;

#[cfg(test)]
mod public_agent_policy_tests {
    use super::*;

    fn policy(capabilities: &[&str]) -> PublicAgentRunPolicy {
        PublicAgentRunPolicy {
            published_agent_id: "publication-1".to_owned(),
            agent_id: "agent-1".to_owned(),
            capabilities: capabilities
                .iter()
                .map(|value| (*value).to_owned())
                .collect(),
        }
    }

    #[test]
    fn public_tool_intersection_omits_tools_outside_the_grant() {
        let policy = policy(&["tool:files.read_file"]);
        let effective = intersect_public_agent_tool_ids(
            [
                "files.read_file".to_owned(),
                "files.write_file".to_owned(),
                "shell.exec".to_owned(),
            ],
            &policy,
        );
        assert_eq!(effective, vec!["files.read_file"]);
        assert!(!effective.iter().any(|tool| tool == "files.write_file"));
        assert!(!effective.iter().any(|tool| tool == "shell.exec"));
    }

    #[test]
    fn public_runs_reject_routes_with_unmanaged_tool_execution() {
        let acp = AgentRoute::Acp {
            spawn_cmd: "provider-agent".to_owned(),
        };
        let remote_a2a = AgentRoute::A2a {
            peer_id: "peer-1".to_owned(),
        };
        let sdk_app = AgentRoute::SdkApp {
            base_url: "http://127.0.0.1:1234".to_owned(),
            model: "app-model".to_owned(),
        };
        let local = AgentRoute::LocalEngine {
            engine: "llamacpp".to_owned(),
            base_url: "http://127.0.0.1:1234".to_owned(),
            model: Some("local-model".to_owned()),
        };

        let tool_policy = policy(&["tool:files.read_file"]);
        let no_tools_policy = policy(&[]);
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

        assert!(!public_agent_route_supported(&acp, Some(&tool_policy)));
        assert!(!public_agent_route_supported(
            &remote_a2a,
            Some(&tool_policy)
        ));
        assert!(!public_agent_route_supported(&sdk_app, Some(&tool_policy)));
        assert!(!public_agent_route_supported(&local, Some(&tool_policy)));
        assert!(public_agent_route_supported(&gateway, Some(&tool_policy)));
        assert!(!public_agent_route_supported(&direct, Some(&tool_policy)));
        assert!(public_agent_route_supported(&local, Some(&no_tools_policy)));
        assert!(public_agent_route_supported(&acp, None));
    }

    #[test]
    fn public_tool_grants_require_a_read_only_annotation() {
        let policy = policy(&[
            "tool:web.search",
            "tool:files.write_file",
            "tool:custom.mislabelled",
        ]);
        let tools = [
            crate::sidecar::mcp::RegistryTool {
                id: "web.search".to_owned(),
                annotations: Some(serde_json::json!({ "readOnlyHint": true })),
                ..Default::default()
            },
            crate::sidecar::mcp::RegistryTool {
                id: "files.write_file".to_owned(),
                annotations: Some(serde_json::json!({ "readOnlyHint": false })),
                ..Default::default()
            },
            crate::sidecar::mcp::RegistryTool {
                id: "custom.mislabelled".to_owned(),
                ..Default::default()
            },
        ];

        assert_eq!(
            filter_public_agent_tools(tools, &policy),
            vec!["web.search"]
        );
    }

    #[test]
    fn read_only_app_runs_keep_only_read_only_annotated_tools() {
        let tools = [
            crate::sidecar::mcp::RegistryTool {
                id: "web.search".to_owned(),
                annotations: Some(serde_json::json!({ "readOnlyHint": true })),
                ..Default::default()
            },
            crate::sidecar::mcp::RegistryTool {
                id: "files.write_file".to_owned(),
                annotations: Some(serde_json::json!({ "readOnlyHint": false })),
                ..Default::default()
            },
            crate::sidecar::mcp::RegistryTool {
                id: "shell.exec".to_owned(),
                ..Default::default()
            },
        ];
        assert_eq!(filter_read_only_tools(tools), vec!["web.search"]);
    }

    #[test]
    fn withheld_working_memory_turns_drop_only_the_update_tool() {
        let tools = ["web.search", "working_memory.update_working_memory"].map(|id| {
            crate::sidecar::mcp::RegistryTool {
                id: id.to_owned(),
                ..Default::default()
            }
        });
        assert_eq!(filter_out_working_memory_tool(tools), vec!["web.search"]);
    }

    #[test]
    fn read_only_app_runs_refuse_routes_that_execute_their_own_tools() {
        let gateway = AgentRoute::OpenAiCompat {
            base_url: "https://gateway.example.com/v1".to_owned(),
            model: "managed-model".to_owned(),
            api_key: None,
            via_gateway: true,
        };
        let local = AgentRoute::LocalEngine {
            engine: "llamacpp".to_owned(),
            base_url: "http://127.0.0.1:1234".to_owned(),
            model: Some("local-model".to_owned()),
        };
        let acp = AgentRoute::Acp {
            spawn_cmd: "provider-agent".to_owned(),
        };
        let remote_a2a = AgentRoute::A2a {
            peer_id: "peer-1".to_owned(),
        };
        let sdk_app = AgentRoute::SdkApp {
            base_url: "http://127.0.0.1:1234".to_owned(),
            model: "app-model".to_owned(),
        };
        assert!(read_only_route_supported(&gateway));
        assert!(read_only_route_supported(&local));
        assert!(!read_only_route_supported(&acp));
        assert!(!read_only_route_supported(&remote_a2a));
        assert!(!read_only_route_supported(&sdk_app));
    }

    #[test]
    fn read_only_tools_flag_cannot_be_supplied_from_request_json() {
        let decoded: ChatStreamRequest =
            serde_json::from_value(serde_json::json!({ "read_only_tools": false }))
                .expect("decode request");
        assert!(!decoded.read_only_tools);
        let request = ChatStreamRequest {
            read_only_tools: true,
            ..ChatStreamRequest::default()
        };
        let serialized = serde_json::to_value(request).expect("serialize request");
        assert!(serialized.get("read_only_tools").is_none());
    }

    #[test]
    fn public_run_policy_cannot_be_supplied_or_read_from_request_json() {
        let decoded: ChatStreamRequest = serde_json::from_value(serde_json::json!({
            "public_agent_policy": {
                "published_agent_id": "forged-publication",
                "agent_id": "forged-agent",
                "capabilities": ["tool:shell.exec"]
            }
        }))
        .expect("decode request");
        assert!(decoded.public_agent_policy.is_none());

        let mut request = ChatStreamRequest::default();
        request.public_agent_policy = Some(policy(&["tool:files.read_file"]));
        let serialized = serde_json::to_value(request).expect("serialize request");
        assert!(serialized.get("public_agent_policy").is_none());
    }
}

#[cfg(test)]
mod chat_feature_tag_tests {
    use super::chat_feature_tag;

    #[test]
    fn programmatic_turns_without_a_human_author_are_agent_usage() {
        assert_eq!(chat_feature_tag(true, None), "agent");
        assert_eq!(chat_feature_tag(true, Some("")), "agent");
        assert_eq!(chat_feature_tag(true, Some("user-1")), "chat");
        assert_eq!(chat_feature_tag(false, None), "chat");
        assert_eq!(chat_feature_tag(false, Some("user-1")), "chat");
    }
}
