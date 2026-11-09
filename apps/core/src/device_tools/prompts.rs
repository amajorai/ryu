//! Device approval prompts on the existing `data-ryu-permission` /
//! `POST /api/chat/permission` channel.
//!
//! Ids are `perm-dev-<uuidv4>` (never sequential). Each waiter stores the
//! option set Core offered and the owner (the frozen `input_sha256` lives on
//! the call in `claims`, so a changed input can never reuse an approval), and only
//! an offered option resolves it: anything else is a deny. A prompt that needs
//! on-device confirmation (Home security class) can only be DENIED through
//! `POST /api/chat/permission`; it is approved only by [`confirm_on_device`],
//! which `POST /api/device-tools/confirm` calls after verifying a signature
//! from the target phone's user-presence key over the request id, the frozen
//! input hash and the option.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use tokio::sync::oneshot;

pub(crate) const PROMPT_PREFIX: &str = "perm-dev-";
/// How long an approval card waits (design §1.6).
pub(crate) const PROMPT_TIMEOUT_MS: u64 = 5 * 60 * 1000;

pub(crate) const ALLOW_ONCE: &str = "allow_once";
pub(crate) const ALLOW_ALWAYS: &str = "allow_always";
pub(crate) const DENY: &str = "deny";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PromptAnswer {
    AllowOnce,
    AllowAlways,
    Deny,
}

/// What an on-device confirmation must be bound to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OnDeviceBinding {
    pub(crate) target_device_id: String,
    pub(crate) input_sha256: String,
}

struct PendingPrompt {
    conversation_id: String,
    owner_principal_id: String,
    offered: Vec<&'static str>,
    requires_on_device: bool,
    on_device: Option<OnDeviceBinding>,
    sender: oneshot::Sender<PromptAnswer>,
}

fn prompts() -> &'static Mutex<HashMap<String, PendingPrompt>> {
    static PROMPTS: OnceLock<Mutex<HashMap<String, PendingPrompt>>> = OnceLock::new();
    PROMPTS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn is_device_prompt_id(request_id: &str) -> bool {
    request_id.starts_with(PROMPT_PREFIX)
}

/// The option ids offered for one prompt.
pub(crate) fn offered_options(allow_always: bool) -> Vec<&'static str> {
    if allow_always {
        vec![ALLOW_ONCE, ALLOW_ALWAYS, DENY]
    } else {
        vec![ALLOW_ONCE, DENY]
    }
}

/// Removes the prompt when the waiting call ends for any reason.
pub(crate) struct PromptCleanup(pub(crate) String);

impl Drop for PromptCleanup {
    fn drop(&mut self) {
        if let Ok(mut map) = prompts().lock() {
            map.remove(&self.0);
        }
    }
}

/// Register a prompt and return its id and the receiver the call awaits.
pub(crate) fn register(
    conversation_id: &str,
    owner_principal_id: &str,
    allow_always: bool,
    requires_on_device: bool,
) -> (String, oneshot::Receiver<PromptAnswer>) {
    insert(
        conversation_id,
        owner_principal_id,
        allow_always,
        requires_on_device,
        None,
    )
}

/// Register a prompt only the target phone can approve, bound to that phone
/// and the frozen input hash.
pub(crate) fn register_on_device(
    conversation_id: &str,
    owner_principal_id: &str,
    binding: OnDeviceBinding,
) -> (String, oneshot::Receiver<PromptAnswer>) {
    insert(
        conversation_id,
        owner_principal_id,
        false,
        true,
        Some(binding),
    )
}

fn insert(
    conversation_id: &str,
    owner_principal_id: &str,
    allow_always: bool,
    requires_on_device: bool,
    on_device: Option<OnDeviceBinding>,
) -> (String, oneshot::Receiver<PromptAnswer>) {
    let request_id = format!("{PROMPT_PREFIX}{}", uuid::Uuid::new_v4());
    let (sender, receiver) = oneshot::channel();
    if let Ok(mut map) = prompts().lock() {
        map.insert(
            request_id.clone(),
            PendingPrompt {
                conversation_id: conversation_id.to_owned(),
                owner_principal_id: owner_principal_id.to_owned(),
                offered: offered_options(allow_always),
                requires_on_device,
                on_device,
                sender,
            },
        );
    }
    (request_id, receiver)
}

