use super::*;
use agent_client_protocol::schema::v1::{ImageContent, TextContent};

#[test]
fn prompt_parts_map_text_and_images() {
    let prompt = vec![
        ContentBlock::Text(TextContent::new("hello")),
        ContentBlock::Image(ImageContent::new("QUJD", "image/png")),
    ];
    let (text, parts) = prompt_parts(&prompt).expect("convertible prompt");
    assert_eq!(text, "hello");
    assert_eq!(parts[0], json!({"type":"text","text":"hello"}));
    assert_eq!(parts[1]["url"], json!("data:image/png;base64,QUJD"));
    assert!(prompt_parts(&[]).is_err());
}

#[test]
fn tool_kinds_and_titles_are_descriptive() {
    assert_eq!(tool_kind("Bash"), ToolKind::Execute);
    assert_eq!(tool_kind("Edit"), ToolKind::Edit);
    assert_eq!(tool_kind("Grep"), ToolKind::Search);
    assert_eq!(tool_kind("Read"), ToolKind::Read);
    assert_eq!(tool_kind("mystery"), ToolKind::Other);
    assert_eq!(
        tool_title("Bash", &json!({"command":"ls -la\nmore"})),
        "Bash: ls -la"
    );
    assert_eq!(tool_title("Think", &json!({})), "Think");
}

#[test]
fn first_sight_of_a_tool_output_announces_the_call() {
    let mut translator = Translator::default();
    let updates = translator.translate(CoreEvent::ToolOutput {
        id: "c9".into(),
        output: json!("ok"),
        status: ToolCallStatus::Completed,
    });
    assert_eq!(updates.len(), 2);
    assert!(matches!(updates[0], SessionUpdate::ToolCall(_)));
    assert!(matches!(updates[1], SessionUpdate::ToolCallUpdate(_)));
}
