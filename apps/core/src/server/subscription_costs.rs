//! Opt-in, Core-local API-equivalent usage for managed Pi OAuth subscriptions.
//!
//! The ledger stores per-turn model/account identifiers and token counters only.
//! It never stores prompts, provider credentials, or account labels. Prices are
//! resolved from models.dev when the Usage page requests the monthly summary;
//! this is a list-price estimate, not provider-reported billing.

use std::path::Path;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, bail, Context, Result};
use chrono::{DateTime, Datelike, NaiveDate, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use uuid::Uuid;

const TRACKING_SETTING: &str = "tracking_enabled";
const MAX_ID_BYTES: usize = 512;
const MAX_TOKENS_PER_TURN: u64 = 1_000_000_000;

#[derive(Clone)]
pub struct SubscriptionCostStore {
    connection: Arc<Mutex<Connection>>,
}

/// Turn identity and safe account attribution snapshotted by Core before it
/// starts the managed Pi ACP process. Token counts are added only at its final
/// ACP usage event.
#[derive(Clone)]
pub(crate) struct SubscriptionCostAttribution {
    pub(crate) store: SubscriptionCostStore,
    pub(crate) turn_id: Uuid,
    pub(crate) provider_id: String,
    pub(crate) account_id: String,
    pub(crate) model_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelTokenUsage {
    pub provider_id: String,
    pub account_id: String,
    pub model_id: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub missing_input_turns: u64,
    pub missing_output_turns: u64,
    pub turns: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ModelPricing {
    /// USD per million input tokens, exactly as models.dev reports it.
    pub input_usd_per_million: Option<f64>,
    /// USD per million output tokens, exactly as models.dev reports it.
    pub output_usd_per_million: Option<f64>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ModelCostEstimate {
    /// Known portion of the list-price estimate, in micro-USD.
    pub cost_micro_usd: Option<u64>,
    pub unpriced_input_tokens: u64,
    pub unpriced_output_tokens: u64,
}

impl SubscriptionCostStore {
    pub fn open_default() -> Result<Self> {
        Self::open(&crate::paths::db_path("subscription-cost-usage.db"))
    }

    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).with_context(|| {
                format!("creating subscription cost directory {}", parent.display())
            })?;
        }
        let connection = Connection::open(path)
            .with_context(|| format!("opening subscription cost database {}", path.display()))?;
        Self::from_connection(connection)
    }

    fn from_connection(connection: Connection) -> Result<Self> {
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS subscription_cost_settings (
                    name TEXT PRIMARY KEY,
                    value INTEGER NOT NULL CHECK(value IN (0, 1))
                );
                CREATE TABLE IF NOT EXISTS subscription_cost_turns (
                    turn_id TEXT PRIMARY KEY,
                    recorded_at_ms INTEGER NOT NULL,
                    provider_id TEXT NOT NULL,
                    account_id TEXT NOT NULL,
                    model_id TEXT,
                    input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens >= 0),
                    output_tokens INTEGER CHECK(output_tokens IS NULL OR output_tokens >= 0)
                );
                CREATE INDEX IF NOT EXISTS subscription_cost_turns_month_lookup
                    ON subscription_cost_turns(recorded_at_ms, provider_id, account_id, model_id);",
            )
            .context("initializing subscription cost database")?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    pub fn is_enabled(&self) -> Result<bool> {
        let connection = self.lock()?;
        let enabled = connection
            .query_row(
                "SELECT value FROM subscription_cost_settings WHERE name = ?1",
                [TRACKING_SETTING],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .context("reading subscription cost tracking setting")?
            .unwrap_or(0);
        Ok(enabled == 1)
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<()> {
        let connection = self.lock()?;
        connection
            .execute(
                "INSERT INTO subscription_cost_settings(name, value) VALUES (?1, ?2)
                 ON CONFLICT(name) DO UPDATE SET value = excluded.value",
                params![TRACKING_SETTING, i64::from(enabled)],
            )
            .context("updating subscription cost tracking setting")?;
        Ok(())
    }

    /// Persist a completed managed-Pi turn if tracking is still enabled. The
    /// request ID is generated once per Core execution attempt and makes retries
    /// of the same final ACP event idempotent.
    pub(crate) fn record_completed_turn(
        &self,
        attribution: &SubscriptionCostAttribution,
        completed_at: DateTime<Utc>,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
    ) -> Result<bool> {
        validate_identifier("provider id", &attribution.provider_id)?;
        validate_identifier("account id", &attribution.account_id)?;
        if let Some(model_id) = attribution.model_id.as_deref() {
            validate_identifier("model id", model_id)?;
        }
        validate_token_count(input_tokens)?;
        validate_token_count(output_tokens)?;

        let input_tokens = input_tokens.map(to_sql_integer).transpose()?;
        let output_tokens = output_tokens.map(to_sql_integer).transpose()?;
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .context("starting subscription cost record transaction")?;
        let enabled = transaction
            .query_row(
                "SELECT value FROM subscription_cost_settings WHERE name = ?1",
                [TRACKING_SETTING],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .context("checking subscription cost tracking setting")?
            .unwrap_or(0)
            == 1;
        if !enabled {
            transaction
                .commit()
                .context("committing disabled subscription cost record")?;
            return Ok(false);
        }

        let (month_start_ms, _) = month_bounds(completed_at);
        transaction
            .execute(
                "DELETE FROM subscription_cost_turns WHERE recorded_at_ms < ?1",
                [month_start_ms],
            )
            .context("pruning previous-month subscription cost rows")?;
        let inserted = transaction
            .execute(
                "INSERT OR IGNORE INTO subscription_cost_turns
                    (turn_id, recorded_at_ms, provider_id, account_id, model_id,
                     input_tokens, output_tokens)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    attribution.turn_id.to_string(),
                    completed_at.timestamp_millis(),
                    attribution.provider_id,
                    attribution.account_id,
                    attribution.model_id,
                    input_tokens,
                    output_tokens,
                ],
            )
            .context("recording completed subscription usage")?;
        transaction
            .commit()
            .context("committing subscription cost record")?;
        Ok(inserted == 1)
    }

    /// Aggregate only the current UTC calendar month. Old rows are deleted when
    /// this view is read or a new turn is recorded; the ledger is intentionally
    /// month-to-date, not a long-term conversation history.
    pub fn current_month_by_model(&self, now: DateTime<Utc>) -> Result<Vec<ModelTokenUsage>> {
        let (month_start_ms, next_month_start_ms) = month_bounds(now);
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .context("starting subscription cost summary transaction")?;
        transaction
            .execute(
                "DELETE FROM subscription_cost_turns WHERE recorded_at_ms < ?1",
                [month_start_ms],
            )
            .context("pruning previous-month subscription cost rows")?;
        let rows = {
            let mut statement = transaction
                .prepare(
                    "SELECT provider_id, account_id, model_id,
                            COALESCE(SUM(input_tokens), 0),
                            COALESCE(SUM(output_tokens), 0),
                            SUM(CASE WHEN input_tokens IS NULL THEN 1 ELSE 0 END),
                            SUM(CASE WHEN output_tokens IS NULL THEN 1 ELSE 0 END),
                            COUNT(*)
                     FROM subscription_cost_turns
                     WHERE recorded_at_ms >= ?1 AND recorded_at_ms < ?2
                     GROUP BY provider_id, account_id, model_id
                     ORDER BY provider_id, account_id, model_id",
                )
                .context("preparing subscription cost summary query")?;
            let rows = statement
                .query_map(params![month_start_ms, next_month_start_ms], |row| {
                    Ok(ModelTokenUsage {
                        provider_id: row.get(0)?,
                        account_id: row.get(1)?,
                        model_id: row.get(2)?,
                        input_tokens: from_sql_integer(row.get(3)?)?,
                        output_tokens: from_sql_integer(row.get(4)?)?,
                        missing_input_turns: from_sql_integer(row.get(5)?)?,
                        missing_output_turns: from_sql_integer(row.get(6)?)?,
                        turns: from_sql_integer(row.get(7)?)?,
                    })
                })
                .context("querying subscription cost summary")?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .context("reading subscription cost summary")?
        };
        transaction
            .commit()
            .context("committing subscription cost summary")?;
        Ok(rows)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| anyhow!("subscription cost database lock is poisoned"))
    }
}

/// Model rates are USD per million tokens, so multiplying a token count by its
/// rate yields micro-USD directly. A missing rate leaves that direction
/// explicitly unpriced; an explicit zero rate remains a known zero.
pub fn estimate_model_cost(
    input_tokens: u64,
    output_tokens: u64,
    pricing: ModelPricing,
) -> ModelCostEstimate {
    let input_cost = pricing.input_usd_per_million.and_then(|rate| {
        valid_price(rate)
            .then(|| token_cost_micro_usd(input_tokens, rate))
            .flatten()
    });
    let output_cost = pricing.output_usd_per_million.and_then(|rate| {
        valid_price(rate)
            .then(|| token_cost_micro_usd(output_tokens, rate))
            .flatten()
    });
    let cost_micro_usd = match (input_cost, output_cost) {
        (Some(input), Some(output)) => input.checked_add(output),
        (Some(input), None) => Some(input),
        (None, Some(output)) => Some(output),
        (None, None) => None,
    };

    ModelCostEstimate {
        cost_micro_usd,
        unpriced_input_tokens: if input_cost.is_some() {
            0
        } else {
            input_tokens
        },
        unpriced_output_tokens: if output_cost.is_some() {
            0
        } else {
            output_tokens
        },
    }
}

pub fn current_month_label(now: DateTime<Utc>) -> String {
    format!("{:04}-{:02}", now.year(), now.month())
}

fn valid_price(price: f64) -> bool {
    price.is_finite() && price >= 0.0
}

fn token_cost_micro_usd(token_count: u64, usd_per_million: f64) -> Option<u64> {
    let estimate = (token_count as f64) * usd_per_million;
    let rounded = estimate.round();
    (rounded.is_finite() && rounded < u64::MAX as f64).then(|| rounded as u64)
}

fn validate_identifier(label: &str, value: &str) -> Result<()> {
    if value.is_empty()
        || value.trim() != value
        || value.len() > MAX_ID_BYTES
        || value.chars().any(char::is_control)
    {
        bail!("invalid subscription cost {label}");
    }
    Ok(())
}

fn validate_token_count(count: Option<u64>) -> Result<()> {
    if count.is_some_and(|value| value > MAX_TOKENS_PER_TURN) {
        bail!("subscription token count is out of range");
    }
    Ok(())
}

fn to_sql_integer(value: u64) -> Result<i64> {
    i64::try_from(value).context("subscription token count exceeds SQLite integer range")
}

fn from_sql_integer(value: i64) -> rusqlite::Result<u64> {
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(0, value))
}

