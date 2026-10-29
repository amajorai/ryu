//! Connector imports against a mocked transport. Live round-trips to Notion,
//! Google Drive, Confluence, and GitHub are not exercised here.

use std::{collections::HashMap, sync::Mutex};

use base64::Engine as _;
use serde_json::json;

use super::*;

#[derive(Default)]
struct MockHttp {
    routes: HashMap<(HttpMethod, String), HttpReply>,
    requests: Mutex<Vec<HttpRequest>>,
}

impl MockHttp {
    fn get(mut self, url: &str, reply: HttpReply) -> Self {
        self.routes.insert((HttpMethod::Get, url.to_owned()), reply);
        self
    }

    fn post(mut self, url: &str, reply: HttpReply) -> Self {
        self.routes
            .insert((HttpMethod::Post, url.to_owned()), reply);
        self
    }

    fn recorded(&self) -> Vec<HttpRequest> {
        self.requests.lock().expect("lock").clone()
    }
}

#[async_trait::async_trait]
impl ImportHttp for MockHttp {
    async fn send(&self, request: &HttpRequest) -> Result<HttpReply, String> {
        self.requests.lock().expect("lock").push(request.clone());
        Ok(self
            .routes
            .get(&(request.method, request.url.clone()))
            .cloned()
            .unwrap_or(HttpReply {
                status: 404,
                body: b"not found".to_vec(),
                ..HttpReply::default()
            }))
    }
}

fn json_reply(value: serde_json::Value) -> HttpReply {
    HttpReply {
        status: 200,
        content_type: "application/json".to_owned(),
        location: None,
        body: value.to_string().into_bytes(),
    }
}

fn text_reply(body: &str, content_type: &str) -> HttpReply {
    HttpReply {
        status: 200,
        content_type: content_type.to_owned(),
        location: None,
        body: body.as_bytes().to_vec(),
    }
}

fn redirect(status: u16, location: &str) -> HttpReply {
    HttpReply {
        status,
        location: Some(location.to_owned()),
        ..HttpReply::default()
    }
}

fn header<'a>(request: &'a HttpRequest, name: &str) -> Option<&'a str> {
    request
        .headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

fn body(value: serde_json::Value) -> ConnectorImportBody {
    serde_json::from_value(value).expect("valid body")
}

fn token(value: &str) -> ConnectorCredential {
    ConnectorCredential {
        token: value.to_owned(),
        base_url: None,
        email: None,
    }
}

fn names(fetched: &Fetched) -> Vec<String> {
    fetched
        .sources
        .iter()
        .map(|source| source.name.clone())
        .collect()
}

fn text_of(source: &ImportSource) -> String {
    String::from_utf8(source.bytes.clone()).expect("utf-8")
}

// ── Validation ───────────────────────────────────────────────────────────────

#[test]
fn validation_requires_provider_fields_and_vault_references() {
    let cases = [
        (json!({ "provider": "dropbox" }), "provider must be"),
        (json!({ "provider": "web" }), "at least one URL"),
        (
            json!({ "provider": "web", "urls": ["http://example.com"] }),
            "must use https",
        ),
        (
            json!({ "provider": "web", "urls": ["https://u:p@example.com"] }),
            "embed credentials",
        ),
        (
            json!({ "provider": "web", "urls": ["https://example.com"], "credential": "secret:X" }),
            "do not take a credential",
        ),
        (
            json!({ "provider": "notion", "page_ids": ["0123456789abcdef0123456789abcdef"] }),
            "need a credential",
        ),
        (
            json!({ "provider": "notion", "credential": "ntn_raw_token", "page_ids": ["0123456789abcdef0123456789abcdef"] }),
            "must be a vault reference",
        ),
        (
            json!({ "provider": "notion", "credential": "secret:NOTION_TOKEN", "page_ids": ["nope"] }),
            "not a Notion id",
        ),
        (
            json!({ "provider": "github", "repo": "../etc" }),
            "owner/name",
        ),
        (
            json!({ "provider": "github", "repo": "a/b", "path": "docs/../.." }),
            "must not contain",
        ),
        (
            json!({ "provider": "confluence", "credential": "secret:C", "page_ids": ["12/../3"] }),
            "numeric",
        ),
        (
            json!({ "provider": "google_drive", "credential": "secret:G", "file_ids": ["x'y"] }),
            "not a Google Drive id",
        ),
    ];
    for (input, expected) in cases {
        let error = validate(body(input.clone())).expect_err(&input.to_string());
        assert!(error.contains(expected), "{input}: {error}");
    }
}

