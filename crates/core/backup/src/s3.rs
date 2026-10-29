use std::{path::Path, sync::Arc, time::Duration};

use anyhow::{ensure, Context, Result};
use futures_util::{StreamExt, TryStreamExt};
use object_store::{
    aws::AmazonS3Builder, buffered::BufWriter, path::Path as ObjectPath, ClientOptions,
    ObjectStore, ObjectStoreExt, RetryConfig,
};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::{encryption, BackupDestination, BackupRecord, BackupScope, SaveBackupDestination};

pub const MAX_CATALOG_ENTRIES: usize = 2000;

/// Inactivity bound for S3 calls: the time to a response head (which covers
/// sending an 8 MiB upload part), then the time between body reads. It equals
/// the former 120 s total, so small calls and part uploads do not regress, but a
/// multi-GB restore keeps streaming for as long as bytes keep arriving instead
/// of failing at a fixed total that no large archive download can meet.
const S3_IDLE_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug)]
struct BackupConnector {
    allow_http: bool,
}

/// The HTTP client every S3 backup call uses. It owns all transport timeouts:
/// with a custom connector, `ClientOptions` timeouts are never applied.
fn backup_http_client(allow_http: bool, idle: Duration) -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .https_only(!allow_http)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(idle)
        .build()
}

impl object_store::client::HttpConnector for BackupConnector {
    fn connect(
        &self,
        _options: &ClientOptions,
    ) -> object_store::Result<object_store::client::HttpClient> {
        let client = backup_http_client(self.allow_http, S3_IDLE_TIMEOUT).map_err(|source| {
            object_store::Error::Generic {
                store: "S3 backup",
                source: Box::new(source),
            }
        })?;
        Ok(object_store::client::HttpClient::new(client))
    }
}

