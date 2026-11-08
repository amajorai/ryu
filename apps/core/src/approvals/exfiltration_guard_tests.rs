//! Tests of the exfiltration guard's data-flow classification.

use super::*;
use serde_json::json;

fn facts(origin: ToolOrigin) -> ToolFlowFacts<'static> {
    ToolFlowFacts {
        origin,
        annotations: None,
        connection_action: ConnectionAction::Unknown,
        provided_verbs: None,
    }
}

fn built_in(id: &str) -> DataFlow {
    classify_data_flow(id, &facts(ToolOrigin::BuiltIn))
}

#[test]
fn classifies_private_sources() {
    for id in PRIVATE_SOURCE_TOOLS
        .iter()
        .copied()
        .chain(["memory.search", "memory.context", "computer.capture"])
        .chain(["device.desk_camera_capture", "ryu_api.get_api_quests"])
    {
        let flow = built_in(id);
        assert!(flow.private_source, "{id} must be a private-data source");
    }
    // A Core API write is not a read of private data.
    assert!(!built_in("ryu_api.put_api_quests").private_source);
    assert!(!built_in("memory.store").private_source);

    let composio = |action| {
        classify_data_flow(
            "composio.GMAIL_FETCH_EMAILS",
            &ToolFlowFacts {
                origin: ToolOrigin::Composio,
                annotations: None,
                connection_action: action,
                provided_verbs: None,
            },
        )
    };
    assert!(composio(ConnectionAction::Read).private_source);
    assert!(!composio(ConnectionAction::Read).egress);
    assert!(composio(ConnectionAction::Unknown).private_source);
    assert!(!composio(ConnectionAction::Write).private_source);
    assert!(composio(ConnectionAction::Write).egress);
    assert!(composio(ConnectionAction::Delete).egress);

    let connected_mcp = |action| {
        classify_data_flow(
            "gmail.search",
            &ToolFlowFacts {
                origin: ToolOrigin::ExternalMcp {
                    connection_backed: true,
                },
                annotations: None,
                connection_action: action,
                provided_verbs: None,
            },
        )
    };
    // An explicit connected-account read is a source, but it only reaches the
    // user's own account, so a list-then-get loop is not held.
    assert!(connected_mcp(ConnectionAction::Read).private_source);
    assert!(!connected_mcp(ConnectionAction::Read).egress);
    // An unclassified action may send, so it stays both.
    assert!(connected_mcp(ConnectionAction::Unknown).private_source);
    assert!(connected_mcp(ConnectionAction::Unknown).egress);
    assert!(connected_mcp(ConnectionAction::Write).egress);
    let local_mcp = classify_data_flow(
        "files.read",
        &facts(ToolOrigin::ExternalMcp {
            connection_backed: false,
        }),
    );
    assert!(!local_mcp.private_source);
}

