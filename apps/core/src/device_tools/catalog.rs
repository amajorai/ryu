//! The closed device-tool catalog, compiled into Core.
//!
//! Schemas and descriptions never come from the client: a phone declares only
//! which app groups it has. Canonical ids (`device.<app>.<verb>`) are used by
//! every gate, grant, policy glob, audit row and telemetry record; aliases
//! (`device_calendar_create`) exist only at the model/tool-name boundary and are
//! mapped here, in one place (design §0.10).

use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::Value;

/// The fixture shared with every client (byte-for-byte drift tests there).
pub(crate) const FIXTURE: &str =
    include_str!("../../../../packages/protocol/fixtures/device-tools-v1.json");

/// The catalog version a client must declare.
pub(crate) const CATALOG_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum VerbClass {
    Read,
    Write,
    Delete,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ToolStatus {
    /// Offered when the flag, the gate and the phone allow it.
    Available,
    /// In the closed catalog, never offered by this Core yet.
    Planned,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CatalogApp {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) platforms: Vec<String>,
    pub(crate) status: ToolStatus,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CatalogTool {
    pub(crate) id: String,
    pub(crate) alias: String,
    pub(crate) app: String,
    pub(crate) verb: VerbClass,
    pub(crate) status: ToolStatus,
    pub(crate) description: String,
    pub(crate) input_schema: Value,
    #[serde(default)]
    pub(crate) security_class_possible: bool,
}

#[derive(Debug, Deserialize)]
pub(crate) struct Catalog {
    pub(crate) version: u32,
    pub(crate) apps: Vec<CatalogApp>,
    pub(crate) tools: Vec<CatalogTool>,
}

impl Catalog {
    /// A tool by alias or canonical id.
    pub(crate) fn tool(&self, name: &str) -> Option<&CatalogTool> {
        self.tools
            .iter()
            .find(|tool| tool.alias == name || tool.id == name)
    }

    pub(crate) fn app(&self, id: &str) -> Option<&CatalogApp> {
        self.apps.iter().find(|app| app.id == id)
    }

    /// Tools this Core may offer at all (their app is available too).
    pub(crate) fn available_tools(&self) -> impl Iterator<Item = &CatalogTool> {
        self.tools.iter().filter(move |tool| {
            tool.status == ToolStatus::Available
                && self
                    .app(&tool.app)
                    .is_some_and(|app| app.status == ToolStatus::Available)
        })
    }
}

/// The compiled-in catalog. The fixture is part of the binary and covered by
/// `catalog_tests`, so a parse failure is a build defect, not a runtime input.
pub(crate) fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let catalog: Catalog =
            serde_json::from_str(FIXTURE).expect("device-tools-v1.json is a valid catalog");
        assert_eq!(
            catalog.version, CATALOG_VERSION,
            "device-tools fixture version"
        );
        catalog
    })
}

/// The canonical id for a model-facing alias or a canonical id; `None` when the
/// name is not a device tool.
pub(crate) fn canonical(name: &str) -> Option<&'static str> {
    catalog().tool(name).map(|tool| tool.id.as_str())
}

/// Whether `name` (alias or canonical id) names any catalog tool, offered or not.
/// Used to refuse device names on every ingress that is not the device lane.
pub(crate) fn is_device_tool_name(name: &str) -> bool {
    canonical(name).is_some() || name.starts_with("device.") || name.starts_with("device_")
}

/// The OpenAI function schema the model sees (alias name).
pub(crate) fn openai_tool_schema(tool: &CatalogTool) -> Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": tool.alias,
            "description": tool.description,
            "parameters": tool.input_schema,
        }
    })
}

/// Risk tags for audit and the approvals vocabulary (design §2.2).
pub(crate) fn risk_tags(tool: &CatalogTool) -> Vec<&'static str> {
    if tool.security_class_possible {
        return vec!["device.home.security", "physical"];
    }
    if tool.app == "alarms" {
        return vec!["device.write"];
    }
    match tool.verb {
        VerbClass::Read => vec!["device.read", "personal_data"],
        VerbClass::Write => vec!["device.write", "personal_data"],
        VerbClass::Delete => vec!["device.delete", "personal_data"],
    }
}

/// Tools that can never be "always allowed" (design §2.4 step 6).
pub(crate) fn never_persistable(tool: &CatalogTool) -> bool {
    tool.verb == VerbClass::Delete || tool.id == "device.home.set"
}
