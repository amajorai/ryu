//! The control plane's enforcement-ladder wire format.

use super::*;

// ─── Wire ──────────────────────────────────────────────────────────────────

/// Which subject a ladder entry names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LadderScope {
    Org,
    Credential,
    User,
    /// A tenant's end user (spec 04.3). Parsed so one flagged end user never
    /// fails the whole key, but not enforced from resolve: the resolve names
    /// the key, not the end user a request carries.
    EndUser,
    /// A trusted forwarder's user. Parsed and not enforced from resolve, as
    /// for [`Self::EndUser`].
    ForwardedUser,
}

impl LadderScope {
    pub(super) const fn as_str(self) -> &'static str {
        match self {
            Self::Org => "org",
            Self::Credential => "credential",
            Self::User => "user",
            Self::EndUser => "end_user",
            Self::ForwardedUser => "forwarded_user",
        }
    }

    /// Whether this Gateway applies entries of this scope from resolve.
    pub(super) const fn enforced_from_resolve(self) -> bool {
        matches!(self, Self::Org | Self::Credential | Self::User)
    }
}

/// One subject's ladder level as the control plane sent it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LadderEntry {
    pub scope: LadderScope,
    /// The subject's id. `None` names the resolved org or credential.
    pub subject_id: Option<String>,
    /// 0 to 3. Levels 4 and 5 are refusals and travel as a `state`.
    pub level: u8,
    pub rpm: Option<u64>,
    pub concurrency: Option<u32>,
    pub reason_class: Option<String>,
    pub until: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WireEntry {
    pub(super) scope: LadderScope,
    #[serde(default)]
    pub(super) subject_id: Option<String>,
    pub(super) level: u8,
    #[serde(default)]
    pub(super) rpm: Option<u64>,
    #[serde(default)]
    pub(super) concurrency: Option<u32>,
    #[serde(default)]
    pub(super) reason_class: Option<String>,
    #[serde(default)]
    pub(super) until: Option<String>,
}

/// Why a ladder could not be read. The caller refuses the whole standing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MalformedLadder;

impl LadderEntry {
    /// Parse the standing's `ladder`. Absent or `null` is empty. Anything
    /// else must be an array of well-formed entries, or the standing fails
    /// closed.
    pub fn list_from_wire(value: Option<&Value>) -> Result<Vec<Self>, MalformedLadder> {
        let Some(value) = value.filter(|value| !value.is_null()) else {
            return Ok(Vec::new());
        };
        let items = value.as_array().ok_or(MalformedLadder)?;
        if items.len() > MAX_LADDER_ENTRIES {
            return Err(MalformedLadder);
        }
        items.iter().map(Self::from_wire).collect()
    }

    pub(super) fn from_wire(value: &Value) -> Result<Self, MalformedLadder> {
        let wire = WireEntry::deserialize(value).map_err(|_| MalformedLadder)?;
        if wire.level > 3 || wire.rpm == Some(0) || wire.concurrency == Some(0) {
            return Err(MalformedLadder);
        }
        let subject_id = match wire.subject_id {
            None => None,
            Some(id) if valid_id(&id) => Some(id),
            Some(_) => return Err(MalformedLadder),
        };
        let names_itself = matches!(wire.scope, LadderScope::Org | LadderScope::Credential);
        if !names_itself && subject_id.is_none() {
            // A user or end user is not named anywhere else on the resolve.
            return Err(MalformedLadder);
        }
        let label = |value: Option<String>| {
            value.and_then(|value| crate::standing::label(value, crate::standing::MAX_LABEL_BYTES))
        };
        Ok(Self {
            scope: wire.scope,
            subject_id,
            level: wire.level,
            rpm: wire.rpm,
            concurrency: wire.concurrency,
            reason_class: label(wire.reason_class),
            until: label(wire.until),
        })
    }

    /// The org-scope L3 a `restricted` standing state means.
    pub fn org_restricted(reason_class: Option<String>, until: Option<String>) -> Self {
        Self {
            scope: LadderScope::Org,
            subject_id: None,
            level: 3,
            rpm: None,
            concurrency: None,
            reason_class,
            until,
        }
    }
}

/// A non-empty, trimmed, control-free id of at most 256 bytes.
pub(super) fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 256 && id.trim() == id && !id.chars().any(char::is_control)
}