#[test]
fn classifies_egress_tools() {
    for id in [
        "web.search",
        "web.extract",
        "web.crawl",
        "browser.navigate",
        "browser.type",
        "web_fetch.get",
        "computer.click",
        "computer.type",
        "computer.key",
        "ryu_api.put_api_quests",
        "ryu_api.post_api_channels_run",
        "ryu_api.post_api_mcp_servers",
        "ryu_ext.ryu_crm.post_records",
    ]
    .into_iter()
    .chain(EGRESS_TOOLS.iter().copied())
    {
        assert!(built_in(id).egress, "{id} must be egress-capable");
    }
    for id in [
        "memory.store",
        "notify.desktop",
        "ui.render",
        "artifact.create",
        "workspace.switch_interface",
        "search_conversations.search",
        "computer.scroll",
        "computer.focus_app",
        "ryu_api.get_api_quests",
        "ryu_ext.ryu_crm.get_records_id",
    ] {
        assert!(!built_in(id).egress, "{id} must not be egress-capable");
    }

    let mcp = |annotations: Option<&'static Value>| {
        classify_data_flow(
            "acme.lookup",
            &ToolFlowFacts {
                origin: ToolOrigin::ExternalMcp {
                    connection_backed: false,
                },
                annotations,
                connection_action: ConnectionAction::Read,
                provided_verbs: None,
            },
        )
    };
    static CLOSED: std::sync::LazyLock<Value> =
        std::sync::LazyLock::new(|| json!({ "openWorldHint": false }));
    static OPEN: std::sync::LazyLock<Value> =
        std::sync::LazyLock::new(|| json!({ "openWorldHint": true }));
    static READ_ONLY: std::sync::LazyLock<Value> =
        std::sync::LazyLock::new(|| json!({ "readOnlyHint": true }));
    assert!(mcp(None).egress, "an unannotated external tool is egress");
    assert!(!mcp(Some(&CLOSED)).egress);
    assert!(mcp(Some(&OPEN)).egress);
    assert!(mcp(Some(&READ_ONLY)).egress);

    // A connected-account read that declares an open world is egress, even
    // when it is also read-only; a plain connected read is not.
    static OPEN_READ_ONLY: std::sync::LazyLock<Value> =
        std::sync::LazyLock::new(|| json!({ "readOnlyHint": true, "openWorldHint": true }));
    let connected = |annotations: Option<&'static Value>| {
        classify_data_flow(
            "firecrawl.scrape",
            &ToolFlowFacts {
                origin: ToolOrigin::ExternalMcp {
                    connection_backed: true,
                },
                annotations,
                connection_action: ConnectionAction::Read,
                provided_verbs: None,
            },
        )
    };
    assert!(!connected(Some(&READ_ONLY)).egress);
    assert!(connected(Some(&OPEN_READ_ONLY)).egress);

    for kind in [
        AppBackendKind::Http {
            core_loopback: false,
            get: false,
        },
        AppBackendKind::Http {
            core_loopback: false,
            get: true,
        },
        AppBackendKind::Command,
        AppBackendKind::InlineJs,
    ] {
        let flow = classify_data_flow("acme.tool", &facts(ToolOrigin::AppBackend(kind)));
        assert!(flow.egress, "{kind:?} app tools are egress-capable");
        assert!(!flow.private_source);
    }
}

#[test]
fn core_loopback_http_tools_read_private_data() {
    let core = |get| {
        classify_data_flow(
            "memorystore.list",
            &facts(ToolOrigin::AppBackend(AppBackendKind::Http {
                core_loopback: true,
                get,
            })),
        )
    };
    // `memorystore.list` (GET core:/api/memory) is bound by no verb.
    assert_eq!(
        core(true),
        DataFlow {
            private_source: true,
            egress: false
        }
    );
    // `memorystore.recall` (POST core:/api/retrieval/search) also reads; a
    // `core:` write can reach Core's forwarding routes, so it stays egress.
    assert_eq!(
        core(false),
        DataFlow {
            private_source: true,
            egress: true
        }
    );
}

#[test]
fn provider_tools_take_their_verbs_flow() {
    let manifests: Vec<crate::plugin_manifest::PluginManifest> = [
        include_str!("../plugin_manifest/fixtures/memory.manifest.json"),
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/mem0/manifest.json"),
        include_str!(
            "../../../../generated/ryu-runtime/plugins-store/plugins/honcho/manifest.json"
        ),
    ]
    .into_iter()
    .map(|raw| serde_json::from_str(raw).expect("manifest parses"))
    .collect();
    let flows = provider_tool_flows(&manifests);
    // The built-in memory provider's `memory.search` binding.
    assert!(flows["memorystore.recall"].private_source);
    // `memory.store` / `memory.forget` bindings are neutral.
    assert_eq!(flows["memorystore.save"], DataFlow::default());
    // External memory providers' search bindings read private memory.
    assert!(flows["mem0.search"].private_source, "{flows:?}");
    assert!(
        flows
            .iter()
            .any(|(id, flow)| id.starts_with("honcho.") && flow.private_source),
        "{flows:?}"
    );

    // A bound provider tool is never classified as less than its verb, and
    // its own backend's egress is kept.
    let mem0 = classify_data_flow(
        "mem0.search",
        &ToolFlowFacts {
            origin: ToolOrigin::AppBackend(AppBackendKind::Http {
                core_loopback: false,
                get: false,
            }),
            annotations: None,
            connection_action: ConnectionAction::Unknown,
            provided_verbs: flows.get("mem0.search").copied(),
        },
    );
    assert!(mem0.private_source && mem0.egress);
}

