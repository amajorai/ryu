//! Manifest → **API-surface projection** for the store's detail page.
//!
//! A plugin manifest already declares everything a reader needs to answer "what
//! does installing this actually add to my machine?" — the runnables it bundles,
//! the commands it puts in the palette, the MCP servers it registers, the HTTP
//! routes its sidecar exposes, the events that wake it, the permissions it wants.
//! Today the store shows a flat list of runnable *kinds*. This module projects the
//! manifest onto the structured, tab-shaped payload the detail page renders as its
//! API-reference / Includes / Dependencies tabs.
//!
//! # Why a projection and not "serve the manifest"
//!
//! The manifest is the wrong thing to hand a renderer verbatim. It carries
//! `ui_code` / `backend_code` (whole programs), `*_sha256` integrity bindings, and
//! — for a community listing — arbitrary attacker-authored JSON. So this is an
//! **allowlist projection**, matching the posture of
//! [`manifest_display_fields`](super::github_topic::manifest_display_fields):
//!
//! - Only named keys are read; everything else is dropped.
//! - Every string is length-capped ([`MAX_TEXT`] / [`MAX_NAME`]) and every list is
//!   count-capped ([`MAX_ITEMS`]), so a hostile manifest cannot push megabytes
//!   into a detail response.
//! - Every URL crosses [`super::github_topic::sanitize_url`] before it can reach
//!   an `href`.
//! - No code field is ever read, by construction: no branch below names one.
//!
//! The projection is **total** — a manifest missing every optional key yields an
//! object with empty lists, never an error. It runs against untrusted third-party
//! JSON as often as against a first-party fixture, so a malformed value must
//! degrade to "absent", never to a failed detail fetch.

use serde_json::{Map, Value};

/// Cap on a description-shaped string.
const MAX_TEXT: usize = 600;
/// Cap on a name/id-shaped string.
const MAX_NAME: usize = 200;
/// Cap on the length of any projected list.
const MAX_ITEMS: usize = 200;

/// The browser-hosted, mobile, and extension clients reuse the desktop shell's
/// contribution contract. This is a host relationship, not a claim that the
/// package contains desktop code, so it belongs in the catalog projection rather
/// than in a plugin's executable manifest fields.
const WRAPPED_SURFACES: [(&str, &str); 3] = [
    ("extension", "desktop"),
    ("mobile", "desktop"),
    ("web", "desktop"),
];

/// The known surface order used when a legacy manifest omits both `surfaces` and
/// `targets`. Core treats that omission as "all surfaces"; spelling it out in a
/// detail payload makes the old default visible without changing its semantics.
const KNOWN_SURFACES: [&str; 8] = [
    "gateway",
    "core",
    "desktop",
    "island",
    "mobile",
    "extension",
    "web",
    "cli",
];

/// Trim, cap, and drop-if-empty a string field.
fn text(value: Option<&Value>, max: usize) -> Option<String> {
    let raw = value?.as_str()?.trim();
    if raw.is_empty() {
        return None;
    }
    Some(if raw.len() <= max {
        raw.to_string()
    } else {
        let mut end = max;
        while end > 0 && !raw.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}…", &raw[..end])
    })
}

fn text_value(value: Option<&Value>, max: usize) -> Value {
    text(value, max).map_or(Value::Null, Value::String)
}

/// Read a capped array of strings (each trimmed, empties dropped).
fn string_list(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|v| text(Some(v), MAX_NAME))
                .take(MAX_ITEMS)
                .map(Value::String)
                .collect()
        })
        .unwrap_or_default()
}

/// Return the wrapper parent for a supported surface, when the parent is also
/// supported by the same listing. A package can still explicitly target Mobile
/// or Web without Desktop, so the parent is only shown when the listing has a
/// real Desktop row to inherit from.
fn wrapped_parent(surface: &str, supported: &std::collections::BTreeSet<String>) -> Option<Value> {
    WRAPPED_SURFACES
        .iter()
        .find(|(child, parent)| *child == surface && supported.contains(*parent))
        .map(|(_, parent)| Value::String((*parent).to_owned()))
}

