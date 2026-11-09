//! The memory guide: present only with memory tools, naming only those offered,
//! and byte-identical for the same tool set.

use super::*;

const EVERY_ID: [&str; 4] = [
    MEMORY_SEARCH_TOOL_ID,
    MEMORY_STORE_TOOL_ID,
    PAST_CHATS_TOOL_ID,
    WORKING_MEMORY_TOOL_ID,
];

fn hint_for(ids: &[&str], working_memory_active: bool) -> Option<String> {
    memory_usage_hint(OfferedMemoryTools::from_tool_ids(
        ids.iter().copied(),
        working_memory_active,
    ))
}

fn acp_route() -> AgentRoute {
    AgentRoute::Acp {
        spawn_cmd: "agent".to_owned(),
    }
}

fn gateway_route() -> AgentRoute {
    AgentRoute::OpenAiCompat {
        base_url: "http://127.0.0.1:1".to_owned(),
        model: "m".to_owned(),
        api_key: None,
        via_gateway: true,
    }
}

#[test]
fn the_guide_says_what_memory_is_for_and_names_every_offered_tool() {
    let hint = hint_for(&EVERY_ID, true).expect("memory tools are offered");
    assert!(hint.starts_with("## Memory\n"));
    assert!(hint.contains("continuity across sessions"));
    assert!(hint.contains("lessons from past failures"));
    assert!(hint.contains("verify one that matters"));
    for id in EVERY_ID {
        assert!(
            hint.contains(&format!("`{id}`")),
            "{id} missing from {hint}"
        );
    }
    // A handful of sentences, not a policy document.
    assert!(hint.lines().count() <= 7, "{hint}");
    assert!(hint.len() < 1_000, "{} bytes", hint.len());
}

#[test]
fn no_memory_tool_means_no_guide() {
    assert_eq!(memory_usage_hint(OfferedMemoryTools::default()), None);
    assert_eq!(hint_for(&["web_fetch.get", "notify.send"], true), None);
    assert_eq!(hint_for(&[], true), None);
}

#[test]
fn the_guide_names_only_the_tools_the_turn_offers() {
    let hint = hint_for(&[PAST_CHATS_TOOL_ID, "web_fetch.get"], true).unwrap();
    assert!(hint.contains(&format!("`{PAST_CHATS_TOOL_ID}` for past chats")));
    for absent in [
        MEMORY_SEARCH_TOOL_ID,
        MEMORY_STORE_TOOL_ID,
        WORKING_MEMORY_TOOL_ID,
    ] {
        assert!(!hint.contains(absent), "{absent} named in {hint}");
    }

    let search_only = hint_for(&[MEMORY_SEARCH_TOOL_ID], false).unwrap();
    assert!(search_only.contains(&format!("`{MEMORY_SEARCH_TOOL_ID}` for saved notes")));
    assert!(!search_only.contains(PAST_CHATS_TOOL_ID));
    assert!(!search_only.contains(MEMORY_STORE_TOOL_ID));

    let store_only = hint_for(&[MEMORY_STORE_TOOL_ID], false).unwrap();
    assert!(store_only.contains(&format!("correct it with `{MEMORY_STORE_TOOL_ID}`")));
    assert!(!store_only.contains("check what is relevant"));
}

#[test]
fn working_memory_is_named_only_when_the_turn_carries_its_block() {
    assert_eq!(hint_for(&[WORKING_MEMORY_TOOL_ID], false), None);
    let without = hint_for(&[MEMORY_SEARCH_TOOL_ID, WORKING_MEMORY_TOOL_ID], false).unwrap();
    assert!(!without.contains(WORKING_MEMORY_TOOL_ID));
    let with = hint_for(&[MEMORY_SEARCH_TOOL_ID, WORKING_MEMORY_TOOL_ID], true).unwrap();
    assert!(with.contains(WORKING_MEMORY_TOOL_ID));
}

