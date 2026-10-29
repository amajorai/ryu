//! Postgres checkpoint backend (feature `postgres`).
//!
//! One table holds every namespace:
//!
//! ```sql
//! CREATE TABLE IF NOT EXISTS ryu_durable_checkpoints (
//!     namespace  TEXT        NOT NULL,
//!     id         TEXT        NOT NULL,
//!     state      JSONB       NOT NULL,
//!     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
//!     PRIMARY KEY (namespace, id)
//! );
//! ```
//!
//! `put` is a single `INSERT … ON CONFLICT DO UPDATE`, so a write is atomic and
//! durable once Postgres commits it. The table is created on first use. The
//! connection is opened lazily and replaced when it closes; TLS follows the
//! URL's `sslmode` (`disable`, `prefer` — the default — or `require`) against
//! the platform trust store, matching Core's other Postgres clients.

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::Mutex;

use crate::store::{checked_id, CheckpointError, CheckpointStore};
use crate::BoxFuture;

const BACKEND: &str = "postgres";

/// Default table name.
pub const DEFAULT_TABLE: &str = "ryu_durable_checkpoints";

/// Validate a table name: `table` or `schema.table`, each part
/// `[a-z_][a-z0-9_]*` and at most 63 bytes (Postgres' identifier limit). The
/// name is interpolated into SQL (identifiers cannot be bound), so nothing
/// else is accepted.
pub fn validate_table(table: &str) -> Result<(), CheckpointError> {
    let parts: Vec<&str> = table.split('.').collect();
    let valid_part = |part: &str| {
        !part.is_empty()
            && part.len() <= 63
            && part
                .bytes()
                .next()
                .is_some_and(|b| b.is_ascii_lowercase() || b == b'_')
            && part
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    };
    if (1..=2).contains(&parts.len()) && parts.iter().all(|part| valid_part(part)) {
        Ok(())
    } else {
        Err(CheckpointError::Config(format!(
            "postgres table must be `table` or `schema.table` of [a-z0-9_] identifiers: {table:?}"
        )))
    }
}

fn quoted(table: &str) -> String {
    table
        .split('.')
        .map(|part| format!("\"{part}\""))
        .collect::<Vec<_>>()
        .join(".")
}

/// The SQL every verb runs, rendered once per table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Statements {
    pub create: String,
    pub put: String,
    pub get: String,
    pub delete: String,
    pub list: String,
}

impl Statements {
    /// Render the statements for a validated `table`.
    pub fn for_table(table: &str) -> Result<Self, CheckpointError> {
        validate_table(table)?;
        let t = quoted(table);
        Ok(Self {
            create: format!(
                "CREATE TABLE IF NOT EXISTS {t} (\
                 namespace TEXT NOT NULL, \
                 id TEXT NOT NULL, \
                 state JSONB NOT NULL, \
                 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), \
                 PRIMARY KEY (namespace, id))"
            ),
            // The JSON travels as text and is cast server-side, so no extra
            // tokio-postgres serde feature is needed.
            put: format!(
                "INSERT INTO {t} (namespace, id, state, updated_at) \
                 VALUES ($1, $2, CAST($3::text AS jsonb), now()) \
                 ON CONFLICT (namespace, id) \
                 DO UPDATE SET state = EXCLUDED.state, updated_at = now()"
            ),
            get: format!("SELECT state::text FROM {t} WHERE namespace = $1 AND id = $2"),
            delete: format!("DELETE FROM {t} WHERE namespace = $1 AND id = $2"),
            list: format!("SELECT id FROM {t} WHERE namespace = $1"),
        })
    }
}

/// `sslmode` from the URL, defaulting to `prefer`.
fn tls_mode(url: &url::Url) -> &'static str {
    let mode = url
        .query_pairs()
        .find(|(key, _)| key == "sslmode")
        .map(|(_, value)| value.into_owned());
    match mode.as_deref() {
        Some("disable") => "disable",
        Some("require" | "verify-ca" | "verify-full") => "require",
        _ => "prefer",
    }
}

/// `host:port/db` without credentials.
pub fn redacted(connection_url: &str) -> String {
    url::Url::parse(connection_url)
        .map(|url| {
            format!(
                "postgres://{}:{}{}",
                url.host_str().unwrap_or("?"),
                url.port().unwrap_or(5432),
                url.path()
            )
        })
        .unwrap_or_else(|_| "postgres://<invalid>".to_owned())
}

/// The shared connection behind every namespace's [`PostgresCheckpointStore`].
pub struct PostgresBackend {
    config: tokio_postgres::Config,
    tls: &'static str,
    target: String,
    statements: Statements,
    client: Mutex<Option<Arc<tokio_postgres::Client>>>,
    schema_ready: Mutex<bool>,
}

