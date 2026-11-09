//! Calendar event titles Core has seen in a conversation, so an approval card
//! for `device.calendar.update` / `device.calendar.delete` can name the event
//! by data the phone returned, never by text the model wrote (design §2.4
//! step 8). Filled from successful `device.calendar.search` results; held in
//! memory only, bounded, and never persisted.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

/// More remembered events than this resets the cache (the card then says the
/// event was not shown in this chat, which is the safe direction).
const MAX_ENTRIES: usize = 4_096;

fn titles() -> &'static Mutex<HashMap<(String, String), String>> {
    static TITLES: OnceLock<Mutex<HashMap<(String, String), String>>> = OnceLock::new();
    TITLES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Remember the `{id, title}` of each event in a search result's `data`.
pub(crate) fn remember(conversation_id: &str, data: &Value) {
    let Some(events) = data.get("events").and_then(Value::as_array) else {
        return;
    };
    let Ok(mut map) = titles().lock() else {
        return;
    };
    for event in events {
        let (Some(id), Some(title)) = (
            event.get("id").and_then(Value::as_str),
            event.get("title").and_then(Value::as_str),
        ) else {
            continue;
        };
        if map.len() >= MAX_ENTRIES {
            map.clear();
        }
        map.insert(
            (conversation_id.to_owned(), id.to_owned()),
            title.to_owned(),
        );
    }
}

/// The title the phone reported for `event_id` in this conversation.
pub(crate) fn title_of(conversation_id: &str, event_id: &str) -> Option<String> {
    titles()
        .lock()
        .ok()?
        .get(&(conversation_id.to_owned(), event_id.to_owned()))
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_come_from_search_results_and_stay_per_conversation() {
        let conversation = format!("conv-titles-{}", uuid::Uuid::new_v4().simple());
        remember(
            &conversation,
            &serde_json::json!({ "events": [
                { "id": "e1", "title": "Dentist" },
                { "id": "e2" },
                { "title": "No id" },
            ]}),
        );
        assert_eq!(title_of(&conversation, "e1").as_deref(), Some("Dentist"));
        assert_eq!(title_of(&conversation, "e2"), None);
        assert_eq!(title_of("another-conversation", "e1"), None);
    }
}
