//! "Agent finished" pushes to the conversation owner's phones.
//!
//! The mobile app's own "finished" alert is a local notification, so it only
//! fires while the app is still running in the background. This loop covers the
//! rest: when a conversation run goes from `running` to `completed` or `failed`,
//! Core pushes to the owner's devices that opted in (the mobile **Finished
//! alerts** setting, recorded when the device registers its push token).
//!
//! Like other chat apps, the push is from the agent: its display name is the
//! title and its avatar is the picture. Android shows the picture as the large
//! icon; the iOS notification service extension downloads it and turns the push
//! into a communication notification with the avatar in place of the app icon.
//! The body never carries conversation content (titles are sealed at rest and
//! pushes travel through Expo and the platform push services).

use std::collections::HashSet;

use crate::agents::PersonaSlot;
use crate::server::conversations::ConversationSummary;
use crate::server::ServerState;

/// Android channel the mobile app creates for "agent finished" alerts.
pub const AGENT_DONE_CHANNEL: &str = "agent-done";
/// Bound on runs tracked as in flight, so a pathological stream cannot grow it.
const MAX_TRACKED_RUNS: usize = 4096;
/// Twemoji release the emoji avatar PNGs are served from (MIT/CC-BY assets).
const TWEMOJI_BASE: &str = "https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72";
const DICEBEAR_BASE: &str = "https://api.dicebear.com/9.x";
const AVATAR_SIZE: u32 = 192;
/// Same swatches and hash the desktop uses for monogram avatars.
const MONOGRAM_COLORS: [&str; 9] = [
    "ef4444", "f97316", "f59e0b", "22c55e", "14b8a6", "3b82f6", "6366f1", "a855f7", "ec4899",
];

/// Who a push is from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushSender {
    pub id: String,
    pub image_url: String,
    pub name: String,
}

fn monogram_color(seed: &str) -> &'static str {
    let mut hash: u64 = 0;
    for ch in seed.chars() {
        hash = (hash * 31 + u64::from(u32::from(ch))) % 2_147_483_647;
    }
    MONOGRAM_COLORS[(hash % MONOGRAM_COLORS.len() as u64) as usize]
}

/// Hex fill for a dither palette name (mirrors `dither-kit/palette.ts`).
fn dither_hex(name: &str) -> Option<&'static str> {
    Some(match name {
        "green" => "28d26e",
        "blue" => "358ff3",
        "purple" => "966eff",
        "pink" => "f05abe",
        "orange" => "ff9632",
        "red" => "f04646",
        "grey" => "5c5c64",
        _ => return None,
    })
}

fn hex_color(value: &str) -> Option<String> {
    let hex = value.strip_prefix('#')?;
    (hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit())).then(|| hex.to_lowercase())
}

/// Twemoji file name: lowercase code points joined by `-`, dropping the
/// variation selector unless the sequence is a ZWJ sequence.
fn twemoji_code(emoji: &str) -> Option<String> {
    let points: Vec<u32> = emoji.trim().chars().map(u32::from).collect();
    if points.is_empty() || points.len() > 16 {
        return None;
    }
    let zwj = points.contains(&0x200d);
    let code = points
        .iter()
        .filter(|&&p| zwj || p != 0xfe0f)
        .map(|p| format!("{p:x}"))
        .collect::<Vec<_>>()
        .join("-");
    Some(code)
}

fn is_dicebear_style(style: &str) -> bool {
    !style.is_empty()
        && style.len() <= 40
        && style.chars().all(|c| c.is_ascii_lowercase() || c == '-')
}

