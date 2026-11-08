//! Per-slot model listings for own-supply discovery: the HTTP fetch and the
//! parsers that turn each vendor's listing into [`ListedModel`] rows.

use serde_json::Value;

use super::{
    status_line, ListedModel, Listing, SlotAccess, LIST_TIMEOUT, MAX_BODY_BYTES, MAX_PAGES,
};

pub(super) async fn get_json(request: reqwest::RequestBuilder) -> Result<Value, String> {
    let response = request
        .timeout(LIST_TIMEOUT)
        .send()
        .await
        .map_err(|error| status_line(&format!("request failed: {error}")))?;
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|len| len as usize > MAX_BODY_BYTES)
    {
        return Err("listing too large".to_owned());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| status_line(&format!("read failed: {error}")))?;
    if bytes.len() > MAX_BODY_BYTES {
        return Err("listing too large".to_owned());
    }
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    serde_json::from_slice(&bytes).map_err(|_| "invalid JSON".to_owned())
}

/// OpenAI chat models only: `gpt-*`, `o<digit>*`, `chatgpt-*`, minus audio,
/// realtime, speech, search, embedding, image and moderation models.
pub fn is_openai_chat_model(id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    let family = id.starts_with("gpt-")
        || id.starts_with("chatgpt-")
        || (id.starts_with('o') && id.chars().nth(1).is_some_and(|c| c.is_ascii_digit()));
    family
        && ![
            "audio",
            "realtime",
            "tts",
            "transcribe",
            "search",
            "embedding",
            "image",
            "moderation",
        ]
        .iter()
        .any(|word| id.contains(word))
}