#[test]
fn read_only_annotations_do_not_clear_web_egress() {
    let annotations = json!({ "readOnlyHint": true, "openWorldHint": false });
    let flow = classify_data_flow(
        "web.search",
        &ToolFlowFacts {
            origin: ToolOrigin::BuiltIn,
            annotations: Some(&annotations),
            connection_action: ConnectionAction::Read,
            provided_verbs: None,
        },
    );
    assert!(flow.egress);
}

#[test]
fn browser_reads_and_web_fetch_are_not_private_sources() {
    for id in [
        "browser.snapshot",
        "browser.screenshot",
        "browser.context",
        "browser.tabs",
        "web_fetch.get",
    ] {
        let flow = built_in(id);
        assert!(!flow.private_source, "{id} must not taint a run");
        assert!(flow.egress, "{id} is still egress-capable");
    }
}

#[test]
fn every_capability_verb_has_a_declared_data_flow() {
    for verb in crate::sidecar::mcp::capability_tools::verbs() {
        assert!(
            capability_verb_flow(verb.id).is_some(),
            "capability verb `{}` must declare its data flow in capability_verb_flow",
            verb.id
        );
    }
    assert!(capability_verb_flow("browser.future_verb").is_none());
}

#[test]
fn egress_ids_are_never_chat_confirmable() {
    // A chat-wide "Allow" must never satisfy a held egress call. Core and app
    // API writes are chat-confirmable and egress too; for them the gate skips
    // chat grants whenever the guard holds the call
    // (`approvals::tests::a_held_call_never_consumes_a_chat_grant`).
    assert!(super::super::chat_grants::chat_confirmable(
        "ryu_api.post_api_channels_run"
    ));
    for id in EGRESS_TOOLS
        .iter()
        .copied()
        .chain(["web.search", "web.extract", "web.crawl", "web_fetch.get"])
        .chain(
            crate::sidecar::mcp::capability_tools::verbs()
                .iter()
                .map(|verb| verb.id)
                .filter(|id| built_in(id).egress),
        )
    {
        assert!(
            !super::super::chat_grants::chat_confirmable(id),
            "{id} must not be confirmable in chat"
        );
    }
}

#[test]
fn sequential_connected_reads_are_not_held() {
    // `github.list_issues` then a `github.get_issue` loop: the first read marks
    // the run, and the later reads are sources but not egress.
    let read = classify_data_flow(
        "github.get_issue",
        &ToolFlowFacts {
            origin: ToolOrigin::ExternalMcp {
                connection_backed: true,
            },
            annotations: None,
            connection_action: ConnectionAction::Read,
            provided_verbs: None,
        },
    );
    let run = RunDataFlow::default();
    assert_eq!(held_by(&run, read), None);
    run.mark_private_read("github.list_issues");
    for _ in 0..3 {
        assert_eq!(held_by(&run, read), None, "a connected read is not held");
    }
    // Sending out after the read is still held.
    assert_eq!(
        held_by(&run, built_in("web.extract")).as_deref(),
        Some("github.list_issues")
    );
}

#[tokio::test]
async fn the_run_scope_is_visible_only_inside_it() {
    assert!(current_sandbox_run().is_none());
    let run = Arc::new(RunDataFlow::default());
    let seen = scope_sandbox_run(Arc::clone(&run), async {
        current_sandbox_run().map(|inner| Arc::ptr_eq(&inner, &run))
    })
    .await;
    assert_eq!(seen, Some(true));
    assert!(current_sandbox_run().is_none());
}

#[test]
fn held_messages_name_the_tool_and_the_source() {
    let message = held_without_engine("web.extract", "memory.search").to_string();
    assert!(message.contains("`web.extract` was not run"));
    assert!(message.contains("`memory.search`"));
    let gate = anyhow::anyhow!("This action (`web.extract`) requires your approval.");
    let message = held_for_approval(&gate, "memory.search").to_string();
    assert!(message.starts_with("This action (`web.extract`) requires your approval."));
    assert!(message.contains("held because this program already read private data"));
}
