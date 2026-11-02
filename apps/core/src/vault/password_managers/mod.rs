//! Password-manager credentials: 1Password and Bitwarden Secrets Manager
//! references resolved at use time, with per-consumer human approval.
//!
//! An **account** is a connection to one provider:
//!
//! * `1password-connect`: a 1Password Connect server URL and access token;
//! * `1password-service-account`: a service-account token for the `op` CLI;
//! * `bitwarden-sm`: a Bitwarden Secrets Manager access token for the `bws`
//!   CLI, with an optional self-hosted server URL.
//!
//! The token is sealed with the vault keyring in `vault_pm_accounts` (listed in
//! [`crate::vault::ENCRYPTED_TABLES`]) and never returned. A CLI binary is
//! resolved to an absolute path when the account is added (operator override
//! [`ENV_OP_BIN`] / [`ENV_BWS_BIN`], else `PATH`); request input never names a
//! program. An account is `connected` or `reconnect_required` (the provider
//! rejected its token on a test or a use; replacing the token reconnects it).
//!
//! A **reference** names one value ([`PmRef`]):
//!
//! ```text
//! op://[<account>@]<vault>/<item>[/<section>]/<field>
//! bws://[<account>@]<secret-uuid>
//! ```
//!
//! The account qualifier is needed only when more than one account of that
//! family (1Password or Bitwarden) exists. Vault, item, section, and field
//! segments are 1-128 characters of letters, digits, space, `.`, `_`, and `-`
//! (use the 1Password id for any other title).
//!
//! **Approval.** Nothing resolves without a grant for the exact (consumer
//! subject, account, reference). The first use by a consumer files a broker
//! credential-use proposal ([`crate::vault::broker::proposals::CredentialUse`])
//! and answers *pending* without contacting the provider. A human with `admin`
//! on [`account_key`] approves it once (one use within a day) or for `1h`,
//! `24h`, or `30d` (the default); grants are listed and revocable. A consumer
//! subject names its channel, so an approval for one channel never covers
//! another ([`broker_subject`], [`read_subject`], [`runtime_subject`]):
//!
//! * `broker:<minter>`: broker sessions minted by `user:<id>`,
//!   `machine:<id>`, or `operator`;
//! * `read:<principal>`: the explicit read API for `user:<id>` or `operator`;
//! * `runtime:<mcp>:<owner>`: a `secret:op://…` template of one MCP server or
//!   plugin running for `user:<id>` or `node:<id>`.
//!
//! Before any grant is consulted, the consumer's policies must allow `use` on
//! [`account_key`]: a machine identity's own grants (no baseline), or deny
//! rules for the user, team, and role subjects behind a user-minted broker
//! session or a runtime template.
//!
//! **Values** are fetched per use and never cached, written to SQLite, or
//! logged. Every resolution is audited with the provider, account, reference,
//! and subject (never the value); under fail-closed auditing a resolution
//! whose audit row no device accepted is refused and its value dropped.

pub mod providers;

mod model;
mod resolve;
mod rows;
mod store_api;

#[cfg(test)]
pub(crate) mod tests;

pub use model::*;
pub use rows::{init_schema, prune};
// Row access, validation and grant bookkeeping shared by the store methods.
use rows::*;

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::audit::{AuditActor, AuditEntry};
use super::broker::proposals::{self, CredentialUse, Proposal, ProposalStatus};
use super::external::net;
use super::policy::{Capability, CapabilitySet, Policy};
use super::{is_valid_environment, now_millis, VaultError};
use crate::plugin_secrets::{
    PluginSecretStore, SecretResolutionContext, MAX_VAULT_SECRET_VALUE_LEN,
};
use providers::{FailureKind, ProviderFailure};

/// Policy-key prefix: `admin` on `sys/password-managers/<account>` manages the
/// account, approves its uses, and revokes its grants; `read` lets a human
/// read a reference through the explicit API (after approval); `use` lets a
/// machine-minted broker session use it (after approval).
pub const SYS_PASSWORD_MANAGERS: &str = "sys/password-managers";
/// Operator override for the `op` binary (absolute path).
pub const ENV_OP_BIN: &str = "RYU_VAULT_PM_OP_BIN";
/// Operator override for the `bws` binary (absolute path).
pub const ENV_BWS_BIN: &str = "RYU_VAULT_PM_BWS_BIN";
const MAX_TOKEN_LEN: usize = 8 * 1024;
const MAX_ADDRESS_LEN: usize = 512;
const MAX_REF_LEN: usize = 600;
const MAX_SEGMENT_LEN: usize = 128;
/// How long an approve-once grant stays usable.
pub const ONCE_WINDOW_MILLIS: i64 = 24 * 3600 * 1000;
/// Revoked, used, and expired grants are kept this long for the listing.
const GRANT_RETENTION_MILLIS: i64 = 30 * 24 * 3600 * 1000;

/// Policy key for one account.
pub fn account_key(name: &str) -> String {
    format!("{SYS_PASSWORD_MANAGERS}/{name}")
}
