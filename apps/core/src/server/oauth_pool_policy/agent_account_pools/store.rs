//! Where the pool catalog is kept: one preferences record, next to the
//! per-provider account pool policies (`oauth-account-pool:<provider>`).

use super::model::{Catalog, PoolError};
use crate::server::preferences::PreferencesStore;

pub(crate) const PREF_KEY: &str = "agent-account-pools";

/// Serializes read-modify-write of the record inside this process.
static WRITE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum EditError {
    Pool(PoolError),
    Storage,
}

impl EditError {
    /// The text a route answers with. Plain API errors, like the provider
    /// account pool policy routes next to them.
    pub(crate) fn message(&self) -> &'static str {
        match self {
            Self::Pool(PoolError::NotFound) => "account pool not found",
            Self::Pool(PoolError::LimitReached) => "the account pool limit is reached",
            Self::Pool(PoolError::Invalid(message)) => *message,
            Self::Storage => "account pools could not be saved",
        }
    }
}

/// The stored catalog. A record that cannot be parsed reads as no pools (the
/// settings screen then shows none, which matches what is enforced). A store
/// that cannot be read is an error, so a caller can refuse instead of
/// choosing an account without knowing the pool.
pub(crate) async fn load(preferences: &PreferencesStore) -> anyhow::Result<Catalog> {
    let Some(raw) = preferences.get(PREF_KEY).await? else {
        return Ok(Catalog::default());
    };
    Ok(match serde_json::from_str::<Catalog>(&raw) {
        Ok(catalog) => catalog.sanitized(),
        Err(error) => {
            tracing::error!(%error, "stored account pools are unreadable and count as none");
            Catalog::default()
        }
    })
}

async fn save(preferences: &PreferencesStore, catalog: &Catalog) -> Result<(), EditError> {
    let raw = serde_json::to_string(catalog).map_err(|error| {
        tracing::error!(%error, "could not encode account pools");
        EditError::Storage
    })?;
    preferences.set(PREF_KEY, &raw).await.map_err(|error| {
        tracing::error!(%error, "could not save account pools");
        EditError::Storage
    })
}

/// Apply one change to the catalog and save it. Returns the change's result
/// and the saved catalog.
pub(crate) async fn edit<T>(
    preferences: &PreferencesStore,
    change: impl FnOnce(&mut Catalog) -> Result<T, PoolError>,
) -> Result<(T, Catalog), EditError> {
    let _guard = WRITE.lock().await;
    let mut catalog = load(preferences).await.map_err(|error| {
        tracing::error!(%error, "could not read account pools");
        EditError::Storage
    })?;
    let result = change(&mut catalog).map_err(EditError::Pool)?;
    save(preferences, &catalog).await?;
    Ok((result, catalog))
}

/// Apply a clean-up that may change nothing. `change` returns whether it
/// changed the catalog; nothing is written when it did not.
pub(crate) async fn edit_if_changed(
    preferences: &PreferencesStore,
    change: impl FnOnce(&mut Catalog) -> bool,
) -> Result<bool, EditError> {
    let _guard = WRITE.lock().await;
    let mut catalog = load(preferences).await.map_err(|error| {
        tracing::error!(%error, "could not read account pools");
        EditError::Storage
    })?;
    if !change(&mut catalog) {
        return Ok(false);
    }
    save(preferences, &catalog).await?;
    Ok(true)
}