/// Project the manifest's support map into a renderer-safe list. The list keeps
/// the support level instead of flattening it to a platform badge, and records
/// the shared-shell relationship for the browser extension, mobile, and hosted
/// web clients.
pub(crate) fn project_surface_support(manifest: &Value) -> Vec<Value> {
    let Some(obj) = manifest.as_object() else {
        return Vec::new();
    };

    let mut declared: Vec<(String, String)> = Vec::new();
    if let Some(map) = obj.get("surfaces").and_then(Value::as_object) {
        for (surface, entry) in map.iter().take(MAX_ITEMS) {
            let support = text(entry.get("support"), MAX_NAME);
            if let Some(support) = support {
                if support.eq_ignore_ascii_case("none") {
                    continue;
                }
                declared.push((surface.clone(), support));
            }
        }
    } else if let Some(targets) = obj.get("targets").and_then(Value::as_array) {
        if targets.is_empty() {
            declared.extend(
                KNOWN_SURFACES
                    .iter()
                    .map(|surface| ((*surface).to_owned(), "legacy".to_owned())),
            );
        } else {
            for target in targets.iter().take(MAX_ITEMS) {
                if let Some(surface) = text(Some(target), MAX_NAME) {
                    declared.push((surface, "supported".to_owned()));
                }
            }
        }
    } else {
        // `surfaces` absent and `targets` absent/empty is the legacy all-surfaces
        // default. Do not make that compatibility rule disappear from the detail
        // view merely because the old manifest did not have a support block.
        declared.extend(
            KNOWN_SURFACES
                .iter()
                .map(|surface| ((*surface).to_owned(), "legacy".to_owned())),
        );
    }

    let supported = declared
        .iter()
        .map(|(surface, _)| surface.clone())
        .collect::<std::collections::BTreeSet<_>>();

    declared
        .into_iter()
        .map(|(surface, support)| {
            let mut item = serde_json::Map::new();
            item.insert("surface".to_owned(), Value::String(surface.clone()));
            item.insert("support".to_owned(), Value::String(support));
            if let Some(parent) = wrapped_parent(&surface, &supported) {
                item.insert("inheritedFrom".to_owned(), parent);
            }
            Value::Object(item)
        })
        .collect()
}

/// Insert one feature into a grouped extension summary, preserving declaration
/// order and bounding every untrusted string before it reaches a catalog client.
fn add_grouped_feature(
    groups: &mut Vec<(String, String, Vec<String>)>,
    target: &str,
    label: &str,
    feature: Option<String>,
) {
    let Some(feature) = feature.filter(|value| !value.is_empty()) else {
        return;
    };
    let Some((_, _, features)) = groups.iter_mut().find(|(id, _, _)| id == target) else {
        groups.push((target.to_owned(), label.to_owned(), vec![feature]));
        return;
    };
    if !features.contains(&feature) && features.len() < MAX_ITEMS {
        features.push(feature);
    }
}

fn capability_extension_target(capability: &str) -> (&'static str, &'static str) {
    if capability.starts_with("browser.") {
        ("browser", "Browser")
    } else if capability.starts_with("computer.") || capability.starts_with("desktop.") {
        ("computer", "Computer")
    } else if capability.starts_with("web.") {
        ("web", "Web")
    } else if capability.starts_with("document.") {
        ("documents", "Document pipeline")
    } else {
        ("core", "Core capability")
    }
}