/// The conversation a pending device prompt belongs to, without consuming it.
pub(crate) fn peek_conversation(request_id: &str) -> Option<String> {
    prompts()
        .lock()
        .ok()?
        .get(request_id)
        .map(|prompt| prompt.conversation_id.clone())
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ResolveError {
    /// No such pending prompt (answered, expired or never existed).
    Unknown,
    /// The answering principal does not own the call.
    NotOwner,
    /// Only the target phone can answer (on-device confirmation).
    OnDeviceOnly,
    /// The confirmation is bound to another input than the call's.
    InputMismatch,
}

/// Resolve a prompt from `POST /api/chat/permission`. The caller has already
/// passed the conversation write ACL. An option Core did not offer (including
/// a forged `allow_always`) resolves as a deny; `None` (cancel) is a deny.
pub(crate) fn resolve(
    request_id: &str,
    option_id: Option<&str>,
    answering_principal_id: &str,
) -> Result<PromptAnswer, ResolveError> {
    let mut map = prompts().lock().map_err(|_| ResolveError::Unknown)?;
    let prompt = map.get(request_id).ok_or(ResolveError::Unknown)?;
    if prompt.owner_principal_id != answering_principal_id {
        return Err(ResolveError::NotOwner);
    }
    let deny = option_id.is_none_or(|option| option == DENY);
    // Any surface may decline a physical-access action; only the phone may
    // approve it.
    if prompt.requires_on_device && !deny {
        return Err(ResolveError::OnDeviceOnly);
    }
    let prompt = map.remove(request_id).ok_or(ResolveError::Unknown)?;
    let answer = match option_id {
        Some(option) if prompt.offered.contains(&option) => match option {
            ALLOW_ONCE => PromptAnswer::AllowOnce,
            ALLOW_ALWAYS => PromptAnswer::AllowAlways,
            _ => PromptAnswer::Deny,
        },
        _ => PromptAnswer::Deny,
    };
    let _ = prompt.sender.send(answer);
    Ok(answer)
}

/// An answer from the target phone (`POST /api/device-tools/confirm`). The
/// HTTP layer has already verified the device-lane signature AND, for an
/// approval, the user-presence signature over
/// [`super::confirm::confirm_message`]. Unknown prompts, other principals and
/// other devices all read as `Unknown`, so nothing leaks; a different input
/// hash is refused without consuming the prompt.
pub(crate) fn confirm_on_device(
    request_id: &str,
    option_id: &str,
    principal_id: &str,
    device_id: &str,
    input_sha256: &str,
) -> Result<PromptAnswer, ResolveError> {
    let mut map = prompts().lock().map_err(|_| ResolveError::Unknown)?;
    let prompt = map.get(request_id).ok_or(ResolveError::Unknown)?;
    let Some(binding) = prompt.on_device.as_ref() else {
        return Err(ResolveError::Unknown);
    };
    if prompt.owner_principal_id != principal_id || binding.target_device_id != device_id {
        return Err(ResolveError::Unknown);
    }
    if binding.input_sha256 != input_sha256 {
        return Err(ResolveError::InputMismatch);
    }
    let prompt = map.remove(request_id).ok_or(ResolveError::Unknown)?;
    let answer = if prompt.offered.contains(&option_id) && option_id == ALLOW_ONCE {
        PromptAnswer::AllowOnce
    } else {
        PromptAnswer::Deny
    };
    let _ = prompt.sender.send(answer);
    Ok(answer)
}

/// The binding of a pending on-device prompt (the HTTP layer checks the
/// device before it verifies the user-presence signature).
pub(crate) fn on_device_binding(request_id: &str) -> Option<(String, OnDeviceBinding)> {
    let map = prompts().lock().ok()?;
    let prompt = map.get(request_id)?;
    Some((prompt.owner_principal_id.clone(), prompt.on_device.clone()?))
}