#[test]
fn validation_normalizes_ids_and_bounds_item_counts() {
    let request = validate(body(json!({
        "provider": "notion",
        "credential": "secret:/connectors/NOTION_TOKEN",
        "page_ids": ["https://www.notion.so/acme/Handbook-0123456789abcdef0123456789abcdef?v=fedcba9876543210fedcba9876543210"],
        "max_items": 100_000,
    })))
    .expect("valid");
    assert_eq!(request.max_items, MAX_CONNECTOR_ITEMS);
    assert_eq!(request.label, "Notion");
    assert_eq!(
        request.target,
        ConnectorTarget::Notion {
            pages: vec!["01234567-89ab-cdef-0123-456789abcdef".to_owned()],
            databases: Vec::new(),
        }
    );

    let drive = validate(body(json!({
        "provider": "google-drive",
        "credential": "secret:GOOGLE_TOKEN",
        "file_ids": ["https://docs.google.com/document/d/1AbCdEfGhIjK/edit"],
        "folder_ids": ["https://drive.google.com/drive/folders/1FoLdErIdXyZ"],
        "title": "Team drive",
    })))
    .expect("valid");
    assert_eq!(drive.label, "Team drive");
    assert_eq!(
        drive.target,
        ConnectorTarget::GoogleDrive {
            files: vec!["1AbCdEfGhIjK".to_owned()],
            folders: vec!["1FoLdErIdXyZ".to_owned()],
        }
    );
}

