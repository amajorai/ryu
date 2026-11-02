//! Core-native sign-in flows that need no Node bridge: the ChatGPT plan and Kiro.

use super::login_text::{
    auth_url_event, error_event, error_event_or, message_event, plan_start_failure,
    PlanLoginFailure,
};
use super::*;
use crate::i18n::messages::{
    LOGIN_CHATGPT_PLAN_INSTRUCTIONS_MESSAGE, LOGIN_CODE_EXPIRED_MESSAGE,
    LOGIN_FRESH_ATTEMPT_MESSAGE, LOGIN_KIRO_INSTRUCTIONS_MESSAGE,
};
use crate::i18n::Message;

pub(super) enum PlanLoginTarget {
    New,
    Existing {
        account_id: String,
        registration: crate::pi_config::chatgpt_plan::StoredAccount,
    },
}

pub(super) fn store_plan_registration(
    vault: &crate::pi_config::accounts::AccountVault,
    target: &PlanLoginTarget,
    registration: &crate::pi_config::chatgpt_plan::StoredAccount,
) -> Result<String> {
    let _guard = crate::pi_config::ACCOUNT_SELECTION_LOCK
        .lock()
        .expect("account selection lock");
    let scope = crate::pi_config::accounts::provider_scope(crate::pi_config::CHATGPT_PLAN_AUTH_KEY);
    let updated = serde_json::to_value(registration)?;
    match target {
        PlanLoginTarget::Existing {
            account_id,
            registration: original,
        } => {
            if !original.matches_registration(registration) {
                return Err(PlanLoginFailure::OtherRegistration.into());
            }
            let current = vault
                .credential(&scope, account_id)?
                .ok_or(PlanLoginFailure::AccountRemoved)?;
            let current_registration =
                crate::pi_config::chatgpt_plan::StoredAccount::from_value(&current)?;
            if !current_registration.matches_registration(registration)
                || !vault.replace_credential(&scope, account_id, &current, updated)?
            {
                return Err(PlanLoginFailure::RegistrationChanged.into());
            }
            // Reconnection renews this registration without changing a selection
            // the user made while the browser was open.
            Ok(account_id.clone())
        }
        PlanLoginTarget::New => {
            for account in vault.list(&scope)? {
                let Some(current) = vault.credential(&scope, &account.account_id)? else {
                    continue;
                };
                let Ok(saved) = crate::pi_config::chatgpt_plan::StoredAccount::from_value(&current)
                else {
                    continue;
                };
                if saved.matches_registration(registration) {
                    if !vault.replace_credential(&scope, &account.account_id, &current, updated)? {
                        return Err(PlanLoginFailure::RegistrationChanged.into());
                    }
                    vault.set_active(&scope, &account.account_id)?;
                    return Ok(account.account_id);
                }
            }
            let account_id = crate::pi_config::new_account_id();
            let identity = registration.registration();
            let label = crate::pi_config::vault_account_label(
                vault,
                &scope,
                identity.email.as_deref().unwrap_or("ChatGPT plan"),
            );
            vault.upsert(
                &scope,
                &account_id,
                &label,
                crate::pi_config::accounts::KIND_OAUTH,
                Some(updated),
            )?;
            Ok(account_id)
        }
    }
}

