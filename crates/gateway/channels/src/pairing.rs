//! DM pairing and per-conversation access policy.
//!
//! The original gate ([`crate::channel_chat_allowed`]) was a flat, env-configured
//! chat allowlist: a chat id was either listed or the channel was closed. That is
//! safe but unusable for a bot the operator wants strangers to be able to start a
//! DM with — the operator had to read the chat id out of a log and edit an env
//! var before the bot would say a single word.
//!
//! Pairing replaces that dance. An unknown DM sender is answered with a one-time
//! **pairing code**; the operator approves the code from Ryu, and from then on
//! that sender is paired and talks to the bot normally. Nothing is admitted until
//! a human approves, so the default stays closed — the security property the flat
//! allowlist had — while the enrolment step moves out of the config file.
//!
//! Groups are gated separately ([`GroupPolicy`]): a group is a shared room, so
//! "someone in it typed at the bot" is not consent for the whole room. There is
//! no pairing flow for groups — a group is allowlisted or it is not.
//!
//! The store is a small JSON file so a paired sender survives a gateway restart.
//! It is deliberately NOT the control-plane database: pairing state is per-node
//! runtime data (the same bot token on another node has its own pairings), and
//! the gateway must be able to gate inbound traffic while the control plane is
//! unreachable.
//!
//! At rest the whole JSON body is one `encb:v1:` envelope under the Gateway's
//! content key for the store [`PAIRING_STORE`] ([`PairingSeal`]): its keys are
//! phone numbers, handles and chat ids. The associated data binds a logical id,
//! never the path, so the file can move (`RYU_CHANNEL_PAIRING_PATH`). A legacy
//! plaintext file is read and resealed on load; a file that does not open is
//! moved aside (`<name>.unreadable-<unix secs>`) and the store starts empty.
//! Without a key nothing is written: the store keeps its state in memory only.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ryu_crypto::{ContentCipher, ContentContext};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::sync::{Mutex, RwLock};
use tracing::{info, warn};

mod access;
mod delivery;
mod store_file;

pub use access::*;
#[cfg(test)]
use delivery::*;
#[cfg(test)]
use store_file::*;

/// How long an unapproved pairing code stays valid. After this the sender must
/// message again to get a fresh code — a code left lying around in a chat log
/// should not be approvable a month later.
pub const CODE_TTL: Duration = Duration::from_secs(60 * 60 * 24);
const REPLY_LINK_TTL: Duration = Duration::from_secs(60 * 60 * 24 * 90);
const MAX_REPLY_LINKS: usize = 4096;

/// Characters a pairing code is drawn from. Digits `0`/`1` and letters `O`/`I`
/// are omitted so a code read aloud or off a phone screen is unambiguous.
const CODE_ALPHABET: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/// Length of a generated pairing code.
const CODE_LEN: usize = 6;

/// How long a completed or failed provider delivery remains in the node-local
/// ledger. Provider webhooks are at-least-once, and a redelivery after a
/// restart must still converge on the original turn rather than create a second
/// model call.
const DELIVERY_RETENTION: Duration = Duration::from_secs(60 * 60 * 24 * 30);

/// How long an in-flight delivery claim is kept before a later webhook may
/// reclaim it. This covers normal model/media work while still allowing a
/// process that died mid-turn to recover when the provider redelivers.
const DELIVERY_LEASE: Duration = Duration::from_secs(60 * 30);

/// Hard bound for the node-local provider delivery ledger. A full ledger fails
/// closed at the webhook boundary so the provider retries instead of letting an
/// unbounded attacker-controlled id set consume disk.
const MAX_DELIVERY_RECORDS: usize = 8192;

/// Hard bound on live, unapproved pairing codes. A full queue fails closed
/// (unknown senders are dropped silently) so a flood of new DM senders cannot
/// grow the node-local store, or the cost of rewriting it, without bound.
const MAX_PENDING_PAIRINGS: usize = 1024;

/// One durable provider delivery claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum DeliveryState {
    /// The normalized message is being handled by the Gateway.
    Processing,
    /// The message was handled or intentionally refused and must not be run
    /// again when the provider retries the callback.
    Completed,
    /// The Gateway exhausted its local retry budget. A later provider
    /// redelivery may claim it again.
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct DeliveryRecord {
    state: DeliveryState,
    updated_at: u64,
    attempts: u32,
}