impl std::fmt::Debug for PostgresBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PostgresBackend")
            .field("target", &self.target)
            .field("tls", &self.tls)
            .finish()
    }
}

impl PostgresBackend {
    /// Parse `connection_url` and validate `table`. No I/O happens here.
    pub fn new(connection_url: &str, table: &str) -> Result<Self, CheckpointError> {
        let mut url = url::Url::parse(connection_url)
            .map_err(|_| CheckpointError::Config("postgres URL is not a URL".to_owned()))?;
        if !matches!(url.scheme(), "postgres" | "postgresql") {
            return Err(CheckpointError::Config(
                "postgres URL must use postgres:// or postgresql://".to_owned(),
            ));
        }
        let tls = tls_mode(&url);
        // tokio-postgres reads `sslmode` itself; strip it so `require` maps onto
        // our connector and unknown values never reach its parser.
        let pairs: Vec<(String, String)> = url
            .query_pairs()
            .filter(|(key, _)| key != "sslmode")
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        url.query_pairs_mut().clear().extend_pairs(pairs);
        if url.query() == Some("") {
            url.set_query(None);
        }
        let mut config: tokio_postgres::Config = url
            .as_str()
            .parse()
            .map_err(|_| CheckpointError::Config("postgres URL could not be parsed".to_owned()))?;
        config.connect_timeout(Duration::from_secs(10));
        config.ssl_mode(match tls {
            "disable" => tokio_postgres::config::SslMode::Disable,
            "require" => tokio_postgres::config::SslMode::Require,
            _ => tokio_postgres::config::SslMode::Prefer,
        });
        Ok(Self {
            config,
            tls,
            target: redacted(connection_url),
            statements: Statements::for_table(table)?,
            client: Mutex::new(None),
            schema_ready: Mutex::new(false),
        })
    }

    /// Credential-free description of the target.
    pub fn target(&self) -> &str {
        &self.target
    }

    async fn connect(&self) -> Result<tokio_postgres::Client, CheckpointError> {
        let fail = |error: tokio_postgres::Error| {
            CheckpointError::backend(BACKEND, format!("connecting to {}: {error}", self.target))
        };
        if self.tls == "disable" {
            let (client, connection) = self
                .config
                .connect(tokio_postgres::NoTls)
                .await
                .map_err(fail)?;
            tokio::spawn(connection);
            return Ok(client);
        }
        let connector = native_tls::TlsConnector::new()
            .map_err(|error| CheckpointError::backend(BACKEND, format!("TLS setup: {error}")))?;
        let (client, connection) = self
            .config
            .connect(postgres_native_tls::MakeTlsConnector::new(connector))
            .await
            .map_err(fail)?;
        tokio::spawn(connection);
        Ok(client)
    }

    /// The live client, reconnecting when the previous one closed, with the
    /// table created on first use.
    async fn client(&self) -> Result<Arc<tokio_postgres::Client>, CheckpointError> {
        let client = {
            let mut slot = self.client.lock().await;
            match slot.as_ref().filter(|client| !client.is_closed()) {
                Some(client) => Arc::clone(client),
                None => {
                    let client = Arc::new(self.connect().await?);
                    *slot = Some(Arc::clone(&client));
                    client
                }
            }
        };
        let mut ready = self.schema_ready.lock().await;
        if !*ready {
            if let Err(error) = client.batch_execute(&self.statements.create).await {
                // Two processes racing `CREATE TABLE IF NOT EXISTS` can collide on
                // the catalog's unique index; the table exists either way.
                let raced = error.code().is_some_and(|code| {
                    *code == tokio_postgres::error::SqlState::UNIQUE_VIOLATION
                        || *code == tokio_postgres::error::SqlState::DUPLICATE_TABLE
                });
                if !raced {
                    return Err(CheckpointError::backend(BACKEND, error));
                }
            }
            *ready = true;
        }
        Ok(client)
    }

    /// A store handle bound to `namespace`.
    pub fn store(
        self: &Arc<Self>,
        namespace: &str,
    ) -> Result<PostgresCheckpointStore, CheckpointError> {
        checked_id(namespace)?;
        Ok(PostgresCheckpointStore {
            backend: Arc::clone(self),
            namespace: namespace.to_owned(),
        })
    }
}

/// One namespace of a [`PostgresBackend`].
#[derive(Debug, Clone)]
pub struct PostgresCheckpointStore {
    backend: Arc<PostgresBackend>,
    namespace: String,
}

fn pg_error(error: tokio_postgres::Error) -> CheckpointError {
    CheckpointError::backend(BACKEND, error)
}