/// Project what the package extends. Capabilities come from the manifest's
/// existing `provides` contract; host-rendered contributions are grouped as the
/// shared Ryu shell. Nothing here grants access or changes dispatch — it is a
/// safe catalog explanation of declarations Core already enforces elsewhere.
fn project_extensions(manifest: &Value) -> Vec<Value> {
    let Some(obj) = manifest.as_object() else {
        return Vec::new();
    };
    let mut groups: Vec<(String, String, Vec<String>)> = Vec::new();

    if let Some(provides) = obj.get("provides").and_then(Value::as_array) {
        for entry in provides.iter().take(MAX_ITEMS) {
            let Some(capability) = text(entry.get("capability"), MAX_NAME) else {
                continue;
            };
            let (target, label) = capability_extension_target(&capability);
            let feature = text(entry.get("title"), MAX_TEXT)
                .map(|title| format!("{title} ({capability})"))
                .or(Some(capability));
            add_grouped_feature(&mut groups, target, label, feature);
        }
    }

    // Inline tools, agents, workflows, skills, and policies extend Core's
    // registries even when they do not publish a swappable capability through
    // `provides`. Keep that fact visible instead of making the Extensions section
    // look empty for the most common plugin shape.
    if let Some(runnables) = obj.get("runnables").and_then(Value::as_array) {
        for runnable in runnables.iter().take(MAX_ITEMS) {
            let Some(kind) = text(runnable.get("kind"), MAX_NAME) else {
                continue;
            };
            if !kind.eq_ignore_ascii_case("companion") {
                add_grouped_feature(
                    &mut groups,
                    "core",
                    "Core runtime",
                    Some(format!("{kind} runnable")),
                );
            }
        }
    }
    if obj
        .get("mcp_servers")
        .and_then(Value::as_object)
        .is_some_and(|servers| !servers.is_empty())
    {
        add_grouped_feature(
            &mut groups,
            "core",
            "Core runtime",
            Some("MCP servers".to_owned()),
        );
    }

    const SHELL_CONTRIBUTIONS: [(&str, &str); 14] = [
        ("views", "host-rendered views"),
        ("dock_panels", "dock panels"),
        ("sidebar_sections", "sidebar sections"),
        ("sidebar_buttons", "sidebar buttons"),
        ("sidebar_modes", "sidebar modes"),
        ("settings_tabs", "settings tabs"),
        ("composer_controls", "composer controls"),
        ("widgets", "inline widgets"),
        ("chat_widget_templates", "chat widget prompts"),
        ("live_activities", "live activities"),
        ("message_actions", "message actions"),
        ("selection_actions", "selection actions"),
        ("context_menu_items", "context-menu actions"),
        ("themes", "themes"),
    ];
    if let Some(contributes) = obj.get("contributes").and_then(Value::as_object) {
        for (key, label) in SHELL_CONTRIBUTIONS {
            if contributes
                .get(key)
                .and_then(Value::as_array)
                .is_some_and(|items| !items.is_empty())
            {
                add_grouped_feature(
                    &mut groups,
                    "ryu-shell",
                    "Shared Ryu shell",
                    Some(label.to_owned()),
                );
            }
        }

        const CORE_CONTRIBUTIONS: [(&str, &str); 3] = [
            ("turn_hooks", "turn hooks"),
            ("hook_events", "app events"),
            ("tool_filters", "tool filters"),
        ];
        for (key, label) in CORE_CONTRIBUTIONS {
            if contributes
                .get(key)
                .and_then(Value::as_array)
                .is_some_and(|items| !items.is_empty())
            {
                add_grouped_feature(&mut groups, "core", "Core runtime", Some(label.to_owned()));
            }
        }
    }

    groups
        .into_iter()
        .map(|(target, label, features)| {
            serde_json::json!({
                "target": target,
                "label": label,
                "features": features,
            })
        })
        .collect()
}

/// Project the implementation boundaries visible from a manifest. This is an
/// ownership explanation, not a source-file inventory: Core hosts the runtime
/// contract, the shared shell renders declared UI slots, and the package owns
/// any managed process it ships.
fn project_implementation(manifest: &Value) -> Vec<Value> {
    let Some(obj) = manifest.as_object() else {
        return Vec::new();
    };
    let mut groups: Vec<(String, String, Vec<String>)> = Vec::new();

    if let Some(runnables) = obj.get("runnables").and_then(Value::as_array) {
        for runnable in runnables.iter().take(MAX_ITEMS) {
            let Some(kind) = text(runnable.get("kind"), MAX_NAME) else {
                continue;
            };
            if kind.eq_ignore_ascii_case("companion") {
                add_grouped_feature(
                    &mut groups,
                    "shared-shell",
                    "Shared Ryu shell",
                    Some("companion UI".to_owned()),
                );
            } else {
                add_grouped_feature(
                    &mut groups,
                    "core",
                    "Core runtime",
                    Some(format!("{kind} runnable")),
                );
            }
        }
    }

    if let Some(contributes) = obj.get("contributes").and_then(Value::as_object) {
        for key in ["turn_hooks", "hook_events", "tool_filters"] {
            if contributes
                .get(key)
                .and_then(Value::as_array)
                .is_some_and(|items| !items.is_empty())
            {
                add_grouped_feature(
                    &mut groups,
                    "core",
                    "Core runtime",
                    Some(
                        match key {
                            "turn_hooks" => "turn hooks",
                            "hook_events" => "app events",
                            _ => "tool filters",
                        }
                        .to_owned(),
                    ),
                );
            }
        }
    }

    if obj
        .get("mcp_servers")
        .and_then(Value::as_object)
        .is_some_and(|servers| !servers.is_empty())
    {
        add_grouped_feature(
            &mut groups,
            "core",
            "Core runtime",
            Some("MCP registration".to_owned()),
        );
    }
    if obj
        .get("provides")
        .and_then(Value::as_array)
        .is_some_and(|entries| !entries.is_empty())
    {
        add_grouped_feature(
            &mut groups,
            "core",
            "Core runtime",
            Some("capability broker".to_owned()),
        );
    }

    if let Some(contributes) = obj.get("contributes").and_then(Value::as_object) {
        for (key, label) in [
            ("views", "host-rendered views"),
            ("dock_panels", "dock panels"),
            ("sidebar_sections", "sidebar sections"),
            ("sidebar_buttons", "sidebar buttons"),
            ("settings_tabs", "settings tabs"),
            ("composer_controls", "composer controls"),
            ("widgets", "inline widgets"),
            ("themes", "themes"),
        ] {
            if contributes
                .get(key)
                .and_then(Value::as_array)
                .is_some_and(|items| !items.is_empty())
            {
                add_grouped_feature(
                    &mut groups,
                    "shared-shell",
                    "Shared Ryu shell",
                    Some(label.to_owned()),
                );
            }
        }
    }

    if let Some(sidecars) = obj.get("sidecars").and_then(Value::as_array) {
        for sidecar in sidecars.iter().take(MAX_ITEMS) {
            let name = text(sidecar.get("name"), MAX_NAME);
            add_grouped_feature(
                &mut groups,
                "sidecar",
                "Package sidecar",
                name.map(|value| format!("{value} process")),
            );
        }
    }

    groups
        .into_iter()
        .map(|(layer, label, features)| {
            serde_json::json!({
                "layer": layer,
                "label": label,
                "features": features,
            })
        })
        .collect()
}