fn query(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(key, value)| format!("{key}={}", urlencoding::encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

/// A publicly fetchable picture for an agent, in the order the apps render
/// avatars: uploaded https image, DiceBear, emoji (Twemoji), then an initial on
/// the avatar's colour for icon, expressive, dither and default avatars. Only
/// the agent's first letter is sent to the initials service.
pub fn sender_image_url(agent_id: &str, name: &str, persona: Option<&PersonaSlot>) -> String {
    let persona = persona.cloned().unwrap_or_default();
    if let Some(url) = persona
        .avatar_url
        .as_deref()
        .filter(|url| url.starts_with("https://"))
    {
        return url.to_owned();
    }
    if let Some(dicebear) = &persona.dicebear {
        if let (Some(style), Some(seed)) = (dicebear.style.as_deref(), dicebear.seed.as_deref()) {
            if is_dicebear_style(style) && !seed.is_empty() {
                let seed: String = seed.chars().take(256).collect();
                let size = AVATAR_SIZE.to_string();
                return format!(
                    "{DICEBEAR_BASE}/{style}/png?{}",
                    query(&[("seed", &seed), ("size", &size)])
                );
            }
        }
    }
    if let Some(code) = persona.emoji.as_deref().and_then(twemoji_code) {
        return format!("{TWEMOJI_BASE}/{code}.png");
    }
    let background = persona
        .icon_color
        .as_deref()
        .and_then(hex_color)
        .or_else(|| {
            persona
                .dither
                .as_ref()
                .and_then(|d| d.from.as_deref())
                .and_then(dither_hex)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| {
            monogram_color(if agent_id.is_empty() { name } else { agent_id }).to_owned()
        });
    let initial: String = name
        .trim()
        .chars()
        .next()
        .map(|c| c.to_uppercase().collect())
        .unwrap_or_else(|| "R".to_owned());
    let size = AVATAR_SIZE.to_string();
    format!(
        "{DICEBEAR_BASE}/initials/png?{}",
        query(&[
            ("seed", &initial),
            ("size", &size),
            ("backgroundColor", &background),
        ])
    )
}

/// The push for a finished run. Pure, so the payload is unit-tested.
pub fn run_finished_push(
    run: &ConversationSummary,
    sender: &PushSender,
) -> (String, String, serde_json::Value) {
    let failed = run.run_status.as_deref() == Some("failed");
    let body = if failed {
        "The run failed. Tap to see what happened."
    } else {
        "Finished replying. Tap to read it."
    };
    let data = serde_json::json!({
        "kind": "agent-done",
        "conversationId": run.id,
        "agentId": sender.id,
        "status": if failed { "failed" } else { "completed" },
        "sender": {
            "id": sender.id,
            "name": sender.name,
            "image": sender.image_url,
        },
    });
    (sender.name.clone(), body.to_owned(), data)
}

async fn resolve_sender(state: &ServerState, agent_id: Option<&str>) -> PushSender {
    let Some(agent_id) = agent_id.filter(|id| !id.is_empty()) else {
        return PushSender {
            id: "ryu".to_owned(),
            image_url: sender_image_url("ryu", "Ryu", None),
            name: "Ryu".to_owned(),
        };
    };
    if let Ok(Some(record)) = state.agent_store.get(agent_id).await {
        let name = record
            .persona
            .as_ref()
            .and_then(|p| p.display_name.clone())
            .filter(|n| !n.trim().is_empty())
            .unwrap_or(record.name);
        return PushSender {
            id: agent_id.to_owned(),
            image_url: sender_image_url(agent_id, &name, record.persona.as_ref()),
            name,
        };
    }
    let name = state
        .agents
        .find_exact(agent_id)
        .map(|entry| entry.name.clone())
        .unwrap_or_else(|| agent_id.to_owned());
    PushSender {
        id: agent_id.to_owned(),
        image_url: sender_image_url(agent_id, &name, None),
        name,
    }
}

async fn push_run_finished(state: ServerState, run: ConversationSummary) {
    let Some(store) = super::global_store() else {
        return;
    };
    let owner = match state.conversations.get_access_meta(&run.id).await {
        Ok(Some(meta)) => meta.owner_user_id,
        Ok(None) => return,
        Err(e) => {
            tracing::warn!("notify: run push could not read conversation owner: {e:#}");
            return;
        }
    };
    let tokens = match store.run_finished_push_tokens(owner.as_deref()).await {
        Ok(tokens) if !tokens.is_empty() => tokens,
        Ok(_) => return,
        Err(e) => {
            tracing::warn!("notify: run push could not read push tokens: {e:#}");
            return;
        }
    };
    let sender = resolve_sender(&state, run.agent_id.as_deref()).await;
    let (title, body, data) = run_finished_push(&run, &sender);
    ryu_notify::push_expo_rich_message(
        &state.client,
        &tokens,
        &title,
        &body,
        data,
        ryu_notify::ExpoRichContent {
            channel_id: Some(AGENT_DONE_CHANNEL),
            image_url: Some(&sender.image_url),
            thread_id: Some(&run.id),
        },
    )
    .await;
}

/// Subscribe to the run-status bus and push each finished run to its owner's
/// opted-in devices. Fail-open: a lagged bus only drops pushes. Spawned once
/// from `main.rs`.
pub fn spawn(state: ServerState) {
    tokio::spawn(async move {
        let mut rx = crate::server::conversations::subscribe_run_events();
        let mut running: HashSet<String> = HashSet::new();
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let id = event.run.id.clone();
                    match event.run.run_status.as_deref() {
                        Some("running") => {
                            if running.len() < MAX_TRACKED_RUNS {
                                running.insert(id);
                            }
                        }
                        Some("completed" | "failed") => {
                            if running.remove(&id) {
                                let state = state.clone();
                                tokio::spawn(push_run_finished(state, event.run));
                            }
                        }
                        _ => {
                            running.remove(&id);
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!("notify: run push lagged {n} run events");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::{DicebearSpec, DitherSpec};

    #[test]
    fn uploaded_https_avatar_wins_and_data_urls_are_not_pushed() {
        let persona = PersonaSlot {
            avatar_url: Some("https://cdn.example.com/nova.png".into()),
            emoji: Some("🦊".into()),
            ..Default::default()
        };
        assert_eq!(
            sender_image_url("nova", "Nova", Some(&persona)),
            "https://cdn.example.com/nova.png"
        );
        let inline = PersonaSlot {
            avatar_url: Some("data:image/png;base64,AAAA".into()),
            emoji: Some("🦊".into()),
            ..Default::default()
        };
        assert_eq!(
            sender_image_url("nova", "Nova", Some(&inline)),
            format!("{TWEMOJI_BASE}/1f98a.png")
        );
    }

    #[test]
    fn dicebear_uses_the_png_endpoint_with_a_safe_style() {
        let persona = PersonaSlot {
            dicebear: Some(DicebearSpec {
                style: Some("notionists".into()),
                seed: Some("nova sky".into()),
            }),
            ..Default::default()
        };
        assert_eq!(
            sender_image_url("nova", "Nova", Some(&persona)),
            format!("{DICEBEAR_BASE}/notionists/png?seed=nova%20sky&size=192")
        );
        let hostile = PersonaSlot {
            dicebear: Some(DicebearSpec {
                style: Some("../../x".into()),
                seed: Some("s".into()),
            }),
            ..Default::default()
        };
        assert!(sender_image_url("nova", "Nova", Some(&hostile)).contains("/initials/png?"));
    }

    #[test]
    fn emoji_maps_to_twemoji_file_names() {
        assert_eq!(twemoji_code("🦊").as_deref(), Some("1f98a"));
        // Variation selector dropped outside ZWJ sequences.
        assert_eq!(twemoji_code("❤️").as_deref(), Some("2764"));
        // Kept inside one.
        assert_eq!(twemoji_code("🏳️‍🌈").as_deref(), Some("1f3f3-fe0f-200d-1f308"));
        assert_eq!(twemoji_code(""), None);
    }

    #[test]
    fn icon_and_dither_avatars_become_an_initial_on_their_colour() {
        let icon = PersonaSlot {
            icon: Some("hugeicons:robot-01".into()),
            icon_color: Some("#3B82F6".into()),
            ..Default::default()
        };
        assert_eq!(
            sender_image_url("nova", "nova", Some(&icon)),
            format!("{DICEBEAR_BASE}/initials/png?seed=N&size=192&backgroundColor=3b82f6")
        );
        let dither = PersonaSlot {
            dither: Some(DitherSpec {
                from: Some("purple".into()),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert!(sender_image_url("atlas", "Atlas", Some(&dither))
            .ends_with("seed=A&size=192&backgroundColor=966eff"));
        // No persona: a stable colour from the agent id.
        let first = sender_image_url("claude", "Claude", None);
        assert_eq!(first, sender_image_url("claude", "Claude", None));
        assert!(first.contains("seed=C&"));
    }

    #[test]
    fn push_carries_the_sender_but_no_conversation_content() {
        let summary = |status: &str| -> ConversationSummary {
            serde_json::from_value(serde_json::json!({
                "id": "conv-1",
                "title": "Quarterly numbers",
                "agent_id": "nova",
                "created_at": 0,
                "updated_at": 0,
                "message_count": 2,
                "run_status": status,
            }))
            .expect("summary")
        };
        let run = summary("completed");
        let sender = PushSender {
            id: "nova".into(),
            image_url: "https://img/nova.png".into(),
            name: "Nova".into(),
        };
        let (title, body, data) = run_finished_push(&run, &sender);
        assert_eq!(title, "Nova");
        assert!(!body.contains("Quarterly"));
        assert_eq!(data["kind"], "agent-done");
        assert_eq!(data["conversationId"], "conv-1");
        assert_eq!(data["sender"]["image"], "https://img/nova.png");
        assert_eq!(data["status"], "completed");

        let (_, body, data) = run_finished_push(&summary("failed"), &sender);
        assert!(body.contains("failed"));
        assert_eq!(data["status"], "failed");
    }
}
