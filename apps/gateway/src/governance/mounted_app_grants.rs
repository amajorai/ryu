//! Reviewed holders of the grants that open another app's whole sidecar mount.
//!
//! Each grant below gates ONE generic forwarder that the app host serves with the
//! owner's node token. The forwarder takes any sub-path of the target app's mount
//! and any of its methods, and neither the host nor Core's ext-proxy can tell
//! which app's frame is calling: the route permission is checked against the
//! signed-in person. So holding the grant is the same as being that person on
//! every route of the mount:
//!
//! - `rlm:query` (`rlm.request`, `/api/rlm`): Deep Read loads caller-named folders
//!   under the user's home into a context and returns their text as stored.
//! - `blueprint:review` (`blueprint.request`, `/api/blueprint`): record the human
//!   reviewer's verdict on an agent's plan, write the notes the agent reads back.
//! - `app:http:@ryu/recipes` (`app.request({ app })`, the Recipes mount): save a
//!   recipe and replay it as real clicks and keystrokes, start and stop a
//!   recording of the user's input.
//!
//! None of them is on the default allowlist, where any marketplace app could
//! declare it. The owning apps and the in-repo consumers that were reviewed with
//! the mount are listed here and reach the grant through
//! `OWNER_EXCLUSIVE_GRANTS`. An operator who trusts a further app can still add
//! the grant to `RYU_MARKETPLACE_GRANT_ALLOWLIST`.
//!
//! `mounted_app_grants_tests::every_in_repo_declarer_is_a_reviewed_holder` fails
//! when a new in-repo manifest declares one of them without a row here.

/// The Deep Read mount grant (also the grant of the provided `rlm.query`
/// capability that Research's sidecar calls through Core's capability broker).
pub(super) const RLM_QUERY_GRANT: &str = "rlm:query";

/// Reviewed holders of [`RLM_QUERY_GRANT`] - Deep Read itself and Research, which
/// requires the `rlm.query` capability.
pub(super) const RLM_QUERY_HOLDERS: &[&str] = &[
    "@ryu/rlm",
    "com.ryu.rlm",
    "@ryu/research",
    "com.ryu.research",
];

/// The Blueprint mount grant.
pub(super) const BLUEPRINT_REVIEW_GRANT: &str = "blueprint:review";

/// Reviewed holders of [`BLUEPRINT_REVIEW_GRANT`] - Blueprint itself and Feedback
/// Board, which can hold a build until its plan is approved.
pub(super) const BLUEPRINT_REVIEW_HOLDERS: &[&str] = &[
    "@ryu/blueprint",
    "com.ryu.blueprint",
    "@ryu/feedback-board",
    "com.ryu.feedback-board",
];

/// The per-target cross-app request grant for the Recipes mount.
pub(super) const RECIPES_REQUEST_GRANT: &str = "app:http:@ryu/recipes";

/// Reviewed holders of [`RECIPES_REQUEST_GRANT`] - the Workflows Companion, which
/// lists recorded recipes from the Recipes list route.
pub(super) const RECIPES_REQUEST_HOLDERS: &[&str] = &["@ryu/workflows", "com.ryu.workflows"];
