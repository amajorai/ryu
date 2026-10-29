//! Built-in device capability tools (`device.<device_key>__<capability>`).
//!
//! Paired Ryu hardware on a secure (RHP v1.1) session registers a capability
//! table (`capabilities_register`, validated by [`ryu_hardware::capability`]).
//! This reserved registry server exposes one agent tool per connected
//! (device, capability) pair and dispatches calls to the device through
//! [`ryu_hardware::session::live::invoke`] (RHP v1.1 design §6.4).
//!
//! Registered as a reserved registry server (`device`) like `notify`, so the
//! `<server>.<tool>` id scheme, per-agent allowlist and single `call_tool` entry
//! all work, the `input_schema` survives (unlike `register_app_tool`), and no
//! plugin can shadow the name.
//!
//! ## Gates
//!
//! Checked on every listing AND again on every dispatch (dispatch is the
//! revocation point):
//!
//! - the node is personal (not managed, not shared): device tools act on the
//!   owner's physical hardware;
//! - the Hardware app (`@ryu/hardware`) is enabled;
//! - the device prefs allow it: `capabilities_enabled != false`, then
//!   `capabilities[name]`, else the default `!sensitive`;
//! - the device is connected over a secure session.
//!
//! Results are device-provided data and are returned as such; arguments and
//! results are never logged.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};

use ryu_hardware::capability::{self, ValidCapability};
use ryu_hardware::protocol::device_type_str;
use ryu_hardware::session::live::{self, LiveCapabilities};
use ryu_hardware::DeviceStore;

use super::RegistryTool;

/// Reserved registry server name for device capability tools.
pub const SERVER_NAME: &str = "device";

/// Audit target for device capability calls.
const AUDIT: &str = "hardware.capability";

/// An async check that the Hardware app is enabled, evaluated per call.
pub type AppEnabledCheck =
    Arc<dyn Fn() -> Pin<Box<dyn Future<Output = bool> + Send>> + Send + Sync>;

/// What the device tools need from Core: the device registry (for prefs and
/// names) and the Hardware app's enabled bit.
#[derive(Clone)]
pub struct DeviceToolCtx {
    pub store: DeviceStore,
    pub app_enabled: AppEnabledCheck,
}

impl DeviceToolCtx {
    /// The production context: the app is enabled only when the plugin store
    /// holds an enabled `@ryu/hardware` record.
    pub fn new(store: DeviceStore, apps: crate::plugins::PluginStore) -> Self {
        let app_enabled: AppEnabledCheck = Arc::new(move || {
            let apps = apps.clone();
            Box::pin(async move {
                matches!(
                    apps.get(crate::plugins::builtins::HARDWARE_PLUGIN_ID).await,
                    Ok(Some(record)) if record.enabled
                )
            })
        });
        Self { store, app_enabled }
    }
}

static CTX: OnceLock<DeviceToolCtx> = OnceLock::new();

/// Install the process-wide context (once, at boot). Until then the server lists
/// no tools and refuses every call.
pub fn install(ctx: DeviceToolCtx) {
    if CTX.set(ctx).is_err() {
        tracing::warn!(target: "hardware", "device tool context installed twice; keeping the first");
    }
}

/// Whether this node is personal (not managed and not shared), computed like
/// the agent-configuration gate.
fn node_is_personal() -> bool {
    let managed = crate::sidecar::control_plane::is_managed_node();
    let personal = crate::sidecar::control_plane::registered_node()
        .is_some_and(|node| node.scope == crate::sidecar::control_plane::NodeScope::Personal);
    let shared = crate::sidecar::control_plane::registered_org().is_some() && !personal;
    crate::runnable::agent_configuration_policy::require_personal_node(managed, shared).is_ok()
}

/// The device tools currently callable.
pub async fn tools() -> Vec<RegistryTool> {
    match CTX.get() {
        Some(ctx) => tools_with(ctx, node_is_personal()).await,
        None => Vec::new(),
    }
}

/// Dispatch one device tool call (`tool` is the name without the `device.` prefix).
pub async fn dispatch(tool: &str, arguments: Value, agent_id: Option<&str>) -> Result<Value> {
    let ctx = CTX.get().ok_or_else(|| {
        anyhow!("device tools are unavailable: the hardware registry is not ready")
    })?;
    dispatch_with(ctx, node_is_personal(), tool, arguments, agent_id).await
}

/// Whether the node-level gates (personal node, Hardware app) pass.
async fn node_gates(ctx: &DeviceToolCtx, personal: bool) -> Result<()> {
    if !personal {
        bail!("device tools are available only on a personal node");
    }
    if !(ctx.app_enabled)().await {
        bail!("device tools are unavailable: the Hardware app is disabled");
    }
    Ok(())
}