#[test]
fn credential_values_are_tokens_or_bound_objects_and_never_debug_print() {
    assert_eq!(
        parse_credential_value(" ntn_abc ").expect("plain"),
        token("ntn_abc")
    );
    let bound = parse_credential_value(
        r#"{"token":"pat","base_url":"https://wiki.example.com/","email":"me@example.com"}"#,
    )
    .expect("object");
    assert_eq!(bound.base_url.as_deref(), Some("https://wiki.example.com"));
    assert_eq!(bound.email.as_deref(), Some("me@example.com"));
    assert!(parse_credential_value(r#"{"base_url":"https://x.example"}"#).is_err());
    assert!(parse_credential_value(r#"{"token":"t","base_url":"http://10.0.0.1"}"#).is_err());
    assert!(!format!("{bound:?}").contains("pat"));
}

// ── Redirects ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn redirects_are_followed_per_hop_and_drop_authorization_off_origin() {
    let http = MockHttp::default()
        .get("https://api.example.com/a", redirect(302, "/b"))
        .get(
            "https://api.example.com/b",
            redirect(307, "https://cdn.example.net/c"),
        )
        .get(
            "https://cdn.example.net/c",
            text_reply("done", "text/plain"),
        );
    let request = HttpRequest::get(
        "https://api.example.com/a",
        &[("authorization".to_owned(), "Bearer t".to_owned())],
    );
    let (reply, final_url) = send_following(&http, request).await.expect("followed");
    assert_eq!(reply.body, b"done");
    assert_eq!(final_url, "https://cdn.example.net/c");
    let recorded = http.recorded();
    assert_eq!(header(&recorded[1], "authorization"), Some("Bearer t"));
    assert_eq!(header(&recorded[2], "authorization"), None);
}

#[tokio::test]
async fn redirect_loops_and_error_statuses_fail() {
    let http = MockHttp::default()
        .get("https://example.com/loop", redirect(301, "/loop"))
        .get(
            "https://example.com/denied",
            HttpReply {
                status: 401,
                body: br#"{"message":"Bad credentials"}"#.to_vec(),
                ..HttpReply::default()
            },
        );
    let looped = send_following(&http, HttpRequest::get("https://example.com/loop", &[]))
        .await
        .expect_err("loop");
    assert!(looped.contains("too many redirects"), "{looped}");
    let denied = send_following(&http, HttpRequest::get("https://example.com/denied", &[]))
        .await
        .expect_err("401");
    assert!(
        denied.contains("HTTP 401") && denied.contains("Bad credentials"),
        "{denied}"
    );
}

// ── Web ──────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn web_pages_become_markdown_pages_and_documents_keep_their_format() {
    let http = MockHttp::default()
        .get("https://example.com/docs", redirect(301, "https://example.com/docs/"))
        .get(
            "https://example.com/docs/",
            text_reply(
                "<html><head><title>Docs / Home</title></head><body><h1>Hi</h1><p><a href=\"guide\">Guide</a></p></body></html>",
                "text/html; charset=utf-8",
            ),
        )
        .get("https://example.com/report.pdf", text_reply("%PDF-1.7", "application/pdf"))
        .get("https://example.com/bin", text_reply("x", "application/octet-stream"));
    let request = validate(body(json!({
        "provider": "web",
        "urls": ["https://example.com/docs", "https://example.com/report.pdf", "https://example.com/bin"],
    })))
    .expect("valid");
    let fetched = fetch_sources(&http, &request, None).await.expect("fetched");
    assert_eq!(names(&fetched), ["Docs Home.md", "report.pdf"]);
    assert_eq!(
        text_of(&fetched.sources[0]),
        "# Hi\n\n[Guide](https://example.com/docs/guide)\n\nSource: <https://example.com/docs/>"
    );
    assert_eq!(fetched.sources[1].mime, "application/pdf");
    assert_eq!(fetched.failures.len(), 1);
    assert!(fetched.failures[0].contains("application/octet-stream"));
}

// ── Notion ───────────────────────────────────────────────────────────────────

fn rich(text: &str) -> serde_json::Value {
    json!([{ "plain_text": text, "annotations": {}, "href": null }])
}

#[tokio::test]
async fn notion_pages_render_block_trees_with_pagination_and_nesting() {
    let page = "01234567-89ab-cdef-0123-456789abcdef";
    let http = MockHttp::default()
        .get(
            &format!("https://api.notion.com/v1/pages/{page}"),
            json_reply(json!({
                "id": page,
                "url": "https://www.notion.so/Handbook",
                "properties": { "Name": { "type": "title", "title": rich("Handbook") } },
            })),
        )
        .get(
            &format!("https://api.notion.com/v1/blocks/{page}/children?page_size=100"),
            json_reply(json!({
                "results": [
                    { "id": "b1", "type": "heading_2", "heading_2": { "rich_text": rich("Intro") } },
                    { "id": "b2", "type": "paragraph", "paragraph": { "rich_text": [
                        { "plain_text": "Read ", "annotations": {} },
                        { "plain_text": "this", "annotations": { "bold": true } },
                        { "plain_text": " link", "annotations": {}, "href": "https://example.com" }
                    ] } },
                    { "id": "b3", "type": "bulleted_list_item", "has_children": true, "bulleted_list_item": { "rich_text": rich("Parent") } },
                ],
                "has_more": true,
                "next_cursor": "c2",
            })),
        )
        .get(
            &format!("https://api.notion.com/v1/blocks/{page}/children?page_size=100&start_cursor=c2"),
            json_reply(json!({
                "results": [
                    { "id": "b4", "type": "numbered_list_item", "numbered_list_item": { "rich_text": rich("One") } },
                    { "id": "b5", "type": "numbered_list_item", "numbered_list_item": { "rich_text": rich("Two") } },
                    { "id": "b6", "type": "code", "code": { "language": "rust", "rich_text": rich("fn main() {}") } },
                    { "id": "b7", "type": "table", "has_children": true, "table": {} },
                ],
                "has_more": false,
            })),
        )
        .get(
            "https://api.notion.com/v1/blocks/b3/children?page_size=100",
            json_reply(json!({ "results": [
                { "id": "b3a", "type": "to_do", "to_do": { "rich_text": rich("Child"), "checked": true } }
            ], "has_more": false })),
        )
        .get(
            "https://api.notion.com/v1/blocks/b7/children?page_size=100",
            json_reply(json!({ "results": [
                { "id": "r1", "type": "table_row", "table_row": { "cells": [rich("K"), rich("V")] } },
                { "id": "r2", "type": "table_row", "table_row": { "cells": [rich("a|b"), rich("1")] } },
            ], "has_more": false })),
        );
    let request = validate(body(json!({
        "provider": "notion",
        "credential": "secret:NOTION_TOKEN",
        "page_ids": ["0123456789abcdef0123456789abcdef"],
    })))
    .expect("valid");
    let fetched = fetch_sources(&http, &request, Some(&token("ntn_test")))
        .await
        .expect("fetched");
    assert!(fetched.failures.is_empty(), "{:?}", fetched.failures);
    assert_eq!(names(&fetched), ["Handbook.md"]);
    assert_eq!(
        text_of(&fetched.sources[0]),
        "## Intro\n\nRead **this** [link](https://example.com)\n\n- Parent\n  - [x] Child\n1. One\n2. Two\n\n\
         ```rust\nfn main() {}\n```\n\n| K | V |\n| --- | --- |\n| a\\|b | 1 |\n\n\
         Source: <https://www.notion.so/Handbook>"
    );
    for request in http.recorded() {
        assert_eq!(header(&request, "authorization"), Some("Bearer ntn_test"));
        assert_eq!(header(&request, "notion-version"), Some(NOTION_VERSION));
    }
}

#[tokio::test]
async fn notion_databases_become_csv_databases_with_paginated_rows() {
    let database = "fedcba98-7654-3210-fedc-ba9876543210";
    let query = format!("https://api.notion.com/v1/databases/{database}/query");
    let row = |title: &str, status: &str, points: i64| {
        json!({ "properties": {
            "Task": { "type": "title", "title": rich(title) },
            "Status": { "type": "status", "status": { "name": status } },
            "Points": { "type": "number", "number": points },
            "Tags": { "type": "multi_select", "multi_select": [{ "name": "a" }, { "name": "b" }] },
        } })
    };
    let http = MockHttp::default()
        .get(
            &format!("https://api.notion.com/v1/databases/{database}"),
            json_reply(json!({
                "title": rich("Roadmap"),
                "properties": {
                    "Status": { "type": "status" },
                    "Task": { "type": "title" },
                    "Points": { "type": "number" },
                    "Tags": { "type": "multi_select" },
                },
            })),
        )
        .post(
            &query,
            json_reply(json!({ "results": [row("Ship, it", "Done", 3), row("Plan", "Todo", 1)], "has_more": false })),
        );
    let request = validate(body(json!({
        "provider": "notion",
        "credential": "secret:NOTION_TOKEN",
        "database_ids": [database],
    })))
    .expect("valid");
    let fetched = fetch_sources(&http, &request, Some(&token("ntn")))
        .await
        .expect("fetched");
    assert_eq!(names(&fetched), ["Roadmap.csv"]);
    assert_eq!(
        text_of(&fetched.sources[0]),
        "Task,Points,Status,Tags\n\"Ship, it\",3,Done,\"a, b\"\nPlan,1,Todo,\"a, b\""
    );
    let posted = http
        .recorded()
        .into_iter()
        .find(|request| request.method == HttpMethod::Post)
        .expect("query");
    assert_eq!(posted.body.as_deref(), Some(r#"{"page_size":50}"#));
    assert_eq!(header(&posted, "content-type"), Some("application/json"));
}

#[tokio::test]
async fn notion_databases_count_toward_the_item_limit() {
    let page = "01234567-89ab-cdef-0123-456789abcdef";
    let first = "fedcba98-7654-3210-fedc-ba9876543210";
    let second = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    let http = MockHttp::default()
        .get(
            &format!("https://api.notion.com/v1/pages/{page}"),
            json_reply(
                json!({ "properties": { "Name": { "type": "title", "title": rich("Home") } } }),
            ),
        )
        .get(
            &format!("https://api.notion.com/v1/blocks/{page}/children?page_size=100"),
            json_reply(json!({ "results": [
                { "id": "b1", "type": "paragraph", "paragraph": { "rich_text": rich("Hi") } },
            ], "has_more": false })),
        )
        .get(
            &format!("https://api.notion.com/v1/databases/{first}"),
            json_reply(
                json!({ "title": rich("One"), "properties": { "Task": { "type": "title" } } }),
            ),
        )
        .post(
            &format!("https://api.notion.com/v1/databases/{first}/query"),
            json_reply(json!({ "results": [], "has_more": false })),
        );
    let request = validate(body(json!({
        "provider": "notion",
        "credential": "secret:NOTION_TOKEN",
        "page_ids": [page],
        "database_ids": [first, second],
        "max_items": 2,
    })))
    .expect("valid");
    let fetched = fetch_sources(&http, &request, Some(&token("ntn")))
        .await
        .expect("fetched");
    assert_eq!(names(&fetched), ["Home.md", "One.csv"]);
    assert_eq!(
        fetched.failures,
        ["1 Notion database(s) skipped: the import is limited to 2 items"]
    );
    assert!(!http
        .recorded()
        .iter()
        .any(|request| request.url.contains(second)));
}

// ── Google Drive ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn drive_exports_google_formats_and_downloads_importable_files() {
    let api = "https://www.googleapis.com/drive/v3";
    let http = MockHttp::default()
        .get(
            &format!("{api}/files/1AbCdEfGhIjK?fields=id%2Cname%2CmimeType%2CmodifiedTime%2CwebViewLink&supportsAllDrives=true"),
            json_reply(json!({ "id": "1AbCdEfGhIjK", "name": "Plan", "mimeType": "application/vnd.google-apps.document" })),
        )
        .get(&format!("{api}/files/1AbCdEfGhIjK/export?mimeType=text%2Fmarkdown"), text_reply("# Plan", "text/markdown"))
        .get(
            &format!(
                "{api}/files?q=%271FoLdErIdXyZ%27+in+parents+and+trashed+%3D+false&fields=nextPageToken%2Cfiles%28id%2Cname%2CmimeType%2CmodifiedTime%2CwebViewLink%29&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true"
            ),
            json_reply(json!({ "files": [
                { "id": "sheet0000001", "name": "Budget", "mimeType": "application/vnd.google-apps.spreadsheet" },
                { "id": "pdf000000001", "name": "Report.pdf", "mimeType": "application/pdf" },
                { "id": "img000000001", "name": "photo.png", "mimeType": "image/png" },
                { "id": "sub000000001", "name": "Sub", "mimeType": "application/vnd.google-apps.folder" },
            ] })),
        )
        .get(&format!("{api}/files/sheet0000001/export?mimeType=text%2Fcsv"), text_reply("a,b\n1,2", "text/csv"))
        .get(&format!("{api}/files/pdf000000001?alt=media&supportsAllDrives=true"), text_reply("%PDF", "application/pdf"));
    let request = validate(body(json!({
        "provider": "google_drive",
        "credential": "secret:GOOGLE_TOKEN",
        "file_ids": ["1AbCdEfGhIjK"],
        "folder_ids": ["1FoLdErIdXyZ"],
    })))
    .expect("valid");
    let fetched = fetch_sources(&http, &request, Some(&token("ya29")))
        .await
        .expect("fetched");
    assert_eq!(names(&fetched), ["Plan.md", "Budget.csv", "Report.pdf"]);
    assert_eq!(text_of(&fetched.sources[1]), "a,b\n1,2");
    assert_eq!(fetched.failures, ["photo.png: unsupported format"]);
    assert!(http
        .recorded()
        .iter()
        .all(|request| header(request, "authorization") == Some("Bearer ya29")));
}

#[tokio::test]
async fn an_unreadable_drive_folder_is_a_per_item_failure() {
    let api = "https://www.googleapis.com/drive/v3";
    let http = MockHttp::default()
        .get(
            &format!("{api}/files/1AbCdEfGhIjK?fields=id%2Cname%2CmimeType%2CmodifiedTime%2CwebViewLink&supportsAllDrives=true"),
            json_reply(json!({ "id": "1AbCdEfGhIjK", "name": "Plan", "mimeType": "application/vnd.google-apps.document" })),
        )
        .get(&format!("{api}/files/1AbCdEfGhIjK/export?mimeType=text%2Fmarkdown"), text_reply("# Plan", "text/markdown"));
    let request = validate(body(json!({
        "provider": "google_drive",
        "credential": "secret:GOOGLE_TOKEN",
        "file_ids": ["1AbCdEfGhIjK"],
        "folder_ids": ["1MiSsInGfOlDeR"],
    })))
    .expect("valid");
    let fetched = fetch_sources(&http, &request, Some(&token("ya29")))
        .await
        .expect("a missing folder does not fail the import");
    assert_eq!(names(&fetched), ["Plan.md"]);
    assert_eq!(fetched.failures.len(), 1);
    assert!(
        fetched.failures[0]
            .starts_with("Drive folder 1MiSsInGfOlDeR: www.googleapis.com returned HTTP 404"),
        "{:?}",
        fetched.failures
    );
}

// ── Confluence ───────────────────────────────────────────────────────────────

#[test]
fn confluence_tokens_are_bound_to_their_site() {
    let cloud = confluence_site(
        Some("https://acme.atlassian.net/wiki"),
        Some("me@acme.com"),
        &token("t"),
    )
    .expect("cloud");
    assert_eq!(cloud.base_url, "https://acme.atlassian.net/wiki");
    assert_eq!(
        cloud.authorization,
        format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode("me@acme.com:t")
        )
    );

    let error = confluence_site(Some("https://attacker.example.com"), None, &token("t"))
        .expect_err("unbound host");
    assert!(
        error.contains("must be stored with the credential"),
        "{error}"
    );

    let stored = ConnectorCredential {
        token: "pat".to_owned(),
        base_url: Some("https://wiki.example.com".to_owned()),
        email: None,
    };
    let data_center = confluence_site(None, None, &stored).expect("stored");
    assert_eq!(data_center.base_url, "https://wiki.example.com");
    assert_eq!(data_center.authorization, "Bearer pat");
    assert!(confluence_site(Some("https://other.example.com"), None, &stored).is_err());
}

#[tokio::test]
async fn confluence_pages_and_spaces_become_markdown_pages() {
    let base = "https://acme.atlassian.net/wiki/rest/api/content";
    let expand = "body.export_view%2Cbody.storage%2Cversion%2Cspace";
    let page = |id: &str, title: &str, html: &str| {
        json!({ "id": id, "title": title, "body": { "export_view": { "value": html } },
                "_links": { "webui": format!("/spaces/ENG/pages/{id}") } })
    };
    let http = MockHttp::default()
        .get(&format!("{base}/101?expand={expand}"), json_reply(page("101", "Runbook", "<h2>Steps</h2><ol><li>Check</li></ol>")))
        .get(
            &format!("{base}?spaceKey=ENG&type=page&status=current&expand={expand}&start=0&limit=49"),
            json_reply(json!({ "results": [page("201", "One", "<p>first</p>")], "_links": { "next": "/next" } })),
        )
        .get(
            &format!("{base}?spaceKey=ENG&type=page&status=current&expand={expand}&start=1&limit=48"),
            json_reply(json!({ "results": [page("202", "Two", "<p>second</p>")], "_links": {} })),
        );
    let request = validate(body(json!({
        "provider": "confluence",
        "credential": "secret:CONFLUENCE",
        "base_url": "https://acme.atlassian.net/wiki/",
        "email": "me@acme.com",
        "page_ids": ["101"],
        "space_key": "ENG",
    })))
    .expect("valid");
    let fetched = fetch_sources(&http, &request, Some(&token("atl")))
        .await
        .expect("fetched");
    assert!(fetched.failures.is_empty(), "{:?}", fetched.failures);
    assert_eq!(names(&fetched), ["Runbook.md", "One.md", "Two.md"]);
    assert_eq!(
        text_of(&fetched.sources[0]),
        "## Steps\n\n1. Check\n\nSource: <https://acme.atlassian.net/wiki/spaces/ENG/pages/101>"
    );
}

// ── GitHub ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn github_imports_importable_files_under_a_path() {
    let api = "https://api.github.com/repos/acme/handbook";
    let http = MockHttp::default()
        .get(api, json_reply(json!({ "default_branch": "main" })))
        .get(
            &format!("{api}/git/trees/main?recursive=1"),
            json_reply(json!({ "tree": [
                { "type": "blob", "path": "README.md", "size": 10 },
                { "type": "tree", "path": "docs" },
                { "type": "blob", "path": "docs/intro.md", "size": 20 },
                { "type": "blob", "path": "docs/main.rs", "size": 20 },
                { "type": "blob", "path": "docs/big.pdf", "size": 50_000_000 },
                { "type": "blob", "path": "docs/sheet one.csv", "size": 8 },
                { "type": "blob", "path": "docs/bundle.zip", "size": 8 },
            ] })),
        )
        .get(
            &format!("{api}/contents/docs/intro.md?ref=main"),
            text_reply("# Intro", "text/plain"),
        )
        .get(
            &format!("{api}/contents/docs/sheet%20one.csv?ref=main"),
            text_reply("a\n1", "text/plain"),
        );
    let request = validate(body(
        json!({ "provider": "github", "repo": "acme/handbook", "path": "/docs/" }),
    ))
    .expect("valid");
    let fetched = fetch_sources(&http, &request, Some(&token("ghp")))
        .await
        .expect("fetched");
    assert_eq!(names(&fetched), ["docs - intro.md", "docs - sheet one.csv"]);
    assert_eq!(fetched.sources[1].mime, "text/csv");
    let recorded = http.recorded();
    assert!(recorded
        .iter()
        .all(|request| header(request, "authorization") == Some("Bearer ghp")));
    let raw = recorded
        .iter()
        .find(|request| request.url.contains("/contents/"))
        .expect("raw");
    assert_eq!(header(raw, "accept"), Some("application/vnd.github.raw"));
}

#[tokio::test]
async fn github_without_a_credential_sends_no_authorization() {
    let api = "https://api.github.com/repos/acme/site";
    let http = MockHttp::default()
        .get(
            &format!("{api}/git/trees/v1.0?recursive=1"),
            json_reply(json!({ "tree": [{ "type": "blob", "path": "index.html", "size": 5 }] })),
        )
        .get(
            &format!("{api}/contents/index.html?ref=v1.0"),
            text_reply("<p>x</p>", "text/plain"),
        );
    let request = validate(body(
        json!({ "provider": "github", "repo": "acme/site", "ref": "v1.0" }),
    ))
    .expect("valid");
    let fetched = fetch_sources(&http, &request, None).await.expect("fetched");
    assert_eq!(names(&fetched), ["index.html"]);
    assert!(http
        .recorded()
        .iter()
        .all(|request| header(request, "authorization").is_none()));
}