/// Result of claiming one provider delivery.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryClaim {
    /// This caller owns the delivery and may process it.
    Claimed,
    /// Another task is already processing the same delivery inside its lease.
    InFlight,
    /// The delivery completed previously, so the retry is safely acknowledged
    /// without another model call or outbound message.
    Completed,
}

/// How a channel treats a **direct message** from a sender it has not seen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DmPolicy {
    /// Unknown senders get a one-time pairing code and are held until an operator
    /// approves it. The default: closed to strangers, but self-service to enrol.
    #[default]
    Pairing,
    /// Only senders on the configured allowlist are admitted; everyone else is
    /// dropped silently. No enrolment path.
    Allowlist,
    /// Every DM is admitted. Only sane for a bot whose completions the operator
    /// is happy to pay for on behalf of anyone who finds it.
    Open,
    /// DMs are refused entirely; the bot only works in allowlisted groups.
    Disabled,
}

/// How a channel treats a message in a **group / multi-user** conversation.
///
/// Deliberately narrower than [`DmPolicy`]: there is no pairing flow, because the
/// consent that matters for a room is the operator's, not one member's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GroupPolicy {
    /// Only allowlisted group/chat ids are served.
    #[default]
    Allowlist,
    /// Any group the bot has been added to is served.
    Open,
    /// The bot never answers in groups.
    Disabled,
}

/// What the gate decided about one inbound message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Route the message to the agent.
    Allow,
    /// Drop the message without replying. Used where replying would leak that the
    /// bot exists to someone the operator never admitted.
    Deny,
    /// Do not route the message; instead reply with this pairing code so the
    /// sender can read it out to the operator.
    Challenge(String),
    /// Do not route; the sender already has a live code awaiting approval. Carries
    /// the existing code so the reply can repeat it rather than mint a second one.
    Pending(String),
}

/// The persisted state of one sender on one platform.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum PairState {
    /// A code has been issued and is waiting for operator approval.
    Pending {
        code: String,
        /// Unix seconds when the code was issued, for [`CODE_TTL`] expiry.
        issued_at: u64,
    },
    /// The operator approved this sender; messages flow.
    Paired {
        /// Unix seconds when approval happened. Informational (shown in the UI).
        paired_at: u64,
    },
    /// The operator explicitly blocked this sender. Distinct from "unknown" so a
    /// blocked sender never gets another code by messaging again.
    Blocked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct ReplyLink {
    core_message_ids: Vec<String>,
    updated_at: u64,
}

/// The on-disk shape. A map of `"<platform>:<sender_id>"` → state, provider
/// message links, and bounded delivery claims, plus a version tag so a future
/// format change can migrate rather than silently mis-parse.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct PairingFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    entries: HashMap<String, PairState>,
    #[serde(default)]
    reply_links: HashMap<String, ReplyLink>,
    #[serde(default)]
    deliveries: HashMap<String, DeliveryRecord>,
}

/// The registered content-store name of the pairing file (KDF input; never
/// rename it).
pub const PAIRING_STORE: &str = "channel-pairing.json";

/// The logical id bound into the pairing file's associated data.
const PAIRING_FILE_ID: &str = "channel-pairing";

/// How the pairing file is protected at rest.
#[derive(Clone)]
pub enum PairingSeal {
    /// Seal the whole body with this cipher (the Gateway's content key for
    /// [`PAIRING_STORE`]).
    Sealed(ContentCipher),
    /// No key in this process: a legacy plaintext file is still read, but the
    /// store keeps every change in memory and never writes the file.
    Unavailable(String),
}

/// Pairing state for every channel on this node, backed by a sealed JSON file.
///
/// Cloneable and cheap to share: the map lives behind one `Arc<RwLock<_>>`, so all
/// channel loops on a node observe the same approvals the moment they land.
#[derive(Clone)]
pub struct PairingStore {
    inner: Arc<RwLock<PairingFile>>,
    persist_lock: Arc<Mutex<()>>,
    /// Set only together with `cipher`: the store never writes plaintext.
    path: Option<PathBuf>,
    cipher: Option<ContentCipher>,
}

#[cfg(test)]
mod tests;
