//! Shipped app hook → production program builder → real sandbox → `host.t`.
//! The Study-mode note of `@ryu/tuition` is rendered by Core's catalog through
//! the real `translate` bridge, for the locale the program was built with.

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::plugin_host::{
    build_hook_program_in, parse_directive, HookContext, HookDirective, HookMessage,
};
use crate::tool_exec::{
    self, ExecOutcome, InvokeOutcome, SandboxBridge, SandboxToolInvoker, ToolInvokeResult,
};

const PLURAL: &str =
    "Study mode — {count} review candidates queued. Accept or reject them in Tuition.";
const SINGULAR: &str = "Study mode — 1 review candidate queued. Accept or reject it in Tuition.";

/// Answers the study hook's capabilities; `host.t` goes to the real bridge.
struct StudyBridge {
    candidates: usize,
    translations: Mutex<Vec<Value>>,
}

impl SandboxBridge for StudyBridge {
    fn handle(
        &self,
        path: String,
        args: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = InvokeOutcome> + Send + '_>> {
        Box::pin(async move {
            let value = match path.as_str() {
                "host.t" => {
                    self.translations.lock().unwrap().push(args.clone());
                    return super::translate(args).await;
                }
                "host.getPreference" => json!("algebra"),
                "host.sideModel" => {
                    let items: Vec<Value> = (1..=self.candidates)
                        .map(|n| json!({ "prompt": format!("Q{n}?"), "answer": "A", "skill": "Algebra" }))
                        .collect();
                    Value::String(Value::Array(items).to_string())
                }
                "host.storage_set" => json!(true),
                other => panic!("unexpected capability {other}: {args}"),
            };
            InvokeOutcome::Result(ToolInvokeResult {
                value,
                is_error: false,
                error: None,
            })
        })
    }
}

fn study_hook_code() -> String {
    crate::plugin_manifest::PluginManifestLoader::load()
        .into_iter()
        .find(|manifest| manifest.id == "@ryu/tuition")
        .and_then(|manifest| manifest.contributes)
        .and_then(|contributes| {
            contributes
                .turn_hooks
                .into_iter()
                .find(|hook| hook.id == "tuition.study")
        })
        .expect("shipped tuition.study hook")
        .code
}

/// Run the shipped hook for `locale`; the note text and the `host.t` calls.
async fn study_note(locale: &str, candidates: usize) -> (String, Vec<Value>) {
    assert!(tool_exec::is_available(), "real sandbox runtime required");
    let ctx = HookContext {
        conversation_id: Some("chat-1".into()),
        flags: [("io.ryu.tuition".to_owned(), true)].into_iter().collect(),
        transcript: vec![
            HookMessage {
                role: "user".into(),
                content: "Teach me quadratics.".into(),
            },
            HookMessage {
                role: "assistant".into(),
                content: "A quadratic has degree two. ".repeat(40),
            },
        ],
        ..Default::default()
    };
    let bridge = Arc::new(StudyBridge {
        candidates,
        translations: Mutex::new(Vec::new()),
    });
    let program = build_hook_program_in(&ctx, &study_hook_code(), locale);
    let outcome = tool_exec::run_sandboxed(
        program,
        Arc::new(SandboxToolInvoker::bridge(bridge.clone())),
        "ryu",
    )
    .await;
    let directive = match outcome {
        ExecOutcome::Completed {
            result,
            is_error,
            error,
            ..
        } => {
            assert!(!is_error, "hook failed: {error:?}");
            parse_directive(result.as_ref())
        }
        ExecOutcome::Paused { .. } => panic!("unexpected pause"),
    };
    let HookDirective::Note { text } = directive else {
        panic!("expected a note, got {directive:?}");
    };
    let calls = bridge.translations.lock().unwrap().clone();
    (text, calls)
}

#[tokio::test]
async fn study_note_renders_through_host_t_for_the_program_locale() {
    let (english, _) = study_note("en", 3).await;
    assert_eq!(
        english,
        "Study mode — 3 review candidates queued. Accept or reject them in Tuition."
    );

    let (japanese, calls) = study_note("ja", 3).await;
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert_eq!(calls[0]["source"], PLURAL);
    assert_eq!(calls[0]["values"], json!({ "count": 3 }));
    assert_eq!(calls[0]["locale"], "ja");
    assert_eq!(
        japanese,
        super::render_hook_text(PLURAL, Some(&json!({ "count": 3 })), "ja")
    );
    assert_ne!(japanese, english, "ja must use Core's catalog translation");
    assert!(japanese.contains('3'), "{japanese}");
}

#[tokio::test]
async fn one_study_candidate_uses_the_singular_sentence() {
    let (japanese, calls) = study_note("ja", 1).await;
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert_eq!(calls[0]["source"], SINGULAR);
    assert_eq!(calls[0]["locale"], "ja");
    assert_eq!(japanese, super::render_hook_text(SINGULAR, None, "ja"));
    assert_ne!(japanese, SINGULAR, "ja must use Core's catalog translation");
    assert_eq!(study_note("en", 1).await.0, SINGULAR);
}
