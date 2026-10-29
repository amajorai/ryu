//! A tool call on an app's keyless stdio MCP server wakes the app's stopped lazy
//! sidecar first, so an agent or routine does not depend on a person having the
//! app open.
use crate::sidecar::manager::{is_still_starting, SidecarManager};
use crate::sidecar::mcp::{McpRegistry, McpServerConfig};
use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

const PLUGIN: &str = "@acme/lazy-app";
const SIDECAR: &str = "@acme/lazy-app/acme-lazy-app";

struct LazyApp {
    running: Arc<AtomicBool>,
    starts: Arc<AtomicU32>,
    fail: bool,
}

impl LazyApp {
    fn new(fail: bool) -> Arc<Self> {
        Arc::new(Self {
            running: Arc::new(AtomicBool::new(false)),
            starts: Arc::new(AtomicU32::new(0)),
            fail,
        })
    }
}

impl Sidecar for LazyApp {
    fn name(&self) -> &str {
        SIDECAR
    }
    fn is_required(&self) -> bool {
        false
    }
    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let running = self.running.clone();
        let starts = self.starts.clone();
        let fail = self.fail;
        Box::pin(async move {
            starts.fetch_add(1, Ordering::SeqCst);
            if fail {
                anyhow::bail!("start refused");
            }
            running.store(true, Ordering::SeqCst);
            Ok(())
        })
    }
    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let running = self.running.clone();
        Box::pin(async move {
            running.store(false, Ordering::SeqCst);
            Ok(())
        })
    }
    fn health_check(&self) -> BoxFuture<HealthStatus> {
        Box::pin(async { HealthStatus::Healthy })
    }
    fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }
    fn port(&self) -> Option<u16> {
        None
    }
}

fn server(owner: Option<&str>) -> McpServerConfig {
    let mut config: McpServerConfig =
        serde_json::from_value(serde_json::json!({ "command": "ryu-acme-mcp" })).unwrap();
    config.owner_plugin_id = owner.map(str::to_owned);
    config
}

fn registry_with(app: &Arc<LazyApp>) -> McpRegistry {
    let manager = SidecarManager::new_noop();
    manager.register(app.clone()).unwrap();
    let registry = McpRegistry::empty();
    registry.set_sidecar_manager(manager);
    registry.set_wake_sidecars(PLUGIN, vec![SIDECAR.to_owned()]);
    registry
}

#[tokio::test]
async fn a_tool_call_wakes_the_apps_stopped_lazy_sidecar_once() {
    let app = LazyApp::new(false);
    let registry = registry_with(&app);
    assert!(!app.is_running());

    let guards = registry
        .wake_owner_sidecars(&server(Some(PLUGIN)))
        .await
        .expect("the wake succeeds");
    assert_eq!(guards.len(), 1);
    assert!(app.is_running());
    assert_eq!(app.starts.load(Ordering::SeqCst), 1);
    drop(guards);

    // Already warm: the next call starts nothing.
    registry
        .wake_owner_sidecars(&server(Some(PLUGIN)))
        .await
        .unwrap();
    assert_eq!(app.starts.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn servers_without_a_lazy_sidecar_wake_nothing() {
    let app = LazyApp::new(false);
    let registry = registry_with(&app);
    // A user-added server (no owner) and another app's server.
    for owner in [None, Some("@ryu/other")] {
        let guards = registry.wake_owner_sidecars(&server(owner)).await.unwrap();
        assert!(guards.is_empty());
    }
    assert!(!app.is_running());
    assert_eq!(app.starts.load(Ordering::SeqCst), 0);

    // No manager installed (tests, CLI): nothing to wake either.
    let bare = McpRegistry::empty();
    bare.set_wake_sidecars(PLUGIN, vec![SIDECAR.to_owned()]);
    assert!(bare
        .wake_owner_sidecars(&server(Some(PLUGIN)))
        .await
        .unwrap()
        .is_empty());

    // Forgetting the plugin (disable or uninstall) stops waking its sidecars.
    registry.set_wake_sidecars(PLUGIN, Vec::new());
    assert!(registry
        .wake_owner_sidecars(&server(Some(PLUGIN)))
        .await
        .unwrap()
        .is_empty());
    assert!(!app.is_running());
}

#[tokio::test]
async fn a_failed_wake_is_reported_instead_of_the_keyless_refusal() {
    let app = LazyApp::new(true);
    let registry = registry_with(&app);
    let Err(error) = registry.wake_owner_sidecars(&server(Some(PLUGIN))).await else {
        panic!("the sidecar cannot start");
    };
    assert!(!is_still_starting(&error));
    assert!(error.to_string().contains("failed to start"), "{error:#}");
}
