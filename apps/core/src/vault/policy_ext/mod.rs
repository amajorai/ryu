//! Policy extensions: templated rule paths, request-parameter constraints, and
//! control groups (approval-gated reads).
//!
//! **Templates.** A rule path (and a parameter-constraint value) may contain
//! `{{identity.user.id}}`, `{{identity.machine.id}}`, `{{identity.team.ids}}`,
//! or `{{identity.roles}}`. Placeholders are checked when the policy is written
//! (well-formed, known variable, inside one path segment). At evaluation each
//! placeholder expands to the caller's values; a value is only substituted when
//! it is a safe literal segment (no `/`, glob metacharacters, braces, control
//! characters, `.` or `..`), so identity data can never widen a glob. A rule
//! whose placeholders cannot be resolved is dropped when it allows, and when it
//! denies it is widened (each placeholder becomes `*`), so an unresolved
//! template always fails closed.
//!
//! **Parameters.** A rule granting `write` may carry `allowedParameters`,
//! `deniedParameters`, and `requiredParameters` (OpenBao semantics: `*` as a
//! key means every parameter; an empty value list means any value; values are
//! single-segment globs). Every matching granting rule's denied and required
//! constraints apply; allowed constraints are the union across matching rules
//! that set one.
//!
//! **Control groups.** A rule granting `read` may carry a `controlGroup`: a
//! reveal of a matching value then creates a pending request instead of
//! returning the value. Approvers named by each factor authorize it (never the
//! requester); once every factor has enough approvals, the requester redeems a
//! one-time token for the value. Tokens are stored as SHA-256 digests, compared
//! in constant time, and redeemed by a single conditional `UPDATE`, so a token
//! can be used at most once even under concurrent redemption.

mod control_group_store;
mod control_groups;
mod parameters;
mod templates;
#[cfg(test)]
mod tests;

pub use control_group_store::*;
pub use control_groups::*;
pub use parameters::*;
pub use templates::*;

/// Template variables a policy may reference.
pub const TEMPLATE_VARIABLES: [&str; 4] = [
    "identity.user.id",
    "identity.machine.id",
    "identity.team.ids",
    "identity.roles",
];
/// Maximum concrete paths one templated rule may expand to.
pub const MAX_TEMPLATE_EXPANSIONS: usize = 64;
/// Maximum length of one substituted identity value.
pub const MAX_TEMPLATE_VALUE_LEN: usize = 128;
/// Maximum parameter names per constraint map.
pub const MAX_PARAMETERS: usize = 64;
/// Maximum values per parameter.
pub const MAX_PARAMETER_VALUES: usize = 64;
const MAX_PARAMETER_TEXT_LEN: usize = 256;
/// Maximum factors per control group.
pub const MAX_CONTROL_GROUP_FACTORS: usize = 5;
/// Maximum approvers per factor.
pub const MAX_FACTOR_APPROVERS: usize = 32;
/// Control-group request lifetime bounds (seconds).
pub const MIN_CONTROL_GROUP_TTL_SECS: i64 = 60;
pub const MAX_CONTROL_GROUP_TTL_SECS: i64 = 7 * 24 * 3600;
pub const DEFAULT_CONTROL_GROUP_TTL_SECS: i64 = 24 * 3600;
const TOKEN_PREFIX: &str = "vcg_";
/// Open (pending or approved, unexpired) requests one requester may hold.
pub const MAX_OPEN_REQUESTS_PER_REQUESTER: i64 = 16;
/// Requests returned by one listing.
const MAX_LISTED_REQUESTS: usize = 100;
