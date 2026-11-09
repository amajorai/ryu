//! What surfaces other than the model may see of a device call.
//!
//! Card titles are built only from Core-validated structured fields, quoted and
//! truncated (design §2.4 step 8). Display inputs keep titles and times and
//! never carry coordinates, contact fields, notes or free-form locations.
//! Display results are the redacted forms persisted and synced in place of the
//! payload the model receives (design §3.1).

use serde_json::{Map, Value};

use super::catalog::CatalogTool;

const TITLE_MAX: usize = 80;
const QUOTED_MAX: usize = 40;

/// Truncate on a char boundary, appending an ellipsis when cut.
fn truncate(text: &str, max_chars: usize) -> String {
    let clean: String = text.chars().filter(|c| !c.is_control()).collect();
    if clean.chars().count() <= max_chars {
        return clean;
    }
    let mut cut: String = clean.chars().take(max_chars.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

fn quoted(text: &str) -> String {
    format!("“{}”", truncate(text, QUOTED_MAX))
}

fn short_time(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    let time = chrono::DateTime::parse_from_rfc3339(text).ok()?;
    Some(time.format("%a %-d %b %H:%M").to_string())
}

fn field<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

/// The approval card / request summary for one validated call, for an event
/// Core has not seen (tests; dispatch uses [`display_summary_known`]).
#[cfg(test)]
pub(crate) fn display_summary(tool: &CatalogTool, input: &Value, device_label: &str) -> String {
    display_summary_known(tool, input, device_label, None)
}

/// The approval card / request summary for one validated call. An update or
/// delete names its event by the title the phone reported earlier in this
/// conversation (`event_titles`), when Core has seen it; a `device.home.set`
/// names its accessory from the signed Home cache (`home`).
pub(crate) fn display_summary_known(
    tool: &CatalogTool,
    input: &Value,
    device_label: &str,
    known_title: Option<&str>,
) -> String {
    let on_device = format!("on {}", quoted(device_label));
    let time_range = || match (short_time(input.get("start")), short_time(input.get("end"))) {
        (Some(start), Some(end)) => format!(" · {start}–{end}"),
        (Some(start), None) => format!(" · {start}"),
        _ => String::new(),
    };
    let action = match tool.id.as_str() {
        "device.calendar.search" => format!("Read calendar events{}", time_range()),
        "device.calendar.get_notes" => "Read one event's notes".to_owned(),
        "device.calendar.create" => format!(
            "Add event {}{}",
            quoted(field(input, "title").unwrap_or("Untitled")),
            time_range()
        ),
        "device.calendar.update" => {
            let target = known_title.map_or_else(
                || "a calendar event not shown in this chat".to_owned(),
                |title| format!("event {}", quoted(title)),
            );
            let renamed = field(input, "title")
                .map(|title| format!(" to {}", quoted(title)))
                .unwrap_or_default();
            format!("Change {target}{renamed}{}", time_range())
        }
        "device.calendar.delete" => known_title.map_or_else(
            || "Delete a calendar event not shown in this chat".to_owned(),
            |title| format!("Delete event {}", quoted(title)),
        ),
        "device.contacts.search" => "Look up a contact".to_owned(),
        "device.location.current" => {
            if field(input, "accuracy") == Some("precise") {
                "Share precise location".to_owned()
            } else {
                "Share approximate location".to_owned()
            }
        }
        "device.alarm.set" => format!(
            "Set an alarm{}",
            short_time(input.get("at"))
                .map(|at| format!(" for {at}"))
                .unwrap_or_default()
        ),
        "device.timer.set" => format!(
            "Start a {} timer",
            humanize_seconds(
                input
                    .get("duration_seconds")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
            )
        ),
        "device.reminders.list" => "Read reminders".to_owned(),
        "device.reminders.create" => format!(
            "Add reminder {}{}",
            quoted(field(input, "title").unwrap_or("Untitled")),
            short_time(input.get("due"))
                .map(|due| format!(" · due {due}"))
                .unwrap_or_default()
        ),
        "device.reminders.update" => {
            if input.get("completed").and_then(Value::as_bool) == Some(true) {
                "Mark a reminder as done".to_owned()
            } else {
                field(input, "title").map_or_else(
                    || "Change a reminder".to_owned(),
                    |title| format!("Change a reminder to {}", quoted(title)),
                )
            }
        }
        "device.reminders.delete" => "Delete a reminder".to_owned(),
        "device.home.list" => "Read Home accessories".to_owned(),
        // The accessory is named only from Core's signed cache (`home`).
        "device.home.set" => known_title.map_or_else(
            || "Change a Home accessory".to_owned(),
            |name| format!("Change Home accessory {}", quoted(name)),
        ),
        other => format!("Run {other}"),
    };
    truncate(&format!("{action} · {on_device}"), TITLE_MAX)
}

fn humanize_seconds(seconds: u64) -> String {
    match seconds {
        s if s >= 3600 && s % 3600 == 0 => format!("{} h", s / 3600),
        s if s >= 60 && s % 60 == 0 => format!("{} min", s / 60),
        s => format!("{s} s"),
    }
}

/// The input other surfaces render in the `tool-input-available` part.
pub(crate) fn redact_input_for_display(tool: &CatalogTool, input: &Value) -> Value {
    const KEEP: &[&str] = &[
        "title",
        "start",
        "end",
        "all_day",
        "at",
        "duration_seconds",
        "label",
        "accuracy",
        "limit",
        "fields",
        "due",
        "completed",
    ];
    let mut out = Map::new();
    if let Some(map) = input.as_object() {
        for key in KEEP {
            if let Some(value) = map.get(*key) {
                let value = match value {
                    Value::String(text) => Value::String(truncate(text, TITLE_MAX)),
                    other => other.clone(),
                };
                out.insert((*key).to_owned(), value);
            }
        }
    }
    out.insert("tool".to_owned(), Value::String(tool.id.clone()));
    Value::Object(out)
}

/// The redacted result persisted and shown on every surface; the model alone
/// receives the full `data`.
pub(crate) fn redact_result_for_display(tool: &CatalogTool, result: &Value) -> Value {
    if result.get("ok").and_then(Value::as_bool) != Some(true) {
        return serde_json::json!({
            "ok": false,
            "code": result.get("code").and_then(Value::as_str).unwrap_or("os_error"),
        });
    }
    let data = result.get("data").unwrap_or(&Value::Null);
    let summary = match tool.id.as_str() {
        "device.location.current" => {
            let precise = data.get("approximate").and_then(Value::as_bool) == Some(false);
            serde_json::json!({
                "summary": if precise { "Location shared (precise)" } else { "Location shared (approximate)" }
            })
        }
        "device.contacts.search" => {
            let names: Vec<Value> = list(data, "contacts")
                .filter_map(|contact| contact.get("name").and_then(Value::as_str))
                .map(|name| Value::String(truncate(name, QUOTED_MAX)))
                .collect();
            serde_json::json!({ "contacts": names })
        }
        "device.calendar.search" | "device.reminders.list" => {
            let key = if tool.id == "device.calendar.search" {
                "events"
            } else {
                "reminders"
            };
            let titles: Vec<Value> = list(data, key)
                .filter_map(|item| item.get("title").and_then(Value::as_str))
                .map(|title| Value::String(truncate(title, QUOTED_MAX)))
                .collect();
            serde_json::json!({ "count": titles.len(), "titles": titles })
        }
        "device.calendar.get_notes" => serde_json::json!({ "summary": "Event notes read" }),
        // Home names, rooms and accessory states stay with the model.
        "device.home.list" => serde_json::json!({
            "summary": "Home accessories read",
            "count": list(data, "homes")
                .map(|home| list(home, "accessories").count())
                .sum::<usize>(),
        }),
        _ => serde_json::json!({ "summary": "Done" }),
    };
    serde_json::json!({ "ok": true, "display": summary })
}

fn list<'a>(data: &'a Value, key: &str) -> impl Iterator<Item = &'a Value> {
    data.get(key)
        .and_then(Value::as_array)
        .map(|items| items.iter())
        .into_iter()
        .flatten()
}