fn month_bounds(now: DateTime<Utc>) -> (i64, i64) {
    let month_start = NaiveDate::from_ymd_opt(now.year(), now.month(), 1)
        .expect("current UTC date has valid year and month");
    let (next_year, next_month) = if now.month() == 12 {
        (now.year() + 1, 1)
    } else {
        (now.year(), now.month() + 1)
    };
    let next_month_start =
        NaiveDate::from_ymd_opt(next_year, next_month, 1).expect("next UTC month is valid");
    let start =
        Utc.from_utc_datetime(&month_start.and_hms_opt(0, 0, 0).expect("midnight is valid"));
    let next = Utc.from_utc_datetime(
        &next_month_start
            .and_hms_opt(0, 0, 0)
            .expect("midnight is valid"),
    );
    (start.timestamp_millis(), next.timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::{
        current_month_label, estimate_model_cost, ModelPricing, SubscriptionCostAttribution,
        SubscriptionCostStore,
    };
    use chrono::{TimeZone, Utc};
    use uuid::Uuid;

    fn store() -> SubscriptionCostStore {
        SubscriptionCostStore::from_connection(
            rusqlite::Connection::open_in_memory().expect("open memory database"),
        )
        .expect("initialize memory database")
    }

    fn attribution(store: &SubscriptionCostStore, turn_id: Uuid) -> SubscriptionCostAttribution {
        SubscriptionCostAttribution {
            store: store.clone(),
            turn_id,
            provider_id: "anthropic".to_owned(),
            account_id: "acct-a".to_owned(),
            model_id: Some("claude-sonnet-4".to_owned()),
        }
    }

    #[test]
    fn tracking_defaults_off_and_can_be_toggled_without_deleting_this_month() {
        let store = store();
        let now = Utc.with_ymd_and_hms(2026, 9, 24, 1, 2, 3).unwrap();
        let turn_id = Uuid::new_v4();
        let turn = attribution(&store, turn_id);

        assert!(!store.is_enabled().unwrap());
        assert!(!store
            .record_completed_turn(&turn, now, Some(100), Some(25))
            .unwrap());
        store.set_enabled(true).unwrap();
        assert!(store
            .record_completed_turn(&turn, now, Some(100), Some(25))
            .unwrap());
        store.set_enabled(false).unwrap();

        let rows = store.current_month_by_model(now).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].input_tokens, 100);
        assert_eq!(rows[0].output_tokens, 25);
        assert!(!store.is_enabled().unwrap());
    }

    #[test]
    fn a_replayed_final_event_is_idempotent() {
        let store = store();
        store.set_enabled(true).unwrap();
        let now = Utc.with_ymd_and_hms(2026, 9, 24, 1, 2, 3).unwrap();
        let turn = attribution(&store, Uuid::new_v4());

        assert!(store
            .record_completed_turn(&turn, now, Some(400), Some(80))
            .unwrap());
        assert!(!store
            .record_completed_turn(&turn, now, Some(400), Some(80))
            .unwrap());
        let rows = store.current_month_by_model(now).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].turns, 1);
        assert_eq!(rows[0].input_tokens, 400);
        assert_eq!(rows[0].output_tokens, 80);
    }

    #[test]
    fn monthly_rows_group_by_provider_account_and_model_and_mark_missing_counters() {
        let store = store();
        store.set_enabled(true).unwrap();
        let now = Utc.with_ymd_and_hms(2026, 9, 24, 1, 2, 3).unwrap();
        let first = attribution(&store, Uuid::new_v4());
        let second = attribution(&store, Uuid::new_v4());
        let mut other_account = attribution(&store, Uuid::new_v4());
        other_account.account_id = "acct-b".to_owned();
        let last_month = attribution(&store, Uuid::new_v4());

        store
            .record_completed_turn(&first, now, Some(10), Some(3))
            .unwrap();
        store
            .record_completed_turn(&second, now, None, Some(4))
            .unwrap();
        store
            .record_completed_turn(&other_account, now, Some(2), Some(1))
            .unwrap();
        let last_month_at = Utc.with_ymd_and_hms(2026, 8, 31, 23, 59, 59).unwrap();
        store
            .record_completed_turn(&last_month, last_month_at, Some(999), Some(999))
            .unwrap();

        let rows = store.current_month_by_model(now).unwrap();
        assert_eq!(rows.len(), 2);
        let first_account = rows.iter().find(|row| row.account_id == "acct-a").unwrap();
        assert_eq!(first_account.input_tokens, 10);
        assert_eq!(first_account.output_tokens, 7);
        assert_eq!(first_account.missing_input_turns, 1);
        assert_eq!(first_account.missing_output_turns, 0);
        assert_eq!(first_account.turns, 2);
        assert!(!rows
            .iter()
            .any(|row| row.account_id == "acct-b" && row.turns != 1));
    }

    #[test]
    fn a_turn_finishing_after_utc_month_rollover_counts_in_the_completion_month() {
        let store = store();
        store.set_enabled(true).unwrap();
        let started_at = Utc.with_ymd_and_hms(2026, 8, 31, 23, 59, 59).unwrap();
        let completed_at = Utc.with_ymd_and_hms(2026, 9, 1, 0, 0, 1).unwrap();
        let turn = attribution(&store, Uuid::new_v4());
        assert!(started_at < completed_at);

        assert!(store
            .record_completed_turn(&turn, completed_at, Some(100), Some(25))
            .unwrap());
        let rows = store.current_month_by_model(completed_at).unwrap();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].input_tokens, 100);
        assert_eq!(rows[0].output_tokens, 25);
    }

    #[test]
    fn estimate_uses_usd_per_million_as_micro_usd_and_preserves_partial_prices() {
        let full = estimate_model_cost(
            1_000,
            2_000,
            ModelPricing {
                input_usd_per_million: Some(5.0),
                output_usd_per_million: Some(15.0),
            },
        );
        assert_eq!(full.cost_micro_usd, Some(35_000));
        assert_eq!(full.unpriced_input_tokens, 0);
        assert_eq!(full.unpriced_output_tokens, 0);

        let partial = estimate_model_cost(
            100,
            20,
            ModelPricing {
                input_usd_per_million: Some(1.0),
                output_usd_per_million: None,
            },
        );
        assert_eq!(partial.cost_micro_usd, Some(100));
        assert_eq!(partial.unpriced_input_tokens, 0);
        assert_eq!(partial.unpriced_output_tokens, 20);

        let unknown = estimate_model_cost(100, 20, ModelPricing::default());
        assert_eq!(unknown.cost_micro_usd, None);
        assert_eq!(unknown.unpriced_input_tokens, 100);
        assert_eq!(unknown.unpriced_output_tokens, 20);

        let free = estimate_model_cost(
            100,
            20,
            ModelPricing {
                input_usd_per_million: Some(0.0),
                output_usd_per_million: Some(0.0),
            },
        );
        assert_eq!(free.cost_micro_usd, Some(0));
        assert_eq!(free.unpriced_input_tokens, 0);
    }

    #[test]
    fn overflowing_finite_rates_leave_the_affected_tokens_unpriced() {
        let estimate = estimate_model_cost(
            2,
            1,
            ModelPricing {
                input_usd_per_million: Some(f64::MAX),
                output_usd_per_million: Some(1.0),
            },
        );

        assert_eq!(estimate.cost_micro_usd, Some(1));
        assert_eq!(estimate.unpriced_input_tokens, 2);
        assert_eq!(estimate.unpriced_output_tokens, 0);
    }

    #[test]
    fn estimate_rejects_the_first_unrepresentable_u64_micro_usd_value() {
        let estimate = estimate_model_cost(
            1,
            0,
            ModelPricing {
                input_usd_per_million: Some(u64::MAX as f64),
                output_usd_per_million: None,
            },
        );

        assert_eq!(estimate.cost_micro_usd, None);
        assert_eq!(estimate.unpriced_input_tokens, 1);
    }

    #[test]
    fn current_month_label_uses_utc_calendar_month() {
        let month = Utc.with_ymd_and_hms(2026, 9, 30, 23, 59, 59).unwrap();
        assert_eq!(current_month_label(month), "2026-09");
    }
}
