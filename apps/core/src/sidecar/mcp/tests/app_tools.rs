//! Tests moved out of `sidecar/mcp/mod.rs`.

use super::*;
use crate::sidecar::mcp::tests::derived_route;

/// One derived row. Only `id`/`plugin_id` matter to the storage paths below.
fn ext_row(id: &str, plugin: &str) -> crate::ext_api::ExtApiRoute {
    crate::ext_api::ExtApiRoute {
        id: id.to_owned(),
        plugin_id: plugin.to_owned(),
        method: "GET".to_owned(),
        url: format!("core:/api/ext/{plugin}/thing"),
        name: "Do the thing".to_owned(),
        description: None,
        header_params: vec![],
        input_schema: serde_json::json!({ "type": "object", "properties": {} }),
    }
}

fn ext_rows(plugin: &str, tag: &str, n: usize) -> Vec<crate::ext_api::ExtApiRoute> {
    (0..n)
        .map(|i| ext_row(&format!("ryu_ext.{tag}.get_op_{i:03}"), plugin))
        .collect()
}

/// Re-keying the store per SIDECAR must not turn the per-PLUGIN exposure cap into
/// a per-sidecar one — that would let any app buy an extra 60 searchable rows by
/// splitting its surface across two sidecars, which is a manifest edit, not a
/// review step. So the budget is summed across the plugin's other sidecars.
///
/// The second half is the part that is easy to get wrong in the other direction:
/// the sum deliberately EXCLUDES the key being written, because those rows are
/// about to be replaced. Counting them would make a sidecar shrink on every
/// re-wake (60 → 0) for no reason a user could see.
#[tokio::test]
async fn the_per_plugin_cap_is_shared_across_a_plugins_sidecars() {
    let reg = McpRegistry::empty();
    let alpha = "@ryu/split/alpha";
    let beta = "@ryu/split/beta";
    let take = EXT_API_PER_PLUGIN_CAP - 20; // 40 of 60

    reg.set_ext_api_routes_for_sidecar("@ryu/split", alpha, ext_rows("@ryu/split", "a", take));
    reg.set_ext_api_routes_for_sidecar("@ryu/split", beta, ext_rows("@ryu/split", "b", take));

    let rows = reg
        .search_scoped("thing", Some(catalog::ToolKind::ExtApi), 1000, &[])
        .await;
    assert_eq!(
        rows.len(),
        EXT_API_PER_PLUGIN_CAP,
        "two sidecars of one plugin share ONE per-plugin budget: {} + {} must land on \
         the cap, not on double it",
        take,
        take
    );
    // …and the truncation kept the first N of the loser, not zero of it: a sidecar
    // silently latched at zero rows is the failure this arithmetic can produce.
    assert!(
        reg.describe("ryu_ext.b.get_op_000").await.is_some(),
        "the second sidecar must keep the budget that was left, not be zeroed"
    );
    assert!(reg.describe("ryu_ext.a.get_op_000").await.is_some());

    // Re-storing the FIRST sidecar unchanged must not shrink it: its own previous
    // rows are being replaced and must not be counted against its own budget.
    reg.set_ext_api_routes_for_sidecar("@ryu/split", alpha, ext_rows("@ryu/split", "a", take));
    assert!(
        reg.describe(&format!("ryu_ext.a.get_op_{:03}", take - 1))
            .await
            .is_some(),
        "a re-wake must not shrink a sidecar that fit a moment ago"
    );
}

/// `clear_ext_api_routes` drops the owner's rows AND re-arms the lowering guard.
///
/// This is the registry half of `clear_ext_api_routes_runs_on_deactivate`. The
/// call site itself — one statement at the top of `deactivate_plugin`, and one in
/// `update_app_handler` — is verified by compilation rather than by a test,
/// because reaching either would mean standing up a whole `ServerState` (app
/// store, manifest store, realtime bus, sidecar manager); a fake of that shape
/// would be asserting about the fake. What is genuinely at risk is the behaviour
/// below: that a clear both removes the rows and lets the next Healthy edge
/// re-lower, which is what makes a disabled-then-re-enabled app pick up its
/// CURRENT spec rather than the one from boot.
#[tokio::test]
async fn clear_ext_api_routes_runs_on_deactivate() {
    let reg = McpRegistry::empty();
    reg.set_ext_api_routes(
        "@ryu/crm",
        vec![derived_route("ryu_ext.ryu_crm.get_records", "@ryu/crm")],
    );
    reg.set_ext_api_routes(
        "@ryu/news",
        vec![derived_route("ryu_ext.ryu_news.get_items", "@ryu/news")],
    );
    assert!(reg.has_ext_api_routes("@ryu/crm"));

    reg.clear_ext_api_routes("@ryu/crm");
    assert!(
        !reg.has_ext_api_routes("@ryu/crm"),
        "clearing must re-arm the lowering guard, not just empty the rows"
    );
    assert!(
        reg.ext_api_route("ryu_ext.ryu_crm.get_records").is_none(),
        "the disabled app's derived tool must stop resolving"
    );
    // Ownership-scoped: the map is keyed by owner, so a clear can never reach
    // another app's rows the way an id-matching `retain` over one flat bag could.
    assert!(
        reg.ext_api_route("ryu_ext.ryu_news.get_items").is_some(),
        "another plugin's derived tools must survive"
    );
}

#[tokio::test]
async fn unregister_app_tool_makes_it_uncallable() {
    let reg = McpRegistry::empty();
    reg.register_app_tool("app.foo.bar".into(), "foo.bar".into(), None);
    reg.seed_widget_tool_for_test("app", "foo.bar", "ui://widget/foo.html");
    reg.unregister_app_tool("app.foo.bar");
    let err = reg
        .call_tool("app.foo.bar", serde_json::json!({}), None)
        .await
        .expect_err("unregistered app tool must be uncallable");
    assert!(err.to_string().contains("unknown app tool"), "got: {err}");
    assert!(
        reg.widget_resource("app", "ui://widget/foo.html")
            .await
            .is_none(),
        "unregistering an app tool must invalidate its cached widget"
    );
}

// ── plugin-tools: net-new tool backends (inline_js + http) ────────────────
