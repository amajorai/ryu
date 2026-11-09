//! Parsing the profile reply and its agent suggestions.

use super::*;

#[test]
fn profile_reply_extracts_and_sanitizes_agent_suggestions() {
    let reply = r#"## What I found

You repeat release checks across several recent sessions.

<!-- RYU_AGENT_SUGGESTIONS_JSON
{"agent_suggestions":[
  {"name":"Release Desk","title":"Release engineer","description":"Keeps release checks together.","reason":"Release verification appeared repeatedly in recent sessions.","system_prompt":"Help me verify releases with a short evidence-backed checklist. Ask before any external change.","tools":["search_conversations.search","web.search","not-a-real-tool","web.search"]},
  {"name":"Release Desk","system_prompt":"duplicate should be ignored","tools":["memory.search"]},
  {"name":"No Prompt","tools":["memory.search"]}
]}
-->"#;

    let (profile, suggestions) = parse_profile_reply(reply);
    assert!(profile.contains("release checks"));
    assert!(!profile.contains("RYU_AGENT_SUGGESTIONS_JSON"));
    assert_eq!(suggestions.len(), 1);
    assert_eq!(suggestions[0].id, "agent-suggestion-release-desk");
    assert_eq!(
        suggestions[0].tools,
        vec!["search_conversations.search", "web.search"]
    );
}

#[test]
fn profile_reply_accepts_strict_json_and_defaults_empty_tools() {
    let reply = r#"{"profile":"Frequent inbox triage.","agent_suggestions":[{"name":"Inbox Triage","system_prompt":"Summarize my inbox and ask before sending anything.","tools":["shell.exec"]}]}"#;

    let (profile, suggestions) = parse_profile_reply(reply);
    assert_eq!(profile, "Frequent inbox triage.");
    assert_eq!(suggestions.len(), 1);
    assert_eq!(suggestions[0].tools, vec!["search_conversations.search"]);
}
