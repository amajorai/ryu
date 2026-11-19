//! Why a profile build failed, as a stable code the desktop translates.
//!
//! `ProfileJobView.error` keeps Core's English text for logs and older
//! desktops; `error_code` is what a client renders in the reader's language.
//! A failure Core did not classify (a model or storage error) is `failed`.

use std::fmt;

/// The code of a failure that is not one of the typed [`ProfileBuildError`]s.
pub(super) const PROFILE_BUILD_FAILED_CODE: &str = "failed";

/// The profile build failures a client can explain in its own words.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ProfileBuildError {
    /// The job outlived `PROFILE_JOB_MAX_AGE_MS` and was withdrawn.
    Expired,
    /// The agent's reply had no profile in it.
    EmptyDraft,
    /// The node's setup mode or company context changed mid-build.
    ContextChanged,
    /// A team node turned shared company knowledge off.
    CompanyKnowledgeDisabled,
}

impl ProfileBuildError {
    /// The stable wire code (`ProfileJobView.error_code`).
    pub(super) fn code(self) -> &'static str {
        match self {
            Self::Expired => "expired",
            Self::EmptyDraft => "empty_draft",
            Self::ContextChanged => "context_changed",
            Self::CompanyKnowledgeDisabled => "company_knowledge_disabled",
        }
    }

    /// Core's English description, kept in `ProfileJobView.error`.
    fn english(self) -> &'static str {
        match self {
            Self::Expired => "profile job expired; start onboarding again",
            Self::EmptyDraft => "the profile agent returned no profile draft",
            Self::ContextChanged => "node onboarding context changed; restart the profile build",
            Self::CompanyKnowledgeDisabled => "shared company knowledge is disabled for this node",
        }
    }
}

impl fmt::Display for ProfileBuildError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.english())
    }
}

impl std::error::Error for ProfileBuildError {}

/// The wire code of a failed build: the typed error anywhere in its chain, or
/// [`PROFILE_BUILD_FAILED_CODE`].
pub(super) fn profile_error_code(error: &anyhow::Error) -> &'static str {
    error
        .chain()
        .find_map(|cause| cause.downcast_ref::<ProfileBuildError>())
        .map_or(PROFILE_BUILD_FAILED_CODE, |typed| typed.code())
}
