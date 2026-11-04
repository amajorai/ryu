use crate::server::output_styles_routes;
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use tower::ServiceExt;

/// A user-root styles dir with one style in it, plus a selection file beside it,
/// with both env overrides pointed at them. `RYU_OUTPUT_STYLES_DIR` also
/// SUPPRESSES the project/managed tiers, which is what stops the scan from
/// picking up whatever `.claude/output-styles` happens to sit above the
/// checkout the tests run in.
fn styles_fixture() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("tempdir");
    let styles = dir.path().join("output-styles");
    std::fs::create_dir_all(&styles).expect("styles dir");
    std::fs::write(
        styles.join("eli5.md"),
        "---\nname: ELI5\ndescription: keep it simple pls\nkeep-coding-instructions: true\n---\n\nTalk to me like I'm 5.\n",
    )
    .expect("style file");
    std::env::set_var(ryu_output_styles::ENV_OUTPUT_STYLES_DIR, &styles);
    std::env::set_var(
        ryu_output_styles::ENV_SELECTION_FILE,
        dir.path().join("output-style.json"),
    );
    // The registry loads the disk tier ONCE, at first publication, so the second
    // test to run would otherwise still be looking at the first one's (deleted)
    // tempdir. Re-scanning here makes each test independent of the order they
    // happen to run in.
    crate::server::output_style_registry().reload();
    dir
}

// NOTE: the two env vars are deliberately NOT restored when a test ends. Removing
// them would hand any later test in this binary the developer's real
// `~/.claude/output-styles` and `~/.ryu/output-style.json`; leaving them pointed
// at a deleted tempdir cannot touch anything that matters.

/// A fresh router per call, because `oneshot` consumes the service — which also
/// proves the mount is stateless: every request re-enters through the same
/// process-global registry rather than one long-lived instance's captured state.
fn app() -> Router {
    output_styles_routes::<()>()
}

async fn call(method: &str, path: &str, body: Option<&str>) -> serde_json::Value {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .body(body.map_or_else(Body::empty, |b| Body::from(b.to_owned())))
        .expect("request builds");
    let res = app()
        .oneshot(request)
        .await
        .expect("the router is infallible");
    assert_eq!(res.status(), StatusCode::OK, "unexpected status for {path}");
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .expect("body reads");
    serde_json::from_slice(&bytes).expect("the response is JSON")
}

/// List → select → list: the store tab's whole loop. `active` is the field the
/// tab maps `installed: "active"` onto, so a selection that does not come back
/// flagged renders the current style as "Not added" on every reload.
#[tokio::test]
async fn selecting_a_style_makes_the_next_list_report_it_active() {
    let _guard = ryu_output_styles::OUTPUT_STYLES_ENV_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let _dir = styles_fixture();

    // Nothing selected on a fresh node — design §8's "the feature is inert until
    // a user picks one".
    let listed = call("GET", "/api/output-styles", None).await;
    assert!(listed["selected"].is_null(), "fresh node has no selection");
    let rows = listed["styles"].as_array().expect("styles is an array");
    assert_eq!(rows.len(), 1, "the fixture's one style is listed: {rows:?}");
    assert_eq!(rows[0]["id"], "eli5");
    assert_eq!(rows[0]["name"], "ELI5");
    assert_eq!(rows[0]["active"], false);

    let selected = call(
        "POST",
        "/api/output-styles/select",
        Some(r#"{"style_id":"eli5"}"#),
    )
    .await;
    assert_eq!(selected["success"], true);
    assert_eq!(selected["selected"], "eli5");

    let relisted = call("GET", "/api/output-styles", None).await;
    assert_eq!(relisted["selected"], "eli5");
    let rows = relisted["styles"].as_array().expect("styles is an array");
    assert_eq!(rows[0]["active"], true);
    // Not forced: a user selection and a plugin's `force-for-plugin` are
    // different claims, and the picker explains the second one differently.
    assert_eq!(rows[0]["forced"], false);
    assert!(relisted["forced"].is_null());
}

/// Selecting an id no style has must 404 rather than persist: a silently stored
/// dangling id resolves to no style on every later turn while the picker keeps
/// showing a selection.
#[tokio::test]
async fn selecting_an_unknown_style_is_refused_and_changes_nothing() {
    let _guard = ryu_output_styles::OUTPUT_STYLES_ENV_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let _dir = styles_fixture();

    let res = app()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/output-styles/select")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"style_id":"no-such-style"}"#))
                .expect("request builds"),
        )
        .await
        .expect("the router is infallible");
    assert_eq!(res.status(), StatusCode::NOT_FOUND);

    let listed = call("GET", "/api/output-styles", None).await;
    assert!(
        listed["selected"].is_null(),
        "the refusal persisted nothing"
    );
}