pub fn validate(request: &SaveBackupDestination) -> Result<()> {
    ensure!(
        !request.name.trim().is_empty() && request.name.len() <= 120,
        "Destination name must contain 1–120 bytes"
    );
    let endpoint = url::Url::parse(&request.endpoint).context("Invalid S3 endpoint")?;
    ensure!(
        endpoint.scheme() == "https" || (endpoint.scheme() == "http" && request.allow_http),
        "Use HTTPS, or explicitly allow HTTP for a trusted S3 server"
    );
    ensure!(endpoint.host_str().is_some() && endpoint.username().is_empty() && endpoint.password().is_none()
        && endpoint.query().is_none() && endpoint.fragment().is_none() && endpoint.path() == "/", "Endpoint must contain only scheme, host and optional port, without a bucket or credentials");
    if let Some(host) = endpoint.host_str() {
        ensure!(
            host != "metadata.google.internal"
                && host != "169.254.169.254"
                && host != "[fd00:ec2::254]",
            "Cloud metadata endpoints are not S3 destinations"
        );
        if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() {
            ensure!(
                !ip.is_link_local() && !ip.is_unspecified() && !ip.is_multicast(),
                "Invalid S3 destination address"
            );
        }
    }
    ensure!(
        (3..=63).contains(&request.bucket.len())
            && request
                .bucket
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.')
            && request.bucket.as_bytes()[0].is_ascii_alphanumeric()
            && request.bucket.as_bytes()[request.bucket.len() - 1].is_ascii_alphanumeric(),
        "Invalid S3 bucket name"
    );
    ensure!(
        !request.region.is_empty()
            && request.region.len() <= 64
            && request
                .region
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-'),
        "Invalid S3 region; use auto for R2"
    );
    ensure!(
        request.prefix.len() <= 256
            && request.prefix.trim_matches('/').split('/').all(|p| {
                p.is_empty()
                    || (p != "."
                        && p != ".."
                        && p.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.')))
            }),
        "Prefix must use safe slash-separated names"
    );
    ensure!(
        !request.access_key_id.is_empty()
            && request.access_key_id.len() <= 256
            && !request.secret_access_key.is_empty()
            && request.secret_access_key.len() <= 1024,
        "S3 access key and secret are required"
    );
    ensure!(
        request
            .session_token
            .as_ref()
            .is_none_or(|v| v.len() <= 8192),
        "Session token is too long"
    );
    ensure!(
        request.allowed_apps.len() <= 100
            && request.allowed_apps.iter().all(|v| !v.is_empty()
                && v.len() <= 128
                && v.bytes()
                    .all(|b| b.is_ascii_alphanumeric()
                        || matches!(b, b'.' | b'-' | b'_' | b'@' | b'/'))),
        "Invalid allowed app IDs"
    );
    encryption::parse_key(&request.recovery_key)?;
    Ok(())
}

#[derive(Clone)]
pub struct S3BackupStore {
    store: Arc<dyn ObjectStore>,
    prefix: String,
    key: [u8; 32],
}

impl S3BackupStore {
    pub fn new(
        destination: &BackupDestination,
        access_key: &str,
        secret: &str,
        session_token: Option<&str>,
        key: [u8; 32],
    ) -> Result<Self> {
        let mut endpoint = url::Url::parse(&destination.endpoint)?;
        if !destination.path_style {
            let host = format!(
                "{}.{}",
                destination.bucket,
                endpoint.host_str().context("Missing endpoint host")?
            );
            endpoint.set_host(Some(&host))?;
        }
        let mut builder = AmazonS3Builder::new()
            .with_http_connector(BackupConnector {
                allow_http: destination.allow_http,
            })
            .with_endpoint(endpoint.as_str().trim_end_matches('/'))
            .with_bucket_name(&destination.bucket)
            .with_region(&destination.region)
            .with_access_key_id(access_key)
            .with_secret_access_key(secret)
            .with_virtual_hosted_style_request(!destination.path_style)
            .with_allow_http(destination.allow_http)
            // Destinations are arbitrary S3-compatible servers, and not all of
            // them implement bulk `DeleteObjects` (`POST /?delete`), which
            // object_store uses for single deletes since 0.13. Keep the plain
            // `DELETE /key` that every S3-compatible provider supports.
            .with_disable_bulk_delete(true)
            // Timeouts live in `BackupConnector`; a custom connector ignores
            // the `ClientOptions` ones.
            .with_client_options(ClientOptions::new().with_allow_http(destination.allow_http))
            .with_retry(RetryConfig {
                max_retries: 2,
                retry_timeout: Duration::from_secs(180),
                ..Default::default()
            });
        if let Some(token) = session_token.filter(|token| !token.trim().is_empty()) {
            builder = builder.with_token(token);
        }
        let prefix = format!("{}/ryu-backups/v1", destination.prefix.trim_matches('/'))
            .trim_start_matches('/')
            .to_owned();
        Ok(Self {
            store: Arc::new(builder.build()?),
            prefix,
            key,
        })
    }

    pub fn object_key(&self, id: &str) -> Result<String> {
        uuid::Uuid::parse_str(id).context("Invalid backup ID")?;
        Ok(format!("{}/{id}.ryubak", self.prefix))
    }

    fn record_path(&self, id: &str) -> Result<ObjectPath> {
        self.object_key(id)?;
        Ok(ObjectPath::from(format!("{}/{id}.record", self.prefix)))
    }

    fn lookup_path(&self, id: &str) -> Result<ObjectPath> {
        self.object_key(id)?;
        Ok(ObjectPath::from(format!(
            "{}/lookups/{id}.locator",
            self.prefix
        )))
    }

    fn scope_prefix(&self, scope: &BackupScope) -> Result<ObjectPath> {
        let key = hex::encode(Sha256::digest(serde_json::to_vec(scope)?));
        Ok(ObjectPath::from(format!("{}/scopes/{key}", self.prefix)))
    }

    fn scoped_record_path(&self, record: &BackupRecord) -> Result<ObjectPath> {
        self.object_key(&record.id)?;
        Ok(ObjectPath::from(format!(
            "{}/{}.record",
            self.scope_prefix(&record.scope)?,
            record.id
        )))
    }

    pub fn scoped_object_key(&self, id: &str, scope: &BackupScope) -> Result<String> {
        self.object_key(id)?;
        Ok(format!("{}/{id}.ryubak", self.scope_prefix(scope)?))
    }

    fn valid_object_key(&self, record: &BackupRecord) -> Result<bool> {
        Ok(record.object_key == self.object_key(&record.id)?
            || record.object_key == self.scoped_object_key(&record.id, &record.scope)?)
    }

    /// Verifies write/read/list/delete with a unique, disposable encrypted probe.
    pub async fn test(&self) -> Result<()> {
        let path = ObjectPath::from(format!("{}/probes/{}", self.prefix, uuid::Uuid::new_v4()));
        let probe = b"Ryu S3 backup connection test";
        self.store
            .put(&path, probe.to_vec().into())
            .await
            .context("S3 write test failed")?;
        let read_result: Result<()> = async {
            let result = self.store.get(&path).await.context("S3 read test failed")?;
            ensure!(
                result.meta.size == probe.len() as u64,
                "S3 probe has incorrect length"
            );
            ensure!(
                result.bytes().await?.as_ref() == probe,
                "S3 probe did not round-trip"
            );
            let prefix = ObjectPath::from(format!("{}/probes", self.prefix));
            let mut listing = self.store.list(Some(&prefix));
            let mut found = false;
            let mut scanned = 0usize;
            while let Some(object) = listing.try_next().await.context("S3 list test failed")? {
                scanned += 1;
                ensure!(
                    scanned <= MAX_CATALOG_ENTRIES,
                    "Too many stale S3 connection probes"
                );
                if object.location == path {
                    found = true;
                    break;
                }
            }
            ensure!(found, "S3 probe was not listed");
            Ok(())
        }
        .await;
        let cleanup = self
            .store
            .delete(&path)
            .await
            .context("S3 delete test failed; remove the connection-test probe manually");
        read_result?;
        cleanup?;
        Ok(())
    }

    pub async fn upload(&self, file: &Path, record: &BackupRecord) -> Result<()> {
        ensure!(
            record.object_key == self.scoped_object_key(&record.id, &record.scope)?,
            "Invalid backup object key"
        );
        let mut input = tokio::fs::File::open(file).await?;
        let mut output = BufWriter::with_capacity(
            self.store.clone(),
            ObjectPath::from(record.object_key.clone()),
            8 * 1024 * 1024,
        )
        .with_max_concurrency(2);
        if let Err(error) = tokio::io::copy(&mut input, &mut output).await {
            let _ = output.abort().await;
            return Err(error).context("S3 backup upload failed");
        }
        if let Err(error) = output.shutdown().await {
            return Err(error).context("S3 backup upload did not finish");
        }
        let metadata = serde_json::to_vec(record)?;
        let mut encrypted = Vec::new();
        encryption::encrypt(
            metadata.as_slice(),
            &mut encrypted,
            metadata.len() as u64,
            &self.key,
        )?;
        // Publish direct-ID recovery before the catalog commit marker. A crash
        // between these puts leaves a recoverable, unlisted backup.
        let lookup_path = self.lookup_path(&record.id)?;
        if let Err(error) = self.store.put(&lookup_path, encrypted.clone().into()).await {
            let _ = self
                .store
                .delete(&ObjectPath::from(record.object_key.clone()))
                .await;
            return Err(error).context("S3 backup lookup publication failed");
        }
        // Only a fully uploaded archive with a recovery lookup can be listed.
        let catalog_path = self.scoped_record_path(record)?;
        if let Err(error) = self.store.put(&catalog_path, encrypted.into()).await {
            // The write may have committed before its acknowledgement failed.
            // Preserve recovery prerequisites if marker removal is uncertain.
            match self.store.delete(&catalog_path).await {
                Ok(()) | Err(object_store::Error::NotFound { .. }) => {}
                Err(_) => {
                    return Err(error)
                        .context("S3 backup catalog publication failed; recovery data retained")
                }
            }
            let _ = self.store.delete(&lookup_path).await;
            let _ = self
                .store
                .delete(&ObjectPath::from(record.object_key.clone()))
                .await;
            return Err(error).context("S3 backup catalog publication failed");
        }
        Ok(())
    }

    pub async fn record(&self, id: &str) -> Result<BackupRecord> {
        let object = match self.store.get(&self.lookup_path(id)?).await {
            Ok(object) => object,
            Err(object_store::Error::NotFound { .. }) => self
                .store
                .get(&self.record_path(id)?)
                .await
                .context("Backup record is unavailable")?,
            Err(error) => return Err(error).context("Backup record is unavailable"),
        };
        self.decode_record(id, object).await
    }

    async fn decode_record(
        &self,
        id: &str,
        object: object_store::GetResult,
    ) -> Result<BackupRecord> {
        ensure!(object.meta.size <= 16 * 1024, "Backup record is too large");
        let bytes = object.bytes().await?;
        let mut decoded = Vec::new();
        encryption::decrypt(bytes.as_ref(), &mut decoded, &self.key)?;
        let record: BackupRecord = serde_json::from_slice(&decoded)?;
        ensure!(
            record.version == 1
                && record.id == id
                && self.valid_object_key(&record)?
                && record.bytes <= crate::archive::MAX_ARCHIVE_BYTES + 32 * 1024 * 1024,
            "Invalid backup record"
        );
        Ok(record)
    }

    pub async fn list(&self, scope: Option<&BackupScope>) -> Result<Vec<BackupRecord>> {
        self.list_with_limit(scope, MAX_CATALOG_ENTRIES).await
    }

    async fn list_with_limit(
        &self,
        scope: Option<&BackupScope>,
        limit: usize,
    ) -> Result<Vec<BackupRecord>> {
        let mut records = Vec::new();
        let root = ObjectPath::from(self.prefix.clone());
        let prefix = scope
            .map(|scope| self.scope_prefix(scope))
            .transpose()?
            .unwrap_or_else(|| root.clone());
        let mut prefixes = vec![prefix];
        if scope.is_some() {
            // Legacy flat catalogs remain discoverable. Only matching records
            // consume this scope's admission; foreign scopes cannot disable retention.
            prefixes.push(root);
        }
        for (index, prefix) in prefixes.iter().enumerate() {
            let mut listing = if index > 0 {
                // New scopes and direct-ID lookups are subdirectories, so their
                // growth cannot expand the legacy flat listing.
                futures_util::stream::iter(
                    self.store
                        .list_with_delimiter(Some(prefix))
                        .await?
                        .objects
                        .into_iter()
                        .map(Ok),
                )
                .boxed()
            } else {
                self.store.list(Some(prefix))
            };
            while let Some(object) = listing.try_next().await? {
                let Some(relative) = object
                    .location
                    .as_ref()
                    .strip_prefix(&format!("{}/", self.prefix))
                else {
                    continue;
                };
                if index > 0 && relative.contains('/') {
                    continue;
                }
                let Some(id) = relative
                    .rsplit('/')
                    .next()
                    .and_then(|name| name.strip_suffix(".record"))
                else {
                    continue;
                };
                if uuid::Uuid::parse_str(id).is_err() {
                    continue;
                }
                let record = self
                    .decode_record(id, self.store.get(&object.location).await?)
                    .await?;
                if scope.is_none_or(|scope| scope == &record.scope) {
                    if records
                        .iter()
                        .any(|existing: &BackupRecord| existing.id == record.id)
                    {
                        continue;
                    }
                    ensure!(records.len() < limit, "Backup scope catalog is too large; use retention or a more specific destination prefix");
                    records.push(record);
                }
            }
        }
        records.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| b.id.cmp(&a.id))
        });
        Ok(records)
    }

    pub async fn download(&self, record: &BackupRecord, destination: &Path) -> Result<()> {
        ensure!(self.valid_object_key(record)?, "Invalid backup object key");
        let authoritative = self.record(&record.id).await?;
        ensure!(
            authoritative.scope == record.scope && authoritative.object_key == record.object_key,
            "Backup record scope does not match the authenticated catalog"
        );
        let result = self
            .store
            .get(&ObjectPath::from(record.object_key.clone()))
            .await?;
        ensure!(
            result.meta.size == record.bytes,
            "Backup size verification failed"
        );
        let mut stream = result.into_stream();
        let mut output = tokio::fs::File::create(destination).await?;
        let mut bytes = 0u64;
        while let Some(chunk) = stream.try_next().await? {
            bytes = bytes
                .checked_add(chunk.len() as u64)
                .context("Backup size overflow")?;
            ensure!(bytes <= record.bytes, "Backup exceeds its recorded size");
            output.write_all(&chunk).await?;
        }
        output.sync_all().await?;
        ensure!(bytes == record.bytes, "Backup download is incomplete");
        let path = destination.to_owned();
        let hash =
            tokio::task::spawn_blocking(move || encryption::sha256(std::fs::File::open(path)?))
                .await??;
        ensure!(hash == record.sha256, "Backup checksum verification failed");
        Ok(())
    }

    pub async fn delete(&self, record: &BackupRecord) -> Result<()> {
        ensure!(self.valid_object_key(record)?, "Invalid backup object key");
        let authoritative = self.record(&record.id).await?;
        ensure!(
            authoritative.scope == record.scope && authoritative.object_key == record.object_key,
            "Backup record scope does not match the authenticated catalog"
        );
        self.store
            .delete(&ObjectPath::from(record.object_key.clone()))
            .await?;
        for path in [
            self.scoped_record_path(record)?,
            self.lookup_path(&record.id)?,
            self.record_path(&record.id)?,
        ] {
            match self.store.delete(&path).await {
                Ok(()) | Err(object_store::Error::NotFound { .. }) => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    pub fn recovery_key(&self) -> &[u8; 32] {
        &self.key
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serve `chunks` 64 KiB chunks `gap` apart, then `stall` before ending.
    async fn slow_body_server(
        chunks: usize,
        gap: Duration,
        stall: Duration,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = axum::Router::new().route(
            "/",
            axum::routing::get(move || async move {
                let body = futures_util::stream::unfold(0_usize, move |sent| async move {
                    if sent == chunks {
                        tokio::time::sleep(stall).await;
                        return None;
                    }
                    if sent > 0 {
                        tokio::time::sleep(gap).await;
                    }
                    Some((
                        Ok::<_, std::io::Error>(axum::body::Bytes::from(vec![7_u8; 64 * 1024])),
                        sent + 1,
                    ))
                });
                axum::body::Body::from_stream(body)
            }),
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (format!("http://{address}/"), server)
    }

    /// A download that keeps receiving bytes must outlive the idle bound in
    /// total (the former 120 s total cut every large restore off), while a
    /// stalled body still fails.
    #[tokio::test]
    async fn backup_client_bounds_idle_time_not_total_transfer_time() {
        let idle = Duration::from_millis(800);
        let client = backup_http_client(true, idle).unwrap();

        let (url, server) = slow_body_server(10, Duration::from_millis(250), Duration::ZERO).await;
        let started = std::time::Instant::now();
        let body = client
            .get(&url)
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .expect("a steadily arriving body is not cut off");
        assert_eq!(body.len(), 10 * 64 * 1024);
        assert!(
            started.elapsed() > 2 * idle,
            "the transfer must outlast the idle bound"
        );
        server.abort();

        let (url, server) = slow_body_server(1, Duration::ZERO, Duration::from_secs(3)).await;
        let stalled = async { client.get(&url).send().await?.bytes().await }.await;
        assert!(stalled.is_err_and(|error| error.is_timeout()));
        server.abort();
    }

    #[derive(Debug)]
    struct PublicationFaultStore {
        inner: object_store::memory::InMemory,
        fault: std::sync::atomic::AtomicU8,
    }

    impl std::fmt::Display for PublicationFaultStore {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("bounded publication fault fixture")
        }
    }

    #[async_trait::async_trait]
    impl ObjectStore for PublicationFaultStore {
        async fn put_opts(
            &self,
            location: &ObjectPath,
            payload: object_store::PutPayload,
            options: object_store::PutOptions,
        ) -> object_store::Result<object_store::PutResult> {
            if location.as_ref().ends_with(".record") {
                match self.fault.load(std::sync::atomic::Ordering::SeqCst) {
                    1 => panic!("simulated interruption before catalog commit"),
                    2 => {
                        return Err(object_store::Error::Generic {
                            store: "publication fixture",
                            source: std::io::Error::other("catalog commit failed").into(),
                        })
                    }
                    3 | 4 => {
                        self.inner.put_opts(location, payload, options).await?;
                        return Err(object_store::Error::Generic {
                            store: "publication fixture",
                            source: std::io::Error::other("catalog acknowledgement lost").into(),
                        });
                    }
                    _ => {}
                }
            }
            self.inner.put_opts(location, payload, options).await
        }
        async fn put_multipart_opts(
            &self,
            location: &ObjectPath,
            options: object_store::PutMultipartOptions,
        ) -> object_store::Result<Box<dyn object_store::MultipartUpload>> {
            self.inner.put_multipart_opts(location, options).await
        }
        async fn get_opts(
            &self,
            location: &ObjectPath,
            options: object_store::GetOptions,
        ) -> object_store::Result<object_store::GetResult> {
            self.inner.get_opts(location, options).await
        }
        fn delete_stream(
            &self,
            locations: futures_util::stream::BoxStream<'static, object_store::Result<ObjectPath>>,
        ) -> futures_util::stream::BoxStream<'static, object_store::Result<ObjectPath>> {
            // `ObjectStoreExt::delete` routes a single delete through this
            // stream; the fault is sampled when that delete is issued.
            let cleanup_unavailable = self.fault.load(std::sync::atomic::Ordering::SeqCst) == 4;
            let locations = locations
                .map(move |location| match location {
                    Ok(path) if cleanup_unavailable && path.as_ref().ends_with(".record") => {
                        Err(object_store::Error::Generic {
                            store: "publication fixture",
                            source: std::io::Error::other("catalog cleanup unavailable").into(),
                        })
                    }
                    other => other,
                })
                .boxed();
            self.inner.delete_stream(locations)
        }
        fn list(
            &self,
            prefix: Option<&ObjectPath>,
        ) -> futures_util::stream::BoxStream<'static, object_store::Result<object_store::ObjectMeta>>
        {
            self.inner.list(prefix)
        }
        async fn list_with_delimiter(
            &self,
            prefix: Option<&ObjectPath>,
        ) -> object_store::Result<object_store::ListResult> {
            self.inner.list_with_delimiter(prefix).await
        }
        async fn copy_opts(
            &self,
            from: &ObjectPath,
            to: &ObjectPath,
            options: object_store::CopyOptions,
        ) -> object_store::Result<()> {
            self.inner.copy_opts(from, to, options).await
        }
    }

    #[tokio::test]
    async fn interrupted_publication_reopens_without_listing_unrestorable_records() {
        for fault in [1, 2, 3, 4] {
            let backend = Arc::new(PublicationFaultStore {
                inner: object_store::memory::InMemory::new(),
                fault: std::sync::atomic::AtomicU8::new(fault),
            });
            let store = S3BackupStore {
                store: backend.clone(),
                prefix: "fixture/ryu-backups/v1".into(),
                key: [7; 32],
            };
            let id = uuid::Uuid::new_v4().to_string();
            let record = BackupRecord {
                version: 1,
                id: id.clone(),
                source_node_id: "fixture-node".into(),
                scope: BackupScope::Node,
                created_at: "2026-10-04T00:00:00Z".into(),
                bytes: 7,
                sha256: encryption::sha256(std::io::Cursor::new(b"archive")).unwrap(),
                object_key: store.scoped_object_key(&id, &BackupScope::Node).unwrap(),
            };
            let file = tempfile::NamedTempFile::new().unwrap();
            std::fs::write(file.path(), b"archive").unwrap();
            let running = store.clone();
            let input = file.path().to_owned();
            let pending_record = record.clone();
            let attempt =
                tokio::spawn(async move { running.upload(&input, &pending_record).await }).await;
            if fault == 1 {
                assert!(attempt.unwrap_err().is_panic());
            } else {
                assert!(attempt.unwrap().is_err());
            }
            backend.fault.store(0, std::sync::atomic::Ordering::SeqCst);
            let reopened = S3BackupStore {
                store: backend.clone(),
                prefix: store.prefix.clone(),
                key: store.key,
            };
            let visible = reopened.list(Some(&BackupScope::Node)).await.unwrap();
            assert_eq!(visible.len(), usize::from(fault == 4));
            if fault == 1 || fault == 4 {
                let recovered = reopened.record(&id).await.unwrap();
                let output = tempfile::NamedTempFile::new().unwrap();
                reopened.download(&recovered, output.path()).await.unwrap();
                assert_eq!(std::fs::read(output.path()).unwrap(), b"archive");
            } else {
                assert!(reopened.record(&id).await.is_err());
                assert!(backend
                    .head(&ObjectPath::from(record.object_key.clone()))
                    .await
                    .is_err());
            }
            reopened.upload(file.path(), &record).await.unwrap();
            let published = reopened.list(Some(&BackupScope::Node)).await.unwrap();
            assert_eq!(published.len(), 1);
            assert_eq!(
                reopened.record(&published[0].id).await.unwrap().object_key,
                record.object_key
            );
        }
    }

    fn memory_store() -> S3BackupStore {
        S3BackupStore {
            store: Arc::new(object_store::memory::InMemory::new()),
            prefix: "fixture/ryu-backups/v1".into(),
            key: [7; 32],
        }
    }

    async fn fixture_record(
        store: &S3BackupStore,
        scope: BackupScope,
        legacy: bool,
    ) -> BackupRecord {
        let id = uuid::Uuid::new_v4().to_string();
        let record = BackupRecord {
            version: 1,
            id: id.clone(),
            source_node_id: "fixture-node".into(),
            scope: scope.clone(),
            created_at: "2026-10-04T00:00:00Z".into(),
            bytes: 7,
            sha256: encryption::sha256(std::io::Cursor::new(b"archive")).unwrap(),
            object_key: if legacy {
                store.object_key(&id).unwrap()
            } else {
                store.scoped_object_key(&id, &scope).unwrap()
            },
        };
        if legacy {
            let json = serde_json::to_vec(&record).unwrap();
            let mut encrypted = vec![];
            encryption::encrypt(
                json.as_slice(),
                &mut encrypted,
                json.len() as u64,
                &store.key,
            )
            .unwrap();
            store
                .store
                .put(&store.record_path(&id).unwrap(), encrypted.into())
                .await
                .unwrap();
            store
                .store
                .put(
                    &ObjectPath::from(record.object_key.clone()),
                    b"archive".to_vec().into(),
                )
                .await
                .unwrap();
        } else {
            let file = tempfile::NamedTempFile::new().unwrap();
            std::fs::write(file.path(), b"archive").unwrap();
            store.upload(file.path(), &record).await.unwrap();
        }
        record
    }

    #[tokio::test]
    async fn scopes_isolate_growth_and_retention_never_receives_a_partial_catalog() {
        let store = memory_store();
        let app = BackupScope::App {
            app_id: "fixture-app".into(),
            namespace: "snapshots".into(),
            tenant: "tenant-a".into(),
        };
        for _ in 0..3 {
            fixture_record(&store, app.clone(), false).await;
        }
        let new = fixture_record(&store, BackupScope::Node, false).await;
        let legacy = fixture_record(&store, BackupScope::Node, true).await;
        let node = store
            .list_with_limit(Some(&BackupScope::Node), 2)
            .await
            .unwrap();
        assert_eq!(node.len(), 2);
        assert!(node.iter().any(|record| record.id == new.id));
        assert!(node.iter().any(|record| record.id == legacy.id));
        assert!(store.list_with_limit(Some(&app), 2).await.is_err());
        // Foreign legacy records likewise do not consume this scope's limit.
        for _ in 0..3 {
            fixture_record(&store, app.clone(), true).await;
        }
        assert_eq!(
            store
                .list_with_limit(Some(&BackupScope::Node), 2)
                .await
                .unwrap()
                .len(),
            2
        );
    }

    #[tokio::test]
    async fn scoped_and_legacy_records_restore_by_id_and_delete_only_their_own_objects() {
        let store = memory_store();
        for legacy in [false, true] {
            let record = fixture_record(&store, BackupScope::Node, legacy).await;
            let loaded = store.record(&record.id).await.unwrap();
            assert_eq!(loaded.object_key, record.object_key);
            let target = tempfile::NamedTempFile::new().unwrap();
            store.download(&loaded, target.path()).await.unwrap();
            assert_eq!(std::fs::read(target.path()).unwrap(), b"archive");
            let mut aliased = loaded.clone();
            aliased.scope = BackupScope::Space {
                space_id: "other-space".into(),
            };
            assert!(store.delete(&aliased).await.is_err());
            assert!(store.download(&aliased, target.path()).await.is_err());
            store.delete(&loaded).await.unwrap();
            assert!(store.record(&record.id).await.is_err());
        }
    }
    #[test]
    fn validates_provider_config_and_rejects_credential_urls() {
        let mut input = SaveBackupDestination {
            name: "R2".into(),
            endpoint: "https://account.r2.cloudflarestorage.com".into(),
            bucket: "backup-bucket".into(),
            region: "auto".into(),
            prefix: "ryu/production".into(),
            path_style: true,
            allow_http: false,
            allowed_apps: vec![],
            access_key_id: "access".into(),
            secret_access_key: "secret".into(),
            session_token: None,
            recovery_key: encryption::new_key(),
        };
        validate(&input).unwrap();
        for endpoint in [
            "https://user:pass@host",
            "https://host/bucket",
            "http://host",
            "https://169.254.169.254",
            "https://host?secret=1",
        ] {
            input.endpoint = endpoint.into();
            assert!(validate(&input).is_err(), "{endpoint}");
        }
    }
}