/// The registry tool for one live capability.
fn registry_tool(
    live: &LiveCapabilities,
    device_name: &str,
    device_type: &str,
    cap: &ValidCapability,
) -> RegistryTool {
    RegistryTool {
        id: capability::tool_id(&live.device_id, &cap.name),
        server: SERVER_NAME.to_owned(),
        name: capability::tool_name(&live.device_id, &cap.name),
        description: Some(format!(
            "[Device-provided by {device_name} ({device_type})] {}",
            cap.description
        )),
        input_schema: Some(capability::to_json_schema(cap)),
        ..Default::default()
    }
}

/// [`tools`] over an explicit context and node scope.
pub async fn tools_with(ctx: &DeviceToolCtx, personal: bool) -> Vec<RegistryTool> {
    if node_gates(ctx, personal).await.is_err() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for live in live::capabilities().await {
        if !live.meta.secure {
            continue;
        }
        let Ok(Some(record)) = ctx.store.get(&live.device_id).await else {
            continue;
        };
        if !capability::capabilities_enabled(&record.prefs) {
            continue;
        }
        let device_type = device_type_str(record.device_type);
        for cap in &live.caps {
            if capability::capability_enabled(&record.prefs, &cap.name, cap.sensitive) {
                out.push(registry_tool(&live, &record.name, device_type, cap));
            }
        }
    }
    out
}

/// Find the live (device, capability) a tool name refers to.
async fn resolve(tool: &str) -> Option<(LiveCapabilities, ValidCapability)> {
    for live in live::capabilities().await {
        if let Some(cap) = live
            .caps
            .iter()
            .find(|cap| capability::tool_name(&live.device_id, &cap.name) == tool)
            .cloned()
        {
            return Some((live, cap));
        }
    }
    None
}