#[test]
fn the_guide_is_byte_stable_for_the_same_tools() {
    let first = hint_for(&EVERY_ID, true).unwrap();
    let again = hint_for(&EVERY_ID, true).unwrap();
    assert_eq!(first.as_bytes(), again.as_bytes());
    let mut reversed = EVERY_ID;
    reversed.reverse();
    let reordered = hint_for(&[reversed.as_slice(), &["web_fetch.get"]].concat(), true).unwrap();
    assert_eq!(first.as_bytes(), reordered.as_bytes());
    // Nothing per-turn rides in it: no clock, no date.
    assert!(!first.chars().any(|c| c.is_ascii_digit()), "{first}");
}

#[test]
fn safe_mode_drops_the_guide() {
    let every = OfferedMemoryTools::from_tool_ids(EVERY_ID, true);
    assert_eq!(memory_usage_hint_when(true, every), None);
    assert_eq!(
        memory_usage_hint_when(false, every),
        memory_usage_hint(every)
    );
}

#[test]
fn the_named_ids_are_the_registry_ids() {
    let past_chats = crate::sidecar::mcp::search_conversations::tools();
    assert!(past_chats.iter().any(|tool| tool.id == PAST_CHATS_TOOL_ID));
    let working = crate::sidecar::mcp::working_memory_tool::tools();
    assert!(working.iter().any(|tool| tool.id == WORKING_MEMORY_TOOL_ID));
    let verbs = crate::sidecar::mcp::capability_tools::verbs();
    for id in [MEMORY_SEARCH_TOOL_ID, MEMORY_STORE_TOOL_ID] {
        assert!(verbs.iter().any(|verb| verb.id == id), "{id} is not a verb");
    }
}

#[test]
fn only_tool_offering_routes_carry_the_guide() {
    let allowlist = vec![PAST_CHATS_TOOL_ID.to_owned()];
    assert!(route_offers_turn_tools(&acp_route(), None));
    assert!(route_offers_turn_tools(&gateway_route(), Some(&allowlist)));
    // An unrestricted Gateway turn runs no tool loop unless hints arrive.
    assert!(!route_offers_turn_tools(&gateway_route(), None));
    let direct = AgentRoute::OpenAiCompat {
        base_url: "http://127.0.0.1:1".to_owned(),
        model: "m".to_owned(),
        api_key: None,
        via_gateway: false,
    };
    assert!(!route_offers_turn_tools(&direct, Some(&allowlist)));
    let local = AgentRoute::LocalEngine {
        engine: "llamacpp".to_owned(),
        base_url: "http://127.0.0.1:1".to_owned(),
        model: None,
    };
    assert!(!route_offers_turn_tools(&local, Some(&allowlist)));
}

#[tokio::test]
async fn a_turn_guide_follows_the_effective_allowlist() {
    let mcp = McpRegistry::empty();
    let allowlist = vec![PAST_CHATS_TOOL_ID.to_owned()];
    let hint = turn_memory_usage_hint(&acp_route(), &mcp, Some(&allowlist), true)
        .await
        .expect("past-chat search is allowed");
    assert!(hint.contains(PAST_CHATS_TOOL_ID));
    assert!(!hint.contains(WORKING_MEMORY_TOOL_ID));

    let unrelated = vec!["web_fetch.get".to_owned()];
    assert_eq!(
        turn_memory_usage_hint(&acp_route(), &mcp, Some(&unrelated), true).await,
        None
    );
    assert_eq!(
        turn_memory_usage_hint(&acp_route(), &mcp, Some(&[]), true).await,
        None
    );
    assert_eq!(
        turn_memory_usage_hint(&gateway_route(), &mcp, None, true).await,
        None
    );
    let gateway = turn_memory_usage_hint(&gateway_route(), &mcp, Some(&allowlist), true).await;
    assert_eq!(gateway, Some(hint));
}

fn every_tool_hint() -> String {
    hint_for(&EVERY_ID, true).expect("memory tools are offered")
}

