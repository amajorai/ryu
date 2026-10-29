use super::*;

use serde_json::{json, Value};

use crate::sidecar::mcp::RegistryTool;

// ── Tool definitions ──────────────────────────────────────────────────────────

/// The tools exposed through the self-build provider. Each maps to a
/// `dispatch` branch below.
pub fn tools() -> Vec<RegistryTool> {
    vec![
        RegistryTool {
            id: "ryu_self_build.scaffold_runnable".to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "scaffold_runnable".to_owned(),
            description: Some(
                "Scaffold a new Runnable (agent, workflow, skill, tool) and write its \
                 ryu.json manifest to the Ryu apps directory. The manifest is hot-installed \
                 so it appears in GET /api/apps without restarting Core. \
                 Required: id (reverse-domain, e.g. com.example.my-agent), name, kind \
                 (agent|workflow|skill|tool|companion|channel|engine|policy), version (semver). \
                 Optional: description, permission_grants (list of grant strings)."
                    .to_owned(),
            ),
            input_schema: Some(scaffold_runnable_schema()),
            ..Default::default()
        },
        RegistryTool {
            id: "ryu_self_build.install_app".to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "install_app".to_owned(),
            description: Some(
                "Install (register as installed) a Runnable app that has already been \
                 scaffolded via scaffold_runnable. Creates a lifecycle record so the app \
                 appears as installed in GET /api/apps. Requires the app to exist as a \
                 ryu.json in the apps directory. Required: id (the app's reverse-domain id)."
                    .to_owned(),
            ),
            input_schema: Some(install_app_schema()),
            ..Default::default()
        },
        RegistryTool {
            id: "ryu_self_build.write_ryu_json".to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "write_ryu_json".to_owned(),
            description: Some(
                "Write an arbitrary ryu.json manifest object to a named app directory \
                 under the Ryu apps dir and hot-reload it. Use this for advanced manifests \
                 that scaffold_runnable cannot express (e.g. multi-runnable bundles, companions). \
                 The id field in the manifest must match the app_id parameter. \
                 Required: app_id (reverse-domain, used as the directory name), manifest (JSON object)."
                    .to_owned(),
            ),
            input_schema: Some(write_ryu_json_schema()),
            ..Default::default()
        },
        RegistryTool {
            id: "ryu_self_build.write_tool".to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "write_tool".to_owned(),
            description: Some(
                "Author a deterministic tool: write the body, its case table, and a sealed \
                 manifest to the plugins dir so the AI can iterate on it. The tool is NOT yet \
                 callable — call verify_tool (the determinism gate) and then install_tool to \
                 make it live. The body is a pure JS FRAGMENT over `input` and `host` ending in \
                 `return <result>`: no import/export, no Date.now(), Math.random(), fetch, or \
                 process.env (verify_tool rejects all of those). Required: id (reverse-domain), \
                 slug, body, description, input_schema (JSON Schema object), cases (>=3 case \
                 objects, each {name, input, expect|expectError, host?})."
                    .to_owned(),
            ),
            input_schema: Some(write_tool_schema()),
            ..Default::default()
        },
        RegistryTool {
            id: "ryu_self_build.verify_tool".to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "verify_tool".to_owned(),
            description: Some(
                "The determinism gate for a tool written by write_tool. Runs, in order: a \
                 static purity scan (rejects Date.now/Math.random/fetch/process/import/export/...), \
                 a manifest contract check (routable + tool:execute granted + no drift between the \
                 body file and the sealed manifest), a case-table shape check (>=3, unique names, \
                 one expectation each), and then every case TWICE in the deny-all sandbox with \
                 all nondeterminism shadowed — the two runs must deep-equal and match the declared \
                 expectation. Returns a structured report; passed=false names exactly what to fix. \
                 Required: id."
                    .to_owned(),
            ),
            input_schema: Some(tool_id_schema("verify")),
            ..Default::default()
        },
        RegistryTool {
            id: "ryu_self_build.install_tool".to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "install_tool".to_owned(),
            description: Some(
                "Make a self-built tool callable: re-runs the verify_tool determinism gate and \
                 REFUSES if it does not pass, then hot-installs the manifest so the tool appears \
                 in GET /api/apps and is routable. This is the only path that makes a tool the AI \
                 authored live — write_tool alone never exposes one. Required: id."
                    .to_owned(),
            ),
            input_schema: Some(tool_id_schema("install")),
            ..Default::default()
        },
    ]
}

fn scaffold_runnable_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "id": {
                "type": "string",
                "description": "Reverse-domain app id (e.g. com.example.my-agent). Used as the directory name."
            },
            "name": { "type": "string", "description": "Human-readable display name." },
            "kind": {
                "type": "string",
                "enum": ["agent", "workflow", "skill", "tool", "companion", "channel", "engine", "policy"],
                "description": "Runnable kind."
            },
            "version": {
                "type": "string",
                "description": "Semver version string (e.g. 1.0.0)."
            },
            "description": {
                "type": "string",
                "description": "Optional human-readable description of what this Runnable does."
            },
            "permission_grants": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Optional list of permission grant strings the app declares it needs."
            }
        },
        "required": ["id", "name", "kind", "version"]
    })
}

fn install_app_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "id": {
                "type": "string",
                "description": "The reverse-domain app id to install (must have a ryu.json on disk)."
            }
        },
        "required": ["id"]
    })
}

fn write_ryu_json_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "app_id": {
                "type": "string",
                "description": "Reverse-domain app id (used as the subdirectory name). Must match manifest.id."
            },
            "manifest": {
                "type": "object",
                "description": "Full ryu.json manifest object. Must include id, name, version, runnables."
            }
        },
        "required": ["app_id", "manifest"]
    })
}

fn write_tool_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "id": {
                "type": "string",
                "description": "Reverse-domain tool id (e.g. com.acme.invoice-total). Used as the plugins-dir subdirectory name."
            },
            "slug": {
                "type": "string",
                "description": "Short callable name matching [a-z0-9][a-z0-9_.-]* — becomes the tool id the model routes on."
            },
            "body": {
                "type": "string",
                "description": "The tool body: a pure JS FRAGMENT over `input` and `host`, ending in `return <result>`. No import/export, no Date.now()/Math.random()/fetch/process.env."
            },
            "description": {
                "type": "string",
                "description": "One line on what the tool does — the model routes on it. No TODO placeholders."
            },
            "input_schema": {
                "type": "object",
                "description": "JSON Schema for the tool's arguments (type object, properties, required)."
            },
            "cases": {
                "type": "array",
                "description": "At least 3 test cases: each {name, input, expect | expectError | expectImpure, host?, expectCalls?}. expect pins the return value; expectCalls pins the exact host.* effect sequence."
            }
        },
        "required": ["id", "slug", "body", "description", "input_schema", "cases"]
    })
}

/// The `{ id }` schema shared by verify_tool and install_tool.
fn tool_id_schema(verb: &str) -> Value {
    json!({
        "type": "object",
        "properties": {
            "id": {
                "type": "string",
                "description": format!("The tool id to {verb} (must exist on disk from write_tool).")
            }
        },
        "required": ["id"]
    })
}