pub(super) async fn start_chatgpt_plan(
    account_id: Option<&str>,
    enable_plan_use: bool,
) -> Result<String> {
    static START_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _start_guard = START_LOCK.lock().await;
    let vault = crate::pi_config::accounts::global().ok_or(PlanLoginFailure::VaultRequired)?;
    let scope = crate::pi_config::accounts::provider_scope(crate::pi_config::CHATGPT_PLAN_AUTH_KEY);
    let target = match account_id {
        Some(id) if !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control) => {
            let value = vault
                .credential(&scope, id)?
                .ok_or(PlanLoginFailure::RegistrationNotSaved)?;
            PlanLoginTarget::Existing {
                account_id: id.to_owned(),
                registration: crate::pi_config::chatgpt_plan::StoredAccount::from_value(&value)?,
            }
        }
        Some(_) => anyhow::bail!("Choose a valid saved ChatGPT account"),
        None => PlanLoginTarget::New,
    };
    let stale: Vec<_> = sessions()
        .lock()
        .map_err(|_| anyhow!("Login session storage is unavailable"))?
        .iter()
        .filter(|(_, session)| session.provider == crate::pi_config::CHATGPT_PLAN_PROVIDER_ID)
        .map(|(id, _)| id.clone())
        .collect();
    for id in stale {
        cancel(&id);
    }
    let existing = match &target {
        PlanLoginTarget::New => None,
        PlanLoginTarget::Existing { registration, .. } => Some(registration.clone()),
    };
    // A discovery or registration failure answers the start request; like a
    // failure on the stream, it is one generic coded sentence (detail logged).
    let attempt = crate::pi_config::chatgpt_plan::LoginAttempt::begin(existing, enable_plan_use)
        .await
        .map_err(plan_start_failure)?;
    let url = attempt.authorization_url().map_err(plan_start_failure)?;
    let (tx, _) = broadcast::channel(64);
    let session = Arc::new(LoginSession {
        tx,
        history: Mutex::new(Vec::new()),
        stdin: tokio::sync::Mutex::new(None),
        child: Mutex::new(None),
        native_abort: Mutex::new(None),
        finished: AtomicBool::new(false),
        provider: crate::pi_config::CHATGPT_PLAN_PROVIDER_ID.to_owned(),
        stderr_tail: Mutex::new(VecDeque::new()),
    });
    session.emit(auth_url_event(
        &url,
        &Message::new(LOGIN_CHATGPT_PLAN_INSTRUCTIONS_MESSAGE),
    ));
    let session_id = format!("login_{}", uuid::Uuid::new_v4().simple());
    sessions()
        .lock()
        .map_err(|_| anyhow!("Login session storage is unavailable"))?
        .insert(session_id.clone(), session.clone());
    let task_session = session.clone();
    let task = tokio::spawn(async move {
        let result = async {
            let mut attempt = attempt;
            let mut retried = false;
            let registration = loop {
                match attempt.complete().await {
                    Ok(registration) => break registration,
                    Err(error)
                        if !retried
                            && crate::pi_config::chatgpt_plan::retry_registration(&error)
                                .is_some() =>
                    {
                        retried = true;
                        if task_session.is_finished() {
                            anyhow::bail!("Sign-in was cancelled");
                        }
                        attempt = match &target {
                            PlanLoginTarget::New => {
                                crate::pi_config::chatgpt_plan::LoginAttempt::retry(
                                    crate::pi_config::chatgpt_plan::retry_registration(&error)
                                        .expect("retry registration"),
                                )
                                .await?
                            }
                            PlanLoginTarget::Existing { registration, .. } => {
                                crate::pi_config::chatgpt_plan::LoginAttempt::begin(
                                    Some(registration.clone()),
                                    enable_plan_use,
                                )
                                .await?
                            }
                        };
                        task_session.emit(message_event(
                            "info",
                            &Message::new(LOGIN_CODE_EXPIRED_MESSAGE),
                        ));
                        task_session.emit(auth_url_event(
                            &attempt.authorization_url()?,
                            &Message::new(LOGIN_FRESH_ATTEMPT_MESSAGE),
                        ));
                    }
                    Err(error) => return Err(error),
                }
            };
            if task_session.is_finished() {
                anyhow::bail!("Sign-in was cancelled");
            }
            let _refresh_guard = crate::pi_config::OAUTH_REFRESH_LOCK.lock().await;
            let account_id = store_plan_registration(vault, &target, &registration)?;
            Ok::<_, anyhow::Error>((account_id, registration.plan_authorized()))
        }
        .await;
        if !task_session.is_finished() {
            match result {
                Ok((account_id, authorized)) => task_session.emit(json!({ "type": "success",
                    "provider": crate::pi_config::CHATGPT_PLAN_AUTH_KEY, "accountId": account_id,
                    "planUseAuthorized": authorized })),
                Err(error) => task_session.emit(error_event(&error)),
            }
        }
        task_session.finished.store(true, Ordering::SeqCst);
        if let Ok(mut abort) = task_session.native_abort.lock() {
            *abort = None;
        }
    });
    *session
        .native_abort
        .lock()
        .map_err(|_| anyhow!("Login cancellation is unavailable"))? = Some(task.abort_handle());
    let timeout_id = session_id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(LOGIN_TIMEOUT).await;
        cancel(&timeout_id);
    });
    Ok(session_id)
}