#[test]
fn a_tool_less_leg_takes_the_guide_out_and_keeps_the_rest() {
    let hint = every_tool_hint();
    // As `chat_stream_inner` places it: at the tail of the stable layers…
    let tail = merge_system_prompt(Some(hint.clone()), Some("Persona.".to_owned())).unwrap();
    assert_eq!(system_without_memory_usage_hint(&tail), "Persona.");
    // …ahead of a compaction summary appended later…
    let summarized =
        append_system_suffix(Some(tail), Some("Summary:\n\nearlier turns".to_owned())).unwrap();
    assert_eq!(
        system_without_memory_usage_hint(&summarized),
        "Persona.\n\nSummary:\n\nearlier turns"
    );
    // …or alone, when it is the only layer.
    assert_eq!(system_without_memory_usage_hint(&hint), "");
    let led = format!("{hint}\n\nSummary: x");
    assert_eq!(system_without_memory_usage_hint(&led), "Summary: x");
    assert_eq!(long_term_system_without_memory_usage_hint(Some(hint)), None);
    // A block without the guide is returned untouched.
    let plain = "Persona.\n\n## Memory notes\nfrom the agent's own instructions";
    assert!(matches!(
        system_without_memory_usage_hint(plain),
        std::borrow::Cow::Borrowed(text) if text == plain
    ));
    assert_eq!(long_term_system_without_memory_usage_hint(None), None);
}

#[test]
fn tool_less_messages_lose_only_the_guide() {
    let hint = every_tool_hint();
    let messages = vec![
        serde_json::json!({ "role": "system", "content": format!("Persona.\n\n{hint}") }),
        serde_json::json!({ "role": "user", "content": hint.clone() }),
    ];
    let stripped = messages_without_memory_usage_hint(&messages);
    assert_eq!(stripped[0]["content"], "Persona.");
    // Only system messages are touched: a user may quote anything.
    assert_eq!(stripped[1], messages[1]);
    let only_hint = vec![
        serde_json::json!({ "role": "system", "content": hint }),
        serde_json::json!({ "role": "user", "content": "hi" }),
    ];
    let stripped = messages_without_memory_usage_hint(&only_hint);
    assert_eq!(stripped.len(), 1);
    assert_eq!(stripped[0]["role"], "user");
}

/// A provider that records each request body and answers `200` with no body.
async fn recording_provider() -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let bodies = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let recorded = std::sync::Arc::clone(&bodies);
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut request = Vec::new();
            let mut chunk = [0_u8; 8192];
            let body = loop {
                let read = socket.read(&mut chunk).await.unwrap_or(0);
                if read == 0 {
                    break String::new();
                }
                request.extend_from_slice(&chunk[..read]);
                let text = String::from_utf8_lossy(&request).into_owned();
                let Some(split) = text.find("\r\n\r\n") else {
                    continue;
                };
                let length = text[..split]
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())?
                    })
                    .unwrap_or(0);
                if request.len() >= split + 4 + length {
                    break text[split + 4..].to_owned();
                }
            };
            recorded.lock().unwrap().push(body);
            let _ = socket
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                .await;
        }
    });
    (format!("http://{address}"), bodies)
}

#[tokio::test]
async fn the_fallback_provider_never_receives_the_guide() {
    let hint = every_tool_hint();
    let messages = vec![
        serde_json::json!({ "role": "system", "content": format!("Persona.\n\n{hint}") }),
        serde_json::json!({ "role": "user", "content": "what do you remember?" }),
    ];
    let (fallback_url, bodies) = recording_provider().await;
    let fallback = vec![FallbackProvider {
        base_url: fallback_url,
        model: "local-model".to_owned(),
        api_key: None,
    }];
    let allowlist = vec![MEMORY_SEARCH_TOOL_ID.to_owned()];
    connect_with_fallback(
        &messages,
        "http://127.0.0.1:1",
        "gateway-model",
        None,
        None,
        None,
        None,
        &[],
        &[],
        None,
        &fallback,
        &AgentSlots::default(),
        false,
        false,
        &crate::inference::SamplingConfig::default(),
        crate::inference::Engine::Other,
        &[],
        Some(&allowlist),
        None,
        None,
        None,
        false,
        false,
        StreamHop::Provider,
        None,
    )
    .await
    .expect("the fallback provider answers");
    let bodies = bodies.lock().unwrap();
    let sent: Value = serde_json::from_str(&bodies[0]).expect("JSON request body");
    assert_eq!(sent["messages"][0]["content"], "Persona.");
    assert_eq!(sent["messages"][1]["content"], "what do you remember?");
    assert!(!bodies[0].contains(MEMORY_SEARCH_TOOL_ID), "{}", bodies[0]);
}
