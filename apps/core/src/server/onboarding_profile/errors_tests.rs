//! The stable codes of a failed profile build.

use super::*;

#[test]
fn each_typed_failure_has_its_wire_code_and_english_text() {
    let cases = [
        (
            ProfileBuildError::Expired,
            "expired",
            "profile job expired; start onboarding again",
        ),
        (
            ProfileBuildError::EmptyDraft,
            "empty_draft",
            "the profile agent returned no profile draft",
        ),
        (
            ProfileBuildError::ContextChanged,
            "context_changed",
            "node onboarding context changed; restart the profile build",
        ),
        (
            ProfileBuildError::CompanyKnowledgeDisabled,
            "company_knowledge_disabled",
            "shared company knowledge is disabled for this node",
        ),
    ];
    for (error, code, english) in cases {
        assert_eq!(error.code(), code);
        assert_eq!(profile_error_code(&anyhow::Error::from(error)), code);
        assert_eq!(anyhow::Error::from(error).to_string(), english);
    }
}

#[test]
fn a_typed_failure_keeps_its_code_under_added_context() {
    let error = anyhow::Error::from(ProfileBuildError::CompanyKnowledgeDisabled)
        .context("materialising the profile");
    assert_eq!(profile_error_code(&error), "company_knowledge_disabled");
}

#[test]
fn an_unclassified_failure_is_reported_as_failed() {
    let error = anyhow::anyhow!("model unavailable");
    assert_eq!(profile_error_code(&error), PROFILE_BUILD_FAILED_CODE);
    assert_eq!(PROFILE_BUILD_FAILED_CODE, "failed");
}

#[tokio::test]
async fn bailing_with_a_typed_failure_keeps_its_code() {
    async fn empty() -> anyhow::Result<()> {
        anyhow::bail!(ProfileBuildError::EmptyDraft);
    }
    let error = empty().await.expect_err("bail returns an error");
    assert_eq!(profile_error_code(&error), "empty_draft");
}