/// Project one `runnables[]` entry. `config` is deliberately NOT copied: it is the
/// per-kind blob that carries tool backends (inline code, URLs) and is the one
/// place a manifest hides executable payload.
fn runnable_entry(raw: &Value) -> Option<Value> {
    let obj = raw.as_object()?;
    let id = text(obj.get("id"), MAX_NAME);
    let name = text(obj.get("name"), MAX_NAME);
    if id.is_none() && name.is_none() {
        return None;
    }
    Some(serde_json::json!({
        "id": id.clone().or_else(|| name.clone()),
        "name": name.or(id),
        "kind": text_value(obj.get("kind"), MAX_NAME),
        "description": text_value(obj.get("description"), MAX_TEXT),
    }))
}

/// Project the `contributes.<surface>` id-reference lists, resolving each id back
/// to its runnable so the tab can show a name and description rather than a bare
/// id. An id with no matching runnable still renders (the loader cross-validates
/// first-party manifests, but a community one may dangle).
fn contribution_list(raw: Option<&Value>, runnables: &[Value]) -> Vec<Value> {
    let Some(items) = raw.and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .take(MAX_ITEMS)
        .filter_map(|item| {
            // A ContributionId is `{ id }`, but tolerate a bare string.
            let id = item
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .or_else(|| text(item.get("id"), MAX_NAME))?;
            let matched = runnables
                .iter()
                .find(|r| r.get("id").and_then(Value::as_str) == Some(id.as_str()));
            Some(serde_json::json!({
                "id": id,
                "name": matched
                    .and_then(|r| r.get("name").cloned())
                    .unwrap_or(Value::Null),
                "description": matched
                    .and_then(|r| r.get("description").cloned())
                    .unwrap_or(Value::Null),
            }))
        })
        .collect()
}

/// Project the declared stdio MCP servers. The `env` map is summarized to its KEY
/// names only — the values are frequently secrets-by-convention and have no place
/// in a public listing.
fn mcp_servers(raw: Option<&Value>) -> Vec<Value> {
    let Some(obj) = raw.and_then(Value::as_object) else {
        return Vec::new();
    };
    obj.iter()
        .take(MAX_ITEMS)
        .map(|(name, decl)| {
            let env_keys: Vec<Value> = decl
                .get("env")
                .and_then(Value::as_object)
                .map(|env| {
                    env.keys()
                        .take(MAX_ITEMS)
                        .map(|k| Value::String(k.clone()))
                        .collect()
                })
                .unwrap_or_default();
            serde_json::json!({
                "name": name,
                "command": text_value(decl.get("command"), MAX_NAME),
                "args": string_list(decl.get("args")),
                "description": text_value(decl.get("description"), MAX_TEXT),
                "enabled": decl.get("enabled").and_then(Value::as_bool).unwrap_or(true),
                "envKeys": Value::Array(env_keys),
            })
        })
        .collect()
}