pub(super) async fn start_kiro(account_id: Option<&str>) -> Result<String> {
    static START_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _start_guard = START_LOCK.lock().await;
    let vault = crate::pi_config::accounts::global().ok_or(PlanLoginFailure::VaultRequired)?;
    let scope = crate::pi_config::accounts::provider_scope("kiro");
    let original = match account_id {
        Some(id) => Some((
            id.to_owned(),
            vault
                .credential_revision(&scope, id)?
                .ok_or_else(|| anyhow!("The saved Kiro account is unavailable"))?,
            vault
                .credential(&scope, id)?
                .ok_or_else(|| anyhow!("The saved Kiro account is unavailable"))?,
        )),
        None => None,
    };
    let stale: Vec<_> = sessions()
        .lock()
        .map_err(|_| anyhow!("Login session storage is unavailable"))?
        .iter()
        .filter(|(_, session)| session.provider == "kiro")
        .map(|(id, _)| id.clone())
        .collect();
    for id in stale {
        cancel(&id);
    }
    let attempt = crate::pi_config::kiro_oauth::begin().await?;
    let (tx, _) = broadcast::channel(64);
    let session = Arc::new(LoginSession {
        tx,
        history: Mutex::new(Vec::new()),
        stdin: tokio::sync::Mutex::new(None),
        child: Mutex::new(None),
        native_abort: Mutex::new(None),
        finished: AtomicBool::new(false),
        provider: "kiro".to_owned(),
        stderr_tail: Mutex::new(VecDeque::new()),
    });
    session.emit(auth_url_event(
        &attempt.auth_url,
        &Message::new(LOGIN_KIRO_INSTRUCTIONS_MESSAGE).text("code", attempt.device_code.clone()),
    ));
    let session_id = format!("login_{}", uuid::Uuid::new_v4().simple());
    sessions()
        .lock()
        .map_err(|_| anyhow!("Login session storage is unavailable"))?
        .insert(session_id.clone(), session.clone());
    let task_session = session.clone();
    let task = tokio::spawn(async move {
        let result = async {
            let credential = attempt.complete().await?;
            if task_session.is_finished() {
                anyhow::bail!("Sign-in was cancelled");
            }
            let _guard = crate::pi_config::OAUTH_REFRESH_LOCK.lock().await;
            if task_session.is_finished() {
                anyhow::bail!("Sign-in was cancelled");
            }
            let id = if let Some((id, revision, previous)) = original {
                if previous
                    .get("profileArn")
                    .and_then(Value::as_str)
                    .zip(credential.get("profileArn").and_then(Value::as_str))
                    .is_some_and(|(before, after)| before != after)
                {
                    return Err(PlanLoginFailure::KiroOtherProfile.into());
                }
                if !vault.finish_refresh(&scope, &id, &previous, &revision, credential)? {
                    return Err(PlanLoginFailure::KiroLoginChanged.into());
                }
                id
            } else {
                let id = crate::pi_config::new_account_id();
                let label = crate::pi_config::vault_account_label(vault, &scope, "kiro");
                vault.upsert(
                    &scope,
                    &id,
                    &label,
                    crate::pi_config::accounts::KIND_OAUTH,
                    Some(credential),
                )?;
                id
            };
            crate::pi_config::ensure_kiro_models_json(None)?;
            Ok::<_, anyhow::Error>(id)
        }
        .await;
        if !task_session.is_finished() {
            match result {
                Ok(id) => {
                    task_session.emit(json!({"type":"success", "provider":"kiro", "accountId":id}))
                }
                Err(error) => {
                    task_session.emit(error_event_or(&error, PlanLoginFailure::KiroSaveFailed))
                }
            }
        }
        task_session.finished.store(true, Ordering::SeqCst);
    });
    *session
        .native_abort
        .lock()
        .map_err(|_| anyhow!("Login cancellation is unavailable"))? = Some(task.abort_handle());
    let timeout_id = session_id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(LOGIN_TIMEOUT).await;
        cancel(&timeout_id);
    });
    Ok(session_id)
}
