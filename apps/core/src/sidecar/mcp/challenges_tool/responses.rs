//! Error mapping and the projections of control-plane responses.

use super::*;

/// Map a non-2xx Challenges response to the message the agent relays.
pub(super) fn api_error(status: u16, body: &str, slug: Option<&str>) -> anyhow::Error {
    let message = server_message(body);
    match status {
        401 => anyhow!(SIGN_IN_MESSAGE),
        403 => anyhow!(message.unwrap_or_else(|| {
            "Ryu Challenges refused this request for the signed-in account.".to_owned()
        })),
        404 => match slug {
            Some(slug) => {
                anyhow!("Unknown challenge '{slug}'. Use challenges.list to see open challenges.")
            }
            None => anyhow!("Ryu Challenges is not available on this Ryu server."),
        },
        _ => match message {
            Some(message) => anyhow!("Ryu Challenges request failed ({status}): {message}"),
            None => anyhow!("Ryu Challenges request failed ({status})"),
        },
    }
}

/// The human-readable reason in an error body: the server's `{ "error": … }`
/// envelope, a `message` field, or Hono's plain-text exception body.
pub(super) fn server_message(body: &str) -> Option<String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return None;
    }
    let message = match serde_json::from_str::<Value>(trimmed) {
        Ok(value) => value
            .get("error")
            .or_else(|| value.get("message"))
            .and_then(Value::as_str)
            .map(str::to_owned)?,
        Err(_) if trimmed.starts_with('<') => return None,
        Err(_) => trimmed.to_owned(),
    };
    let message: String = message.chars().take(MAX_ERROR_MESSAGE_CHARS).collect();
    (!message.trim().is_empty()).then_some(message)
}

pub(super) fn pick(source: &Value, keys: &[&str]) -> Value {
    let mut out = Map::new();
    for key in keys {
        if let Some(value) = source.get(*key) {
            out.insert((*key).to_owned(), value.clone());
        }
    }
    Value::Object(out)
}

pub(super) fn list_projection(challenge: &Value) -> Value {
    let mut row = pick(
        challenge,
        &[
            "slug",
            "title",
            "summary",
            "kind",
            "status",
            "startsAt",
            "endsAt",
            "submissionChannel",
            "prizeSummary",
        ],
    );
    row["agentOnly"] =
        json!(challenge.get("submissionChannel").and_then(Value::as_str) == Some("ryu_agent"));
    row
}

pub(super) fn detail_projection(challenge: &Value) -> Value {
    let mut detail = pick(
        challenge,
        &[
            "slug",
            "title",
            "summary",
            "brief",
            "rules",
            "judgingCriteria",
            "prizeSummary",
            "kind",
            "format",
            "status",
            "startsAt",
            "endsAt",
            "timezone",
            "hostName",
            "submissionChannel",
            "participantCount",
            "submissionCount",
        ],
    );
    if let Some(tiers) = challenge.get("prizeTiers").and_then(Value::as_array) {
        detail["prizeTiers"] = Value::Array(tiers.iter().map(prize_tier_projection).collect());
    }
    detail["agentOnly"] =
        json!(challenge.get("submissionChannel").and_then(Value::as_str) == Some("ryu_agent"));
    detail
}

/// One prize tier as the agent may see it. A credit pool id is an internal
/// supplier slot name, so the raw `pool` field is never forwarded; a credits
/// tier is described by the user-facing `description` the API serializes
/// (for example "$50 in Ryu Frontier credits"), or by its amount alone when an
/// older API omits that description.
pub(super) fn prize_tier_projection(tier: &Value) -> Value {
    let mut out = pick(
        tier,
        &[
            "place",
            "label",
            "kind",
            "points",
            "amountMicroUsd",
            "description",
        ],
    );
    let is_credits = tier.get("kind").and_then(Value::as_str) == Some("credits");
    let has_description = tier
        .get("description")
        .and_then(Value::as_str)
        .is_some_and(|text| !text.trim().is_empty());
    if is_credits && !has_description {
        let micro_usd = tier
            .get("amountMicroUsd")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        out["description"] = json!(format!("{} in Ryu credits", format_usd(micro_usd)));
    }
    out
}

pub(super) fn format_usd(micro_usd: u64) -> String {
    let cents = (micro_usd + 5_000) / 10_000;
    let (dollars, rem) = (cents / 100, cents % 100);
    if rem == 0 {
        format!("${dollars}")
    } else {
        format!("${dollars}.{rem:02}")
    }
}

pub(super) fn entry_projection(entry: &Value) -> Value {
    pick(
        entry,
        &[
            "status",
            "registeredAt",
            "submittedAt",
            "projectName",
            "projectUrl",
            "teamName",
            "allowPublicDisplay",
            "reviewNote",
            "awardPlace",
            "awardStatus",
            "prizeLabel",
        ],
    )
}