/// Project the managed sidecars, including the HTTP routes each exposes. The
/// route list is the honest answer to "what network surface does this app add?",
/// so it is surfaced verbatim (paths and methods only — never the process spec,
/// which names binaries and download URLs).
fn sidecars(raw: Option<&Value>) -> Vec<Value> {
    let Some(items) = raw.and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .take(MAX_ITEMS)
        .filter_map(|spec| {
            let name = text(spec.get("name"), MAX_NAME)?;
            let http = spec.get("http");
            let routes: Vec<Value> = http
                .and_then(|h| h.get("routes"))
                .and_then(Value::as_array)
                .map(|rs| {
                    rs.iter()
                        .take(MAX_ITEMS)
                        .filter_map(|r| {
                            let path = text(r.get("path"), MAX_NAME)?;
                            Some(serde_json::json!({
                                "path": path,
                                "methods": string_list(r.get("methods")),
                                "auth": text_value(r.get("auth"), MAX_NAME),
                            }))
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(serde_json::json!({
                "name": name,
                "port": spec.get("port").and_then(Value::as_u64),
                "lazy": spec.get("lazy").and_then(Value::as_bool).unwrap_or(false),
                "mount": text_value(http.and_then(|h| h.get("mount")), MAX_NAME),
                "publicMount": text_value(http.and_then(|h| h.get("public_mount")), MAX_NAME),
                "routes": Value::Array(routes),
            }))
        })
        .collect()
}

/// Project provider declarations without exposing the sidecar process or code.
/// A provider-backed sidecar can hold a user's live subscription credential and
/// see the traffic routed through it, so the desktop enable confirmation needs a
/// stable, non-executable disclosure of what it serves.
fn model_providers(raw: Option<&Value>) -> Vec<Value> {
    let Some(items) = raw.and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .take(MAX_ITEMS)
        .filter_map(|spec| {
            let provider = spec.get("provides_provider")?.as_object()?;
            let id = text(provider.get("id"), MAX_NAME)?;
            Some(serde_json::json!({
                "id": id,
                "label": text_value(provider.get("label"), MAX_TEXT),
                "api": text_value(provider.get("api"), MAX_NAME),
                "models": Value::Array(string_list(provider.get("models"))),
            }))
        })
        .collect()
}

/// Project the declarative UI contributions (views + settings tabs). Only the
/// identifying/labelling keys are lifted; the render payload stays behind.
fn ui_contributions(raw: Option<&Value>, id_key: &str, title_key: &str) -> Vec<Value> {
    let Some(items) = raw.and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .take(MAX_ITEMS)
        .filter_map(|item| {
            let id = text(item.get(id_key), MAX_NAME);
            let title = text(item.get(title_key), MAX_NAME);
            if id.is_none() && title.is_none() {
                return None;
            }
            Some(serde_json::json!({
                "id": id.clone().or_else(|| title.clone()),
                "title": title.or(id),
                "surface": text_value(item.get("surface"), MAX_NAME),
                "icon": text_value(item.get("icon"), MAX_NAME),
            }))
        })
        .collect()
}

/// Project the capabilities this plugin **serves** to other plugins through the
/// broker — the provider half of the dependency graph.
fn provides(raw: Option<&Value>) -> Vec<Value> {
    let Some(items) = raw.and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .take(MAX_ITEMS)
        .filter_map(|entry| {
            let capability = text(entry.get("capability"), MAX_NAME)?;
            Some(serde_json::json!({
                "capability": capability,
                "sidecar": text_value(entry.get("sidecar"), MAX_NAME),
                "route": text_value(entry.get("route"), MAX_NAME),
            }))
        })
        .collect()
}

/// Summarize the typed runtime permission set into a rendered-ready shape. The
/// point of the summary is the *breadth* question the health checks ask: does this
/// plugin want the whole filesystem, unrestricted network, arbitrary subprocesses?
fn permission_summary(raw: Option<&Value>) -> Value {
    let Some(obj) = raw.and_then(Value::as_object) else {
        // Absent = deny-all, which is a real and *good* answer — distinct from a
        // plugin that declared a broad set. Say so explicitly.
        return serde_json::json!({ "declared": false });
    };
    let list = |key: &str| -> Value {
        match obj.get(key) {
            Some(Value::Bool(b)) => Value::Bool(*b),
            Some(Value::Array(_)) => Value::Array(string_list(obj.get(key))),
            Some(Value::Object(o)) => {
                let mut out = Map::new();
                for (k, v) in o.iter().take(MAX_ITEMS) {
                    match v {
                        Value::Bool(b) => {
                            out.insert(k.clone(), Value::Bool(*b));
                        }
                        Value::Array(_) => {
                            out.insert(k.clone(), Value::Array(string_list(Some(v))));
                        }
                        Value::String(_) => {
                            out.insert(k.clone(), text_value(Some(v), MAX_NAME));
                        }
                        _ => {}
                    }
                }
                Value::Object(out)
            }
            _ => Value::Null,
        }
    };
    serde_json::json!({
        "declared": true,
        "fs": list("fs"),
        "network": list("network"),
        "childProcess": list("child_process"),
        "tool": list("tool"),
    })
}

/// Project a manifest onto the detail-payload keys the store's tabs read.
///
/// Returns camelCase keys to merge into a detail object (the detail contract is
/// camelCase; the card contract is snake_case — see the casing note on
/// `PluginCatalogDetail`). The returned map always contains `apiSurface`; the
/// governance keys appear only when the manifest declares them, so merging never
/// overwrites a value another enrichment step already resolved.
pub(crate) fn project_manifest(manifest: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(obj) = manifest.as_object() else {
        return out;
    };

    let runnables: Vec<Value> = obj
        .get("runnables")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .take(MAX_ITEMS)
                .filter_map(runnable_entry)
                .collect()
        })
        .unwrap_or_default();

    let contributes = obj.get("contributes");
    let c = |key: &str| contribution_list(contributes.and_then(|v| v.get(key)), &runnables);

    let turn_hooks: Vec<Value> = contributes
        .and_then(|v| v.get("turn_hooks"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .take(MAX_ITEMS)
                .filter_map(|h| {
                    // `code` is never read — only the event that fires it.
                    let event = text(h.get("event"), MAX_NAME)?;
                    Some(serde_json::json!({
                        "event": event,
                        "id": text_value(h.get("id"), MAX_NAME),
                        "description": text_value(h.get("description"), MAX_TEXT),
                    }))
                })
                .collect()
        })
        .unwrap_or_default();

    let composer_controls: Vec<Value> = contributes
        .and_then(|v| v.get("composer_controls"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .take(MAX_ITEMS)
                .filter_map(|w| {
                    let id = text(w.get("id"), MAX_NAME);
                    let label = text(w.get("label"), MAX_NAME);
                    if id.is_none() && label.is_none() {
                        return None;
                    }
                    Some(serde_json::json!({
                        "id": id.clone().or_else(|| label.clone()),
                        "label": label.or(id),
                        "type": text_value(w.get("type"), MAX_NAME),
                    }))
                })
                .collect()
        })
        .unwrap_or_default();

    out.insert(
        "apiSurface".to_string(),
        serde_json::json!({
            "runnables": Value::Array(runnables.clone()),
            "commands": Value::Array(c("commands")),
            "tools": Value::Array(c("tools")),
            "agents": Value::Array(c("agents")),
            "workflows": Value::Array(c("workflows")),
            "policies": Value::Array(c("policies")),
            "mcpServers": Value::Array(mcp_servers(obj.get("mcp_servers"))),
            "sidecars": Value::Array(sidecars(obj.get("sidecars"))),
            "modelProviders": Value::Array(model_providers(obj.get("sidecars"))),
            "views": Value::Array(ui_contributions(
                contributes.and_then(|v| v.get("views")),
                "id",
                "title",
            )),
            "settingsTabs": Value::Array(ui_contributions(
                contributes.and_then(|v| v.get("settings_tabs")),
                "id",
                "title",
            )),
            "composerControls": Value::Array(composer_controls),
            "provides": Value::Array(provides(obj.get("provides"))),
            "triggers": serde_json::json!({
                "activationEvents": Value::Array(string_list(obj.get("activation_events"))),
                "turnHooks": Value::Array(turn_hooks),
            }),
        }),
    );

    // These three summaries answer different questions and deliberately stay
    // separate: support is where a listing appears, extensions are what it adds
    // to an existing host capability, and implementation is the ownership seam
    // that carries the work.
    out.insert(
        "surfaceSupport".to_owned(),
        Value::Array(project_surface_support(manifest)),
    );
    out.insert(
        "extensions".to_owned(),
        Value::Array(project_extensions(manifest)),
    );
    out.insert(
        "implementation".to_owned(),
        Value::Array(project_implementation(manifest)),
    );

    // ── Governance keys (only when declared) ──────────────────────────────────
    let grants = string_list(obj.get("permission_grants"));
    if !grants.is_empty() {
        out.insert("permissionGrants".to_string(), Value::Array(grants));
    }
    if obj.contains_key("permissions") {
        out.insert(
            "permissions".to_string(),
            permission_summary(obj.get("permissions")),
        );
    }
    if let Some(engines) = obj.get("engines").filter(|v| v.is_object()) {
        out.insert(
            "engines".to_string(),
            serde_json::json!({ "ryu": text_value(engines.get("ryu"), MAX_NAME) }),
        );
    }
    let surfaces: Vec<Value> = obj
        .get("surfaces")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .take(MAX_ITEMS)
                // An explicit `"none"` support level means the surface is declared
                // AND unsupported — it must not be listed as a platform.
                .filter(|(_, entry)| entry.get("support").and_then(Value::as_str) != Some("none"))
                .map(|(k, _)| Value::String(k.clone()))
                .collect()
        })
        .unwrap_or_else(|| string_list(obj.get("targets")));
    if !surfaces.is_empty() {
        out.insert("surfaces".to_string(), Value::Array(surfaces));
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn surface(manifest: Value) -> Value {
        project_manifest(&manifest)
            .get("apiSurface")
            .cloned()
            .expect("apiSurface is always projected")
    }

    #[test]
    fn projection_is_total_for_a_bare_manifest() {
        let s = surface(serde_json::json!({ "id": "com.x.y", "name": "Y" }));
        assert_eq!(s["runnables"], serde_json::json!([]));
        assert_eq!(s["mcpServers"], serde_json::json!([]));
        assert_eq!(s["triggers"]["activationEvents"], serde_json::json!([]));
    }

    #[test]
    fn non_object_manifest_projects_nothing() {
        assert!(project_manifest(&Value::String("nope".into())).is_empty());
    }

    #[test]
    fn runnable_config_is_never_copied() {
        let s = surface(serde_json::json!({
            "runnables": [{
                "id": "t1", "name": "Tool One", "kind": "tool",
                "config": { "backend": { "inline_deno": { "code": "await evil()" } } },
            }],
        }));
        let json = serde_json::to_string(&s).expect("serializes");
        assert!(
            !json.contains("evil"),
            "runnable config must not travel: {json}"
        );
        assert_eq!(s["runnables"][0]["kind"], "tool");
    }

    #[test]
    fn contributions_resolve_names_from_runnables() {
        let s = surface(serde_json::json!({
            "runnables": [{ "id": "cmd.open", "name": "Open Thing", "kind": "command",
                            "description": "Opens the thing." }],
            "contributes": { "commands": [{ "id": "cmd.open" }] },
        }));
        assert_eq!(s["commands"][0]["name"], "Open Thing");
        assert_eq!(s["commands"][0]["description"], "Opens the thing.");
    }

    #[test]
    fn dangling_contribution_id_still_renders() {
        let s = surface(serde_json::json!({
            "contributes": { "tools": [{ "id": "ghost.tool" }] },
        }));
        assert_eq!(s["tools"][0]["id"], "ghost.tool");
        assert_eq!(s["tools"][0]["name"], Value::Null);
    }

    #[test]
    fn mcp_server_env_values_are_never_surfaced() {
        let s = surface(serde_json::json!({
            "mcp_servers": {
                "notion": { "command": "npx", "args": ["-y", "notion-mcp"],
                            "env": { "NOTION_TOKEN": "secret-abc123" } },
            },
        }));
        let json = serde_json::to_string(&s).expect("serializes");
        assert!(
            !json.contains("secret-abc123"),
            "env values must not travel: {json}"
        );
        assert_eq!(s["mcpServers"][0]["envKeys"][0], "NOTION_TOKEN");
        assert_eq!(s["mcpServers"][0]["command"], "npx");
    }

    #[test]
    fn sidecar_routes_are_surfaced_without_the_process_spec() {
        let s = surface(serde_json::json!({
            "sidecars": [{
                "name": "api", "port": 8099,
                "process": { "node": { "entry": "server.js" } },
                "http": {
                    "public_mount": "/api/mail",
                    "routes": [{ "path": "/status", "methods": ["GET"], "auth": "user" }],
                },
            }],
        }));
        assert_eq!(s["sidecars"][0]["publicMount"], "/api/mail");
        assert_eq!(s["sidecars"][0]["routes"][0]["path"], "/status");
        let json = serde_json::to_string(&s).expect("serializes");
        assert!(
            !json.contains("server.js"),
            "process spec must not travel: {json}"
        );
    }

    #[test]
    fn provider_declaration_is_surfaced_for_consent_without_process_details() {
        let s = surface(serde_json::json!({
            "sidecars": [{
                "name": "bridge",
                "process": { "kind": "node", "entry": "backend.js" },
                "provides_provider": {
                    "id": "chatgpt-bridge",
                    "label": "ChatGPT subscription",
                    "api": "openai-completions",
                    "models": ["gpt-5"]
                }
            }]
        }));
        assert_eq!(s["modelProviders"][0]["id"], "chatgpt-bridge");
        assert_eq!(s["modelProviders"][0]["label"], "ChatGPT subscription");
        assert_eq!(s["modelProviders"][0]["models"][0], "gpt-5");
        let json = serde_json::to_string(&s).expect("serializes");
        assert!(
            !json.contains("backend.js"),
            "provider disclosure must not carry process details: {json}"
        );
    }

    #[test]
    fn turn_hook_code_is_never_copied() {
        let s = surface(serde_json::json!({
            "contributes": {
                "turn_hooks": [{ "event": "post_assistant_turn", "code": "steal()" }],
            },
        }));
        assert_eq!(
            s["triggers"]["turnHooks"][0]["event"],
            "post_assistant_turn"
        );
        let json = serde_json::to_string(&s).expect("serializes");
        assert!(
            !json.contains("steal()"),
            "hook code must not travel: {json}"
        );
    }

    #[test]
    fn absent_permissions_report_deny_all_not_unknown() {
        let projected = project_manifest(&serde_json::json!({ "id": "a" }));
        assert!(
            !projected.contains_key("permissions"),
            "an undeclared permission set is absent, not a fabricated empty one"
        );
        let declared = project_manifest(&serde_json::json!({
            "permissions": { "network": true, "fs": { "read": ["~/x"] } },
        }));
        assert_eq!(declared["permissions"]["declared"], true);
        assert_eq!(declared["permissions"]["network"], true);
        assert_eq!(declared["permissions"]["fs"]["read"][0], "~/x");
    }

    #[test]
    fn surfaces_map_wins_over_legacy_targets_and_drops_none() {
        let projected = project_manifest(&serde_json::json!({
            "targets": ["desktop"],
            "surfaces": {
                "desktop": { "support": "full" },
                "island":  { "support": "none" },
                "mobile":  { "support": "partial" },
            },
        }));
        let surfaces = projected["surfaces"].as_array().expect("surfaces list");
        let names: Vec<&str> = surfaces.iter().filter_map(Value::as_str).collect();
        assert!(names.contains(&"desktop") && names.contains(&"mobile"));
        assert!(
            !names.contains(&"island"),
            "an unsupported surface is not a platform"
        );
    }

    #[test]
    fn surface_support_keeps_levels_and_marks_shared_shell_wrappers() {
        let projected = project_manifest(&serde_json::json!({
            "surfaces": {
                "desktop": { "support": "full" },
                "mobile": { "support": "limited" },
                "web": { "support": "full" },
                "extension": { "support": "none" }
            }
        }));
        assert_eq!(
            projected["surfaceSupport"],
            serde_json::json!([
                { "surface": "desktop", "support": "full" },
                { "surface": "mobile", "support": "limited", "inheritedFrom": "desktop" },
                { "surface": "web", "support": "full", "inheritedFrom": "desktop" }
            ])
        );
    }

    #[test]
    fn extension_and_implementation_projection_separates_browser_shell_and_core() {
        let projected = project_manifest(&serde_json::json!({
            "runnables": [
                { "id": "browser-tool", "name": "Browser", "kind": "tool" },
                { "id": "browser-panel", "name": "Browser", "kind": "companion" }
            ],
            "provides": [
                { "capability": "browser.control", "version": "1.0.0", "title": "Browser" }
            ],
            "contributes": {
                "dock_panels": [{ "id": "browser" }],
                "turn_hooks": [{ "event": "context" }]
            },
            "sidecars": [{ "name": "browser" }]
        }));
        assert_eq!(
            projected["extensions"][0],
            serde_json::json!({
                "target": "browser",
                "label": "Browser",
                "features": ["Browser (browser.control)"]
            })
        );
        let extension_targets: Vec<&str> = projected["extensions"]
            .as_array()
            .expect("extensions")
            .iter()
            .filter_map(|entry| entry["target"].as_str())
            .collect();
        assert!(extension_targets.contains(&"ryu-shell"));
        assert!(extension_targets.contains(&"core"));
        let layers: Vec<&str> = projected["implementation"]
            .as_array()
            .expect("implementation")
            .iter()
            .filter_map(|entry| entry["layer"].as_str())
            .collect();
        assert_eq!(layers, vec!["core", "shared-shell", "sidecar"]);
    }

    #[test]
    fn legacy_targets_are_used_when_no_surfaces_map_exists() {
        let projected = project_manifest(&serde_json::json!({ "targets": ["cli", "browser"] }));
        assert_eq!(projected["surfaces"], serde_json::json!(["cli", "browser"]));
    }

    #[test]
    fn long_strings_are_capped() {
        let s = surface(serde_json::json!({
            "runnables": [{ "id": "x", "description": "d".repeat(MAX_TEXT * 3) }],
        }));
        let description = s["runnables"][0]["description"].as_str().expect("present");
        assert!(
            description.len() <= MAX_TEXT + 4,
            "got {}",
            description.len()
        );
    }

    #[test]
    fn lists_are_count_capped() {
        let many: Vec<Value> = (0..(MAX_ITEMS + 50))
            .map(|i| serde_json::json!({ "id": format!("r{i}") }))
            .collect();
        let s = surface(serde_json::json!({ "runnables": many }));
        assert_eq!(s["runnables"].as_array().expect("array").len(), MAX_ITEMS);
    }
}