impl CheckpointStore for PostgresCheckpointStore {
    fn backend(&self) -> &'static str {
        BACKEND
    }

    fn put<'a>(
        &'a self,
        id: &'a str,
        state: &'a Value,
    ) -> BoxFuture<'a, Result<(), CheckpointError>> {
        Box::pin(async move {
            checked_id(id)?;
            let json = serde_json::to_string(state)
                .map_err(|error| CheckpointError::Serialization(error.to_string()))?;
            let client = self.backend.client().await?;
            client
                .execute(&self.backend.statements.put, &[&self.namespace, &id, &json])
                .await
                .map_err(pg_error)?;
            Ok(())
        })
    }

    fn get<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<Value>, CheckpointError>> {
        Box::pin(async move {
            checked_id(id)?;
            let client = self.backend.client().await?;
            let row = client
                .query_opt(&self.backend.statements.get, &[&self.namespace, &id])
                .await
                .map_err(pg_error)?;
            let Some(row) = row else {
                return Ok(None);
            };
            let json: String = row.try_get(0).map_err(pg_error)?;
            serde_json::from_str(&json)
                .map(Some)
                .map_err(|error| CheckpointError::Serialization(error.to_string()))
        })
    }

    fn delete<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<bool, CheckpointError>> {
        Box::pin(async move {
            checked_id(id)?;
            let client = self.backend.client().await?;
            let removed = client
                .execute(&self.backend.statements.delete, &[&self.namespace, &id])
                .await
                .map_err(pg_error)?;
            Ok(removed > 0)
        })
    }

    fn list(&self) -> BoxFuture<'_, Result<Vec<String>, CheckpointError>> {
        Box::pin(async move {
            let client = self.backend.client().await?;
            let rows = client
                .query(&self.backend.statements.list, &[&self.namespace])
                .await
                .map_err(pg_error)?;
            let mut ids = rows
                .iter()
                .map(|row| row.try_get::<_, String>(0))
                .collect::<Result<Vec<_>, _>>()
                .map_err(pg_error)?;
            // Sort in Rust: the column collation need not be bytewise.
            ids.sort();
            Ok(ids)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_names_are_strict_identifiers() {
        for good in ["ryu_durable_checkpoints", "ops.checkpoints", "_t1"] {
            assert!(validate_table(good).is_ok(), "{good}");
        }
        for bad in [
            "",
            "Checkpoints",
            "a.b.c",
            "t; DROP TABLE x",
            "1t",
            "t\"x",
            &"a".repeat(64),
        ] {
            assert!(validate_table(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn statements_quote_the_table_and_bind_every_value() {
        let sql = Statements::for_table("ops.checkpoints").unwrap();
        assert!(sql
            .create
            .starts_with("CREATE TABLE IF NOT EXISTS \"ops\".\"checkpoints\""));
        assert!(sql.put.contains("ON CONFLICT (namespace, id)"));
        assert!(sql.put.contains("CAST($3::text AS jsonb)"));
        assert!(sql.get.contains("namespace = $1 AND id = $2"));
        assert!(sql.list.ends_with("WHERE namespace = $1"));
    }

    #[test]
    fn urls_are_validated_and_redacted() {
        let backend = PostgresBackend::new(
            "postgres://app:s3cret@db.internal:6543/ryu?sslmode=require",
            DEFAULT_TABLE,
        )
        .unwrap();
        assert_eq!(backend.target(), "postgres://db.internal:6543/ryu");
        assert_eq!(backend.tls, "require");
        assert!(!format!("{backend:?}").contains("s3cret"));
        assert!(PostgresBackend::new("mysql://x/y", DEFAULT_TABLE).is_err());
        assert!(PostgresBackend::new("postgres://x/y", "bad table").is_err());
        let default_tls = PostgresBackend::new("postgresql://x/y", DEFAULT_TABLE).unwrap();
        assert_eq!(default_tls.tls, "prefer");
    }

    #[tokio::test]
    async fn an_unreachable_server_is_a_redacted_backend_error() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let backend = Arc::new(
            PostgresBackend::new(
                &format!("postgres://app:s3cret@127.0.0.1:{port}/ryu?sslmode=disable"),
                DEFAULT_TABLE,
            )
            .unwrap(),
        );
        let store = backend.store("runs").unwrap();
        let error = store.get("run_1").await.unwrap_err();
        assert!(matches!(
            error,
            CheckpointError::Backend {
                backend: "postgres",
                ..
            }
        ));
        assert!(!error.to_string().contains("s3cret"));
        // Invalid ids never reach the network.
        assert!(matches!(
            store.get("../x").await.unwrap_err(),
            CheckpointError::InvalidId(_)
        ));
    }
}
