//! Parsing and bounds of the tool arguments.

use super::*;

// ── Input validation ────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ListInput {
    pub(super) status: ListStatus,
    pub(super) kind: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ListStatus {
    Open,
    Live,
    Upcoming,
}

impl ListInput {
    pub(super) fn parse(arguments: &Value) -> Result<Self> {
        let object = object_arguments(arguments)?;
        reject_unknown_keys(object, &["status", "kind"])?;
        let status = match optional_str(object, "status")? {
            None | Some("open") => ListStatus::Open,
            Some("live") => ListStatus::Live,
            Some("upcoming") => ListStatus::Upcoming,
            Some(other) => {
                return Err(anyhow!(
                    "challenges.list 'status' must be open, live, or upcoming (got '{other}')"
                ))
            }
        };
        let kind = match optional_str(object, "kind")? {
            None => None,
            Some(kind @ ("challenge" | "hackathon" | "event")) => Some(kind.to_owned()),
            Some(other) => {
                return Err(anyhow!(
                    "challenges.list 'kind' must be challenge, hackathon, or event (got '{other}')"
                ))
            }
        };
        Ok(Self { status, kind })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SubmitInput {
    pub(super) slug: String,
    pub(super) project_name: String,
    pub(super) project_url: String,
    pub(super) pitch: String,
    pub(super) allow_public_display: bool,
    pub(super) team_name: Option<String>,
}

impl SubmitInput {
    pub(super) fn parse(arguments: &Value) -> Result<Self> {
        let object = object_arguments(arguments)?;
        reject_unknown_keys(
            object,
            &[
                "slug",
                "projectName",
                "projectUrl",
                "pitch",
                "allowPublicDisplay",
                "teamName",
            ],
        )?;
        let slug = required_slug(object)?;
        let project_name = bounded_text(
            object,
            "projectName",
            MIN_PROJECT_NAME_CHARS,
            MAX_PROJECT_NAME_CHARS,
        )?;
        let project_url = bounded_text(object, "projectUrl", 1, MAX_PROJECT_URL_CHARS)?;
        validate_http_url(&project_url)?;
        let pitch = bounded_text(object, "pitch", MIN_PITCH_CHARS, MAX_PITCH_CHARS)?;
        let allow_public_display = object
            .get("allowPublicDisplay")
            .and_then(Value::as_bool)
            .ok_or_else(|| anyhow!("challenges.submit requires a boolean 'allowPublicDisplay'"))?;
        let team_name = match optional_str(object, "teamName")? {
            None => None,
            Some(raw) => {
                let trimmed = raw.trim();
                if trimmed.chars().count() > MAX_TEAM_NAME_CHARS {
                    return Err(anyhow!(
                        "challenges.submit 'teamName' must be at most {MAX_TEAM_NAME_CHARS} characters"
                    ));
                }
                (!trimmed.is_empty()).then(|| trimmed.to_owned())
            }
        };
        Ok(Self {
            slug,
            project_name,
            project_url,
            pitch,
            allow_public_display,
            team_name,
        })
    }

    /// The exact `PUT /:slug/entry` body (the server's strict submission schema).
    pub(super) fn entry_body(&self) -> Value {
        let mut body = json!({
            "projectName": self.project_name,
            "projectUrl": self.project_url,
            "pitch": self.pitch,
            "allowPublicDisplay": self.allow_public_display,
        });
        if let Some(team) = &self.team_name {
            body["teamName"] = Value::String(team.clone());
        }
        body
    }
}

pub(super) fn object_arguments(arguments: &Value) -> Result<&Map<String, Value>> {
    arguments
        .as_object()
        .ok_or_else(|| anyhow!("challenges tool arguments must be a JSON object"))
}

pub(super) fn reject_unknown_keys(object: &Map<String, Value>, allowed: &[&str]) -> Result<()> {
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(anyhow!("unknown challenges tool argument '{key}'"));
    }
    Ok(())
}

pub(super) fn optional_str<'a>(
    object: &'a Map<String, Value>,
    key: &str,
) -> Result<Option<&'a str>> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_str()
            .map(Some)
            .ok_or_else(|| anyhow!("challenges tool argument '{key}' must be a string")),
    }
}

pub(super) fn required_slug(object: &Map<String, Value>) -> Result<String> {
    let slug = object
        .get("slug")
        .and_then(Value::as_str)
        .map(str::trim)
        .ok_or_else(|| anyhow!("a string 'slug' is required"))?;
    let valid = !slug.is_empty()
        && slug.len() <= MAX_SLUG_CHARS
        && slug
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && !slug.starts_with('-');
    if !valid {
        return Err(anyhow!(
            "'slug' must be a challenge slug from challenges.list (lowercase letters, digits, and hyphens)"
        ));
    }
    Ok(slug.to_owned())
}

pub(super) fn bounded_text(
    object: &Map<String, Value>,
    key: &str,
    min: usize,
    max: usize,
) -> Result<String> {
    let value = object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("challenges.submit requires a string '{key}'"))?
        .trim();
    let length = value.chars().count();
    if length < min || length > max {
        return Err(anyhow!(
            "challenges.submit '{key}' must be {min}–{max} characters (got {length})"
        ));
    }
    Ok(value.to_owned())
}

pub(super) fn validate_http_url(raw: &str) -> Result<()> {
    let parsed = url::Url::parse(raw)
        .map_err(|_| anyhow!("challenges.submit 'projectUrl' must be a valid http(s) URL"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(anyhow!(
            "challenges.submit 'projectUrl' must use http or https (got '{}')",
            parsed.scheme()
        ));
    }
    Ok(())
}
