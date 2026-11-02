use super::*;
use crate::test_support::*;

#[test]
fn sanitize_task_and_author_reject_unsafe() {
    assert_eq!(
        sanitize_task(" text-generation "),
        Some("text-generation".into())
    );
    assert_eq!(sanitize_task("speech2text"), Some("speech2text".into()));
    assert_eq!(sanitize_task(""), None);
    assert_eq!(sanitize_task("Has Spaces!"), None);
    assert_eq!(sanitize_task("inject&param=1"), None);

    assert_eq!(sanitize_author(" google "), Some("google".into()));
    assert_eq!(
        sanitize_author("mlx-community"),
        Some("mlx-community".into())
    );
    assert_eq!(sanitize_author(""), None);
    assert_eq!(sanitize_author("bad/author"), None);
}

#[test]
fn parse_next_cursor_extracts_only_the_cursor() {
    use reqwest::header::HeaderValue;
    let link = HeaderValue::from_str(
        "<https://huggingface.co/api/models?sort=x&cursor=ABC123&limit=20>; rel=\"next\"",
    )
    .unwrap();
    assert_eq!(parse_next_cursor(Some(&link)).as_deref(), Some("ABC123"));
    assert_eq!(parse_next_cursor(None), None);
    let only_prev = HeaderValue::from_str("<https://x/api/models?cursor=Z>; rel=\"prev\"").unwrap();
    assert_eq!(parse_next_cursor(Some(&only_prev)), None);
}

#[tokio::test]
async fn installed_only_search_lists_local_cards_offline() {
    ensure_test_host();
    let stem = "installed-only-unique-g1";
    let models = installed::chat_models_dir();
    std::fs::create_dir_all(&models).unwrap();
    std::fs::write(models.join(format!("{stem}.gguf")), b"x").unwrap();
    installed::record(installed::InstalledModel {
        repo_id: "acme/installed-only-repo".into(),
        filename: format!("{stem}.gguf"),
        stem: stem.into(),
        size_bytes: Some(1),
        format: ModelFormat::Gguf,
        mmproj: None,
        finetune_base: None,
    })
    .unwrap();

    // Point enrichment at a server that 404s every info request, so each card
    // keeps its local values (proves the offline fallback path).
    let addr = spawn_http(|_path| (404, vec![], b"nope".to_vec()));
    let endpoint = HfEndpoint {
        api_base: format!("http://{addr}/api"),
        host: format!("http://{addr}"),
    };
    let page = search_models(
        &test_client(),
        &endpoint,
        "",
        CatalogSort::Trending,
        ModelFormat::Gguf,
        20,
        true,
        "",
        "",
        None,
    )
    .await
    .unwrap();
    assert!(page.next_cursor.is_none());
    let card = page
        .models
        .iter()
        .find(|c| c.id == "acme/installed-only-repo")
        .expect("the recorded install shows as a card");
    assert!(card.installed);

    let _ = installed::remove(stem);
    let _ = std::fs::remove_file(models.join(format!("{stem}.gguf")));
}

#[tokio::test]
async fn search_models_parses_list_and_next_cursor() {
    ensure_test_host();
    let addr = spawn_http(|path| {
        if path.contains("/api/models?") {
            let body = serde_json::json!([
                {
                    "id": "unsloth/gemma-3-GGUF",
                    "downloads": 10, "likes": 2,
                    "tags": ["text-generation"],
                    "pipeline_tag": "text-generation",
                    "gated": false,
                    "createdAt": "2024-01-01", "lastModified": "2024-02-01",
                    "gguf": { "context_length": 8192, "architecture": "gemma3", "total": 4_000_000_000u64 }
                },
                {
                    "id": "flux-org/flux-GGUF",
                    "pipeline_tag": "text-to-image",
                    "gated": "manual",
                    "gguf": { "architecture": "flux" }
                }
            ])
            .to_string()
            .into_bytes();
            (
                200,
                vec![(
                    "Link",
                    "<https://huggingface.co/api/models?cursor=NEXT123&x=1>; rel=\"next\""
                        .to_string(),
                )],
                body,
            )
        } else {
            (404, vec![], b"no".to_vec())
        }
    });
    let endpoint = HfEndpoint {
        api_base: format!("http://{addr}/api"),
        host: format!("http://{addr}"),
    };
    let page = search_models(
        &test_client(),
        &endpoint,
        "gemma",
        CatalogSort::Trending,
        ModelFormat::Gguf,
        20,
        false,
        "",
        "",
        None,
    )
    .await
    .unwrap();

    assert_eq!(page.models.len(), 2);
    assert_eq!(page.next_cursor.as_deref(), Some("NEXT123"));

    let g = &page.models[0];
    assert_eq!(g.id, "unsloth/gemma-3-GGUF");
    assert_eq!(g.author, "unsloth");
    assert_eq!(g.name, "gemma-3-GGUF");
    assert_eq!(g.context_length, Some(8192));
    assert_eq!(g.architecture.as_deref(), Some("gemma3"));
    assert_eq!(g.downloads, 10);
    // The TestHost supports no engines → shown but flagged incompatible.
    assert!(!g.compatible);
    assert!(g.needs_engine.is_some());
    assert!(!g.diffusion);

    let f = &page.models[1];
    assert!(f.diffusion, "flux pipeline tag ⇒ diffusion");
    assert!(f.gated, "\"manual\" gated string normalizes to true");
}
