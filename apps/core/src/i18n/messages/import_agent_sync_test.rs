//! Agent Sync's Cursor scan sends its history notice as plain English text, so
//! the desktop renders it by looking the sentence up in the catalog. These
//! tests keep that sentence identical to the catalogued Core message.

use super::IMPORT_AGENT_SYNC_CURSOR_HISTORY_WARNING_MESSAGE;
use crate::i18n::Message;

const AGENT_SYNC_SOURCE: &str = include_str!("../../server/agent_sync.rs");

fn cursor_notice() -> String {
    crate::import::english(&Message::new(
        IMPORT_AGENT_SYNC_CURSOR_HISTORY_WARNING_MESSAGE,
    ))
}

#[test]
fn cursor_history_notice_is_a_catalogued_import_message() {
    assert!(super::ALL
        .iter()
        .any(|template| { crate::import::english(&Message::new(*template)) == cursor_notice() }));
    let wire = Message::new(IMPORT_AGENT_SYNC_CURSOR_HISTORY_WARNING_MESSAGE).to_wire();
    assert_eq!(
        wire.get("message").and_then(serde_json::Value::as_str),
        Some(cursor_notice().as_str())
    );
}

#[test]
fn agent_sync_cursor_scan_sends_the_catalogued_sentence() {
    // The Cursor branch of the Agent Sync scan pushes this exact text into
    // `SyncScan.warnings`; a drift would leave the warning untranslated.
    let pushed = format!("\"{}\".to_owned()", cursor_notice());
    assert!(
        AGENT_SYNC_SOURCE.contains(&pushed),
        "agent_sync.rs no longer pushes {pushed}"
    );
}
