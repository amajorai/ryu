//! Reviewed cross-app holders of the Mail, Outpost, and Skills host bridges.
//!
//! `mail:crud` and `social:crud` gate host verbs (`mail.*`, `social.request`)
//! that the desktop host forwards to `/api/mail` and `/api/social` with the
//! owner's node token. A holder can read every agent inbox (OTP codes and
//! password-reset links included), send as any inbox, and publish to or read
//! DMs from the user's connected social accounts, with no per-call approval.
//!
//! The owning apps (`@ryu/mail`, `@ryu/social`) keep their grant through the
//! protected owner-scoped rule (`protected_owner_id_list()`). Any OTHER app may
//! hold it only when it is listed here, so the grants are owner-exclusive rather
//! than on the global allowlist. An operator who trusts a further app can still
//! add the grant to `RYU_MARKETPLACE_GRANT_ALLOWLIST`.
//!
//! `crossapp_grant_tests::every_in_repo_crossapp_declarer_is_approved` fails
//! when a new in-repo manifest declares either grant without a row here.

/// The Agent Mail host bridge grant.
pub(super) const MAIL_CRUD_GRANT: &str = "mail:crud";

/// The Outpost (social) host bridge grant.
pub(super) const SOCIAL_CRUD_GRANT: &str = "social:crud";

/// Reviewed cross-app holders of [`MAIL_CRUD_GRANT`]: Outreach lists inboxes and
/// sends an explicitly selected, human-reviewed message.
pub(super) const MAIL_CRUD_CROSSAPP_OWNERS: &[&str] = &["@ryu/outreach", "com.ryu.outreach"];

/// Reviewed cross-app holders of [`SOCIAL_CRUD_GRANT`]: Video Studio hands a
/// finished render to Outpost (an optional grant).
pub(super) const SOCIAL_CRUD_CROSSAPP_OWNERS: &[&str] =
    &["@ryu/video-studio", "com.ryu.video-studio"];

/// Core's `/api/skills` CRUD bridge (`skills.*`), forwarded with the owner's
/// node token. A holder can create or overwrite any skill with an `always-on`
/// body (folded into every agent turn's system prefix) and arbitrary
/// `allowed-tools` frontmatter, written into the shared skills root that
/// Claude Code also loads. No app owns the reserved `skills` namespace, so
/// only the reviewed holders below may hold it.
pub(super) const SKILLS_CRUD_GRANT: &str = "skills:crud";

/// Reviewed holders of [`SKILLS_CRUD_GRANT`]: the Skill Editor companion.
pub(super) const SKILLS_CRUD_CROSSAPP_OWNERS: &[&str] =
    &["@ryu/skill-editor", "com.ryu.skill-editor"];