/// [`dispatch`] over an explicit context and node scope.
pub async fn dispatch_with(
    ctx: &DeviceToolCtx,
    personal: bool,
    tool: &str,
    arguments: Value,
    agent_id: Option<&str>,
) -> Result<Value> {
    node_gates(ctx, personal).await?;
    let (live, cap) = resolve(tool)
        .await
        .ok_or_else(|| anyhow!("unknown device tool '{tool}' (the device may be offline)"))?;
    if !live.meta.secure {
        bail!("not_secure: device tools need a secure session");
    }
    let record = ctx
        .store
        .get(&live.device_id)
        .await?
        .ok_or_else(|| anyhow!("revoked: the device is no longer paired"))?;
    if !capability::capability_enabled(&record.prefs, &cap.name, cap.sensitive) {
        bail!("disabled: device capability '{}' is turned off", cap.name);
    }

    let started = Instant::now();
    let outcome = live::invoke(
        &live.device_id,
        &cap.name,
        arguments,
        Duration::from_millis(u64::from(cap.timeout_ms)),
    )
    .await;
    tracing::info!(
        target: AUDIT,
        device = %live.device_id,
        capability = %cap.name,
        agent = agent_id.unwrap_or("-"),
        duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        outcome = outcome.as_ref().map_or_else(|e| e.code(), |_| "ok"),
        "device capability call"
    );
    match outcome {
        Ok(result) => Ok(json!({
            "ok": true,
            "device": live.device_id,
            "capability": cap.name,
            "result": result,
            "provenance": "device_provided_data",
        })),
        Err(error) => Err(anyhow!(
            "device capability '{}' failed ({}): {error}",
            cap.name,
            error.code()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ryu_hardware::identity::PlaintextSealerForTests;
    use ryu_hardware::protocol::{DeviceType, RhpServerMsg};
    use ryu_hardware::session::live::{LiveHandle, LiveMeta};
    use ryu_hardware::store::{hash_token, DeviceRecord, PROTOCOL_LEVEL_SECURE};
    use std::sync::atomic::{AtomicBool, Ordering};

    const CAPABILITY_VECTORS: &str = include_str!(
        "../../../../../crates/core/hardware/tests/vectors/rhp_v1_1_capabilities.json"
    );

    fn ctx_with(app_enabled: Arc<AtomicBool>) -> DeviceToolCtx {
        let path = std::env::temp_dir()
            .join(format!("ryu-core-device-tool-{}", uuid::Uuid::new_v4()))
            .join("hardware.db");
        let store = DeviceStore::open(path).unwrap();
        store.set_key_sealer(Arc::new(PlaintextSealerForTests));
        DeviceToolCtx {
            store,
            app_enabled: Arc::new(move || {
                let enabled = app_enabled.load(Ordering::SeqCst);
                Box::pin(async move { enabled })
            }),
        }
    }

    fn unique_id() -> String {
        format!("rhw_{}", &uuid::Uuid::new_v4().simple().to_string()[..12])
    }

    fn cap(name: &str, sensitive: bool) -> ValidCapability {
        capability::validate_descriptor(&json!({
            "name": name,
            "description": format!("Run {name}"),
            "params": { "required": {}, "optional": {
                "seconds": { "type": "integer", "description": "How long", "min": 1, "max": 10 }
            } },
            "timeout_ms": 1000,
            "sensitive": sensitive,
        }))
        .unwrap()
    }

    /// Pair a secure device row with `prefs` and register a live connection.
    async fn connect(
        ctx: &DeviceToolCtx,
        prefs: Value,
        secure: bool,
        caps: Vec<ValidCapability>,
    ) -> (String, LiveHandle) {
        let device_id = unique_id();
        let mut record = DeviceRecord {
            // Pinned keys are UNIQUE per node: derive one from the id.
            noise_pubkey: Some(ryu_hardware::pair_crypto::b64u_encode(&<[u8; 32]>::from(
                <sha2::Sha256 as sha2::Digest>::digest(device_id.as_bytes()),
            ))),
            protocol_level: PROTOCOL_LEVEL_SECURE,
            ..DeviceRecord::new_legacy(
                device_id.clone(),
                DeviceType::Watch,
                "Kitchen Watch",
                hash_token(&format!("t-{device_id}")),
                1,
            )
        };
        record.prefs = prefs;
        ctx.store.insert(record).await.unwrap();
        let (tx, _rx) = tokio::sync::mpsc::channel(8);
        let handle = live::register(
            &device_id,
            tx,
            LiveMeta {
                name: "Kitchen Watch".into(),
                device_type: DeviceType::Watch,
                secure,
                relay: false,
            },
        )
        .await;
        live::set_capabilities(&device_id, handle.generation, 1, caps).await;
        (device_id, handle)
    }

    fn names_for(tools: &[RegistryTool], device_id: &str) -> Vec<String> {
        let prefix = format!("{}__", capability::device_key(device_id));
        let mut names: Vec<String> = tools
            .iter()
            .filter(|tool| tool.name.starts_with(&prefix))
            .map(|tool| tool.name.clone())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn tool_names_match_the_shared_vectors() {
        let vectors: Value = serde_json::from_str(CAPABILITY_VECTORS).unwrap();
        let cases = vectors["tool_names"].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let device_id = case["device_id"].as_str().unwrap();
            let capability_name = case["capability"].as_str().unwrap();
            assert_eq!(
                capability::tool_name(device_id, capability_name),
                case["tool_name"].as_str().unwrap()
            );
            let id = capability::tool_id(device_id, capability_name);
            assert_eq!(id, case["tool_id"].as_str().unwrap());
            assert_eq!(
                id,
                format!("{SERVER_NAME}.{}", case["tool_name"].as_str().unwrap())
            );
            assert!(id.len() <= 63);
        }
    }

    #[tokio::test]
    async fn lists_enabled_capabilities_with_schema_and_provenance() {
        let ctx = ctx_with(Arc::new(AtomicBool::new(true)));
        let (device_id, handle) = connect(
            &ctx,
            json!({}),
            true,
            vec![cap("device.status", false), cap("camera.capture", true)],
        )
        .await;
        let tools = tools_with(&ctx, true).await;
        // The sensitive capability is hidden by default.
        assert_eq!(
            names_for(&tools, &device_id),
            [capability::tool_name(&device_id, "device.status")]
        );
        let tool = tools
            .iter()
            .find(|t| t.name == capability::tool_name(&device_id, "device.status"))
            .unwrap();
        assert_eq!(tool.server, SERVER_NAME);
        assert_eq!(tool.id, capability::tool_id(&device_id, "device.status"));
        assert_eq!(
            tool.description.as_deref(),
            Some("[Device-provided by Kitchen Watch (watch)] Run device.status")
        );
        let schema = tool.input_schema.as_ref().unwrap();
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["properties"]["seconds"]["maximum"], 10);
        live::unregister(&device_id, handle.generation).await;
    }

    #[tokio::test]
    async fn prefs_gate_listing_per_device_and_per_capability() {
        let ctx = ctx_with(Arc::new(AtomicBool::new(true)));
        let (opted_in, a) = connect(
            &ctx,
            json!({ "capabilities": { "camera.capture": true, "device.status": false } }),
            true,
            vec![cap("device.status", false), cap("camera.capture", true)],
        )
        .await;
        let (switched_off, b) = connect(
            &ctx,
            json!({ "capabilities_enabled": false }),
            true,
            vec![cap("device.status", false)],
        )
        .await;
        let tools = tools_with(&ctx, true).await;
        assert_eq!(
            names_for(&tools, &opted_in),
            [capability::tool_name(&opted_in, "camera.capture")]
        );
        assert!(names_for(&tools, &switched_off).is_empty());

        // Dispatch re-checks the prefs (the revocation point).
        let error = dispatch_with(
            &ctx,
            true,
            &capability::tool_name(&opted_in, "device.status"),
            json!({}),
            None,
        )
        .await
        .unwrap_err();
        assert!(error.to_string().starts_with("disabled"), "{error}");
        live::unregister(&opted_in, a.generation).await;
        live::unregister(&switched_off, b.generation).await;
    }

    #[tokio::test]
    async fn node_and_app_gates_hide_and_refuse_everything() {
        let app = Arc::new(AtomicBool::new(true));
        let ctx = ctx_with(Arc::clone(&app));
        let (device_id, handle) =
            connect(&ctx, json!({}), true, vec![cap("device.status", false)]).await;
        let tool = capability::tool_name(&device_id, "device.status");

        // Not a personal node.
        assert!(tools_with(&ctx, false).await.is_empty());
        let error = dispatch_with(&ctx, false, &tool, json!({}), None)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("personal node"), "{error}");

        // Hardware app disabled.
        app.store(false, Ordering::SeqCst);
        assert!(tools_with(&ctx, true).await.is_empty());
        let error = dispatch_with(&ctx, true, &tool, json!({}), None)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("Hardware app"), "{error}");
        live::unregister(&device_id, handle.generation).await;
    }

    #[tokio::test]
    async fn legacy_connections_expose_no_tools() {
        let ctx = ctx_with(Arc::new(AtomicBool::new(true)));
        let (device_id, handle) =
            connect(&ctx, json!({}), false, vec![cap("device.status", false)]).await;
        assert!(names_for(&tools_with(&ctx, true).await, &device_id).is_empty());
        let error = dispatch_with(
            &ctx,
            true,
            &capability::tool_name(&device_id, "device.status"),
            json!({}),
            None,
        )
        .await
        .unwrap_err();
        assert!(error.to_string().starts_with("not_secure"), "{error}");
        live::unregister(&device_id, handle.generation).await;
    }

    #[tokio::test]
    async fn unknown_tool_is_an_error() {
        let ctx = ctx_with(Arc::new(AtomicBool::new(true)));
        let error = dispatch_with(&ctx, true, "nobody__device-status", json!({}), None)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("unknown device tool"), "{error}");
    }

    #[tokio::test]
    async fn dispatch_invokes_the_device_and_wraps_the_result() {
        let ctx = ctx_with(Arc::new(AtomicBool::new(true)));
        let (device_id, mut handle) =
            connect(&ctx, json!({}), true, vec![cap("device.identify", false)]).await;
        let generation = handle.generation;
        let fake_device_id = device_id.clone();
        // A fake device: answer the first invoke with a result, the second with an
        // error.
        let fake_device = tokio::spawn(async move {
            let mut answered = 0;
            while let Some(msg) = handle.ctrl_rx.recv().await {
                let RhpServerMsg::CapabilityInvoke {
                    request_id,
                    name,
                    args,
                    ..
                } = msg
                else {
                    continue;
                };
                let outcome = if answered == 0 {
                    Ok(json!({ "identified": name, "seconds": args["seconds"] }))
                } else {
                    live::result_outcome(
                        false,
                        None,
                        Some(ryu_hardware::protocol::CapabilityErrorBody {
                            code: "busy".into(),
                            message: "already beeping".into(),
                        }),
                    )
                };
                live::complete(&fake_device_id, generation, &request_id, outcome).await;
                answered += 1;
                if answered == 2 {
                    break;
                }
            }
        });

        let tool = capability::tool_name(&device_id, "device.identify");
        let value = dispatch_with(&ctx, true, &tool, json!({ "seconds": 3 }), Some("agent-1"))
            .await
            .unwrap();
        assert_eq!(value["ok"], true);
        assert_eq!(value["device"], device_id.as_str());
        assert_eq!(value["capability"], "device.identify");
        assert_eq!(value["result"]["identified"], "device.identify");
        assert_eq!(value["result"]["seconds"], 3);

        let error = dispatch_with(&ctx, true, &tool, json!({}), None)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("(busy)"), "{error}");

        // Invalid arguments never reach the device.
        let error = dispatch_with(&ctx, true, &tool, json!({ "seconds": 99 }), None)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("invalid_args"), "{error}");

        fake_device.await.unwrap();
        live::unregister(&device_id, generation).await;
    }
}