pub fn openai_models(body: &Value) -> Vec<ListedModel> {
    body["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|model| model["id"].as_str())
        .filter(|id| is_openai_chat_model(id))
        .map(|id| ListedModel {
            id: id.to_owned(),
            display_name: None,
            evidence_ids: Vec::new(),
        })
        .collect()
}

/// `claude-sonnet-4-5-20250929` → `claude-sonnet-4-5`.
pub fn anthropic_alias(id: &str) -> &str {
    match id.rsplit_once('-') {
        Some((head, date)) if date.len() == 8 && date.chars().all(|c| c.is_ascii_digit()) => head,
        _ => id,
    }
}

/// Group Anthropic's dated listing under the undated aliases a request names;
/// the dated ids are kept as evidence.
pub fn anthropic_models(pages: &[Value]) -> Vec<ListedModel> {
    let mut grouped: Vec<ListedModel> = Vec::new();
    for page in pages {
        for model in page["data"].as_array().into_iter().flatten() {
            let Some(id) = model["id"].as_str() else {
                continue;
            };
            let alias = anthropic_alias(id);
            let display = model["display_name"].as_str().map(str::to_owned);
            match grouped.iter_mut().find(|entry| entry.id == alias) {
                Some(entry) => {
                    if id != alias {
                        entry.evidence_ids.push(id.to_owned());
                    }
                }
                None => grouped.push(ListedModel {
                    id: alias.to_owned(),
                    display_name: display,
                    evidence_ids: if id == alias {
                        Vec::new()
                    } else {
                        vec![id.to_owned()]
                    },
                }),
            }
        }
    }
    grouped
}

/// Cloudflare's model-search URL for the account in a Workers AI base URL
/// (`…/accounts/{id}/ai/v1` → `…/accounts/{id}/ai/models/search`).
pub fn cloudflare_search_url(base_url: &str) -> Option<String> {
    let trimmed = base_url.trim_end_matches('/');
    if !trimmed.contains("/accounts/") {
        return None;
    }
    let ai = trimmed.rfind("/ai")?;
    Some(format!("{}/ai/models/search", &trimmed[..ai]))
}

pub fn cloudflare_models(page: &Value) -> Vec<ListedModel> {
    page["result"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|model| model["name"].as_str())
        .map(|name| ListedModel {
            id: name.to_owned(),
            display_name: None,
            evidence_ids: Vec::new(),
        })
        .collect()
}

/// Bedrock Mantle's model list for the `/anthropic` base URL Ryu dispatches on.
pub fn bedrock_models_url(base_url: &str) -> Option<String> {
    let trimmed = base_url.trim_end_matches('/');
    trimmed
        .strip_suffix("/anthropic")
        .map(|origin| format!("{origin}/v1/models"))
}

/// `https://bedrock-mantle.us-east-1.api.aws/…` → `us-east-1`.
pub fn bedrock_region(base_url: &str) -> Option<String> {
    let host = reqwest::Url::parse(base_url).ok()?.host_str()?.to_owned();
    let rest = host.strip_prefix("bedrock-mantle.")?;
    rest.split('.').next().map(str::to_owned)
}

/// List one slot's models.
pub async fn list_models(http: &reqwest::Client, access: &SlotAccess) -> Listing {
    use crate::config::{
        ANTHROPIC_CREDITS_PROVIDER_ID, AZURE_CREDITS_PROVIDER_ID, BEDROCK_PROVIDER_ID,
        CLOUDFLARE_PROVIDER_ID, OPENAI_CREDITS_PROVIDER_ID,
    };
    let base = access.base_url.trim_end_matches('/');
    match access.slot {
        // Azure's v1 surface serves the same `/models` listing shape with the
        // resource key as a bearer token. It lists what the resource can
        // deploy, which is a suggestion; the canary proves a published row.
        OPENAI_CREDITS_PROVIDER_ID | AZURE_CREDITS_PROVIDER_ID => {
            match get_json(
                http.get(format!("{base}/models"))
                    .bearer_auth(&access.api_key),
            )
            .await
            {
                Ok(body) => Listing::Ok(openai_models(&body)),
                Err(error) => Listing::Error(error),
            }
        }
        ANTHROPIC_CREDITS_PROVIDER_ID => {
            let mut pages = Vec::new();
            let mut after: Option<String> = None;
            for _ in 0..MAX_PAGES {
                let mut url = format!("{base}/v1/models?limit=1000");
                if let Some(after) = &after {
                    url.push_str(&format!("&after_id={after}"));
                }
                let page = match get_json(
                    http.get(url)
                        .header("x-api-key", &access.api_key)
                        .header("anthropic-version", "2023-06-01"),
                )
                .await
                {
                    Ok(page) => page,
                    Err(error) => return Listing::Error(error),
                };
                let more = page["has_more"].as_bool().unwrap_or(false);
                after = page["last_id"].as_str().map(str::to_owned);
                pages.push(page);
                if !more || after.is_none() {
                    break;
                }
            }
            Listing::Ok(anthropic_models(&pages))
        }
        CLOUDFLARE_PROVIDER_ID => {
            let Some(search) = cloudflare_search_url(base) else {
                return Listing::Unsupported;
            };
            let mut models = Vec::new();
            for page in 1..=MAX_PAGES {
                let url = format!(
                    "{search}?task=Text%20Generation&hide_experimental=true&per_page=100&page={page}"
                );
                let body = match get_json(http.get(url).bearer_auth(&access.api_key)).await {
                    Ok(body) => body,
                    Err(error) => return Listing::Error(error),
                };
                if body["success"].as_bool() == Some(false) {
                    return Listing::Error("listing refused".to_owned());
                }
                let found = cloudflare_models(&body);
                let total = body["result_info"]["total_count"].as_u64();
                let done =
                    found.len() < 100 || total.is_some_and(|total| (page as u64) * 100 >= total);
                models.extend(found);
                if done {
                    break;
                }
            }
            Listing::Ok(models)
        }
        BEDROCK_PROVIDER_ID => {
            let Some(url) = bedrock_models_url(base) else {
                return Listing::Unsupported;
            };
            match get_json(http.get(url).bearer_auth(&access.api_key)).await {
                Ok(body) => Listing::Ok(
                    body["data"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|model| model["id"].as_str())
                        .map(|id| ListedModel {
                            id: id.to_owned(),
                            display_name: None,
                            evidence_ids: Vec::new(),
                        })
                        .collect(),
                ),
                Err(error) => Listing::Error(error),
            }
        }
        // Vertex: the OpenAI-compatible surface has no `/models`; phase 2 lists
        // publisher models with a service-account credential. Until then the
        // control plane proposes identity matches and the canary verifies them.
        _ => Listing::Unsupported,
    }
}
