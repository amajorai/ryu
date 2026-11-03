//! Localized `setMyCommands` bodies and the guest reply card's title.

use super::*;

const GOAL: &str = "Pursue a goal until a judge model says it is met. Use '/goal clear' to stop.";

fn command(name: &str, description: &str) -> ChannelCommand {
    ChannelCommand {
        name: name.to_owned(),
        description: description.to_owned(),
        source: "plugin".to_owned(),
    }
}

#[test]
fn every_catalog_language_gets_its_own_menu() {
    let cmds = [
        command("goal", GOAL),
        command("mine", "A third-party command"),
    ];
    let payloads = localized_commands_payloads(&cmds);
    let codes: Vec<&str> = payloads.iter().map(|(code, _)| code.as_str()).collect();
    assert_eq!(
        codes,
        ["ar", "de", "es", "fr", "hi", "it", "ja", "ko", "pt", "ru", "zh"]
    );
    let (_, japanese) = payloads.iter().find(|(code, _)| code == "ja").unwrap();
    assert_eq!(japanese["language_code"], "ja");
    let list = japanese["commands"].as_array().unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0]["command"], "goal");
    assert_ne!(list[0]["description"], GOAL);
    // Not in the catalog: still listed, in English.
    assert_eq!(list[1]["description"], "A third-party command");
    let (_, portuguese) = payloads.iter().find(|(code, _)| code == "pt").unwrap();
    assert_eq!(portuguese["language_code"], "pt");
    // The default payload has no language_code.
    assert!(commands_payload(&cmds).get("language_code").is_none());
}

#[test]
fn the_guest_reply_title_follows_the_guest_language() {
    let english = guest_reply_payload("payloads-test-no-language", "hi");
    assert_eq!(english["result"]["title"], "Ryu reply");

    let message: Message = serde_json::from_value(json!({
        "chat": { "id": 7, "type": "private" },
        "from": { "id": 42, "first_name": "Ana", "language_code": "ja" },
        "guest_query_id": "payloads-test-ja",
        "text": "hello",
    }))
    .unwrap();
    let inbound = guest_inbound(&message).unwrap();
    assert_eq!(inbound.locale.as_deref(), Some("ja"));
    let japanese = guest_reply_payload("payloads-test-ja", "answer");
    let title = japanese["result"]["title"].as_str().unwrap();
    assert!(!title.is_empty());
    assert_ne!(title, "Ryu reply");
    // Read once: a second answer to the same query id falls back to English.
    let again = guest_reply_payload("payloads-test-ja", "answer");
    assert_eq!(again["result"]["title"], "Ryu reply");
}
