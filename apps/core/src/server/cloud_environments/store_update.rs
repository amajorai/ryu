//! Atomic replacement of a user's templates and sealed vault.

use super::box_flag::{box_feature_unavailable, newly_selects_box};
use super::validation::validate;
use super::*;

pub(super) fn update(
    owner: &str,
    mut incoming: Snapshot,
    box_allowed: bool,
) -> Result<Snapshot, ApiError> {
    for environment in &mut incoming.environments {
        for domain in &mut environment.internet.allowed_domains {
            domain.make_ascii_lowercase();
        }
    }
    for entry in &mut incoming.vault {
        for domain in &mut entry.domains {
            domain.make_ascii_lowercase();
        }
    }
    validate(&incoming)?;
    let _lock = STORE_LOCK.lock().map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "cloud_environment_store_unavailable",
            "The environment store is unavailable.",
        )
    })?;
    let mut store = load()?;
    if store
        .owners
        .iter()
        .filter(|(identity, _)| identity.as_str() != owner)
        .any(|(_, state)| {
            state
                .environments
                .iter()
                .any(|old| incoming.environments.iter().any(|new| new.id == old.id))
        })
    {
        return Err(error(
            StatusCode::CONFLICT,
            "cloud_environment_id_conflict",
            "An environment ID is already in use. Create a new environment.",
        ));
    }
    let previous = store.owners.get(owner).cloned().unwrap_or_default();
    if !box_allowed && newly_selects_box(&previous, &incoming) {
        return Err(box_feature_unavailable());
    }
    if incoming.revision != previous.revision {
        return Err(error(
            StatusCode::CONFLICT,
            "cloud_environment_revision_conflict",
            "Settings changed. Reload before saving.",
        ));
    }
    crate::crypto_host::install();
    let cipher = ryu_crypto::global_cipher().map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "cloud_environment_vault_unavailable",
            "The encrypted vault is unavailable.",
        )
    })?;
    let vpn_keys: BTreeSet<_> = previous
        .environments
        .iter()
        .chain(&incoming.environments)
        .filter_map(|environment| environment.tailscale_vault_key.as_deref())
        .collect();
    let mut known_vpn_values = Vec::new();
    for entry in &previous.vault {
        if vpn_keys.contains(entry.key.as_str()) || entry.key.starts_with("CLOUD_VPN_") {
            if let Some(value) = &entry.value {
                known_vpn_values.push(cipher.open(value).map_err(|_| {
                    error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "cloud_environment_vault_unavailable",
                        "A saved VPN credential could not be opened.",
                    )
                })?);
            }
        }
    }
    for entry in &incoming.vault {
        if vpn_keys.contains(entry.key.as_str()) || entry.key.starts_with("CLOUD_VPN_") {
            if let Some(value) = &entry.value {
                known_vpn_values.push(value.clone());
            }
        }
    }
    let mut protected_network_values = Vec::new();
    for old in &previous.vault {
        if old.kind != "networkSecret" {
            continue;
        }
        let explicitly_visible = incoming.vault.iter().any(|entry| {
            entry.id == old.id
                && entry.key == old.key
                && entry.kind == "variable"
                && entry.value.is_some()
        });
        if explicitly_visible {
            continue;
        }
        if let Some(value) = &old.value {
            protected_network_values.push(cipher.open(value).map_err(|_| {
                error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "cloud_environment_vault_unavailable",
                    "A saved network secret could not be opened.",
                )
            })?);
        }
    }
    for entry in &incoming.vault {
        if entry.kind == "networkSecret" {
            if let Some(value) = &entry.value {
                protected_network_values.push(value.clone());
            }
        }
    }
    if incoming.environments.iter().any(|environment| {
        known_vpn_values
            .iter()
            .chain(&protected_network_values)
            .any(|value| {
                !value.is_empty()
                    && (environment.install_script.contains(value)
                        || environment.start_instructions.contains(value))
            })
    }) {
        return Err(error(StatusCode::BAD_REQUEST, "cloud_environment_vpn_key_exposed", "Protected credentials must stay in the personal vault and must not appear in scripts or instructions."));
    }
    for entry in &incoming.vault {
        if !incoming
            .environments
            .iter()
            .any(|environment| environment.vault_keys.contains(&entry.key))
        {
            continue;
        }
        let value = match &entry.value {
            Some(value) => Some(value.clone()),
            None => previous
                .vault
                .iter()
                .find(|old| old.id == entry.id && old.key == entry.key && old.kind == entry.kind)
                .and_then(|old| old.value.as_ref())
                .map(|value| cipher.open(value))
                .transpose()
                .map_err(|_| {
                    error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "cloud_environment_vault_unavailable",
                        "A saved value could not be opened.",
                    )
                })?,
        };
        if value.as_ref().is_some_and(|value| {
            known_vpn_values
                .iter()
                .any(|vpn| !vpn.is_empty() && value.contains(vpn))
                || entry.kind == "variable"
                    && protected_network_values
                        .iter()
                        .any(|secret| !secret.is_empty() && value.contains(secret))
        }) {
            return Err(error(
                StatusCode::BAD_REQUEST,
                "cloud_environment_vpn_key_exposed",
                "Task variables must not contain protected network credentials or VPN credentials.",
            ));
        }
    }
    for entry in &mut incoming.vault {
        entry.value = match entry.value.take() {
            Some(value) => Some(cipher.seal(&value).map_err(|_| {
                error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "cloud_environment_vault_unavailable",
                    "The value could not be sealed.",
                )
            })?),
            None => previous
                .vault
                .iter()
                .find(|old| old.id == entry.id && old.key == entry.key && old.kind == entry.kind)
                .and_then(|old| old.value.clone()),
        };
        entry.has_value = entry.value.is_some();
    }
    incoming.revision = previous.revision.checked_add(1).ok_or_else(|| {
        error(
            StatusCode::CONFLICT,
            "cloud_environment_revision_conflict",
            "The revision limit was reached.",
        )
    })?;
    store.owners.insert(owner.into(), incoming.clone());
    save(&store)?;
    Ok(projection(incoming))
}
