//! Tests for the generic Box sandbox backend.

use super::*;
use crate::spec::GpuKind;

use super::test_env::{lock_box_env, lock_box_env_blocking};

#[test]
fn backend_name_and_default_spec_are_stable() {
    let _guard = lock_box_env_blocking();
    unsafe { std::env::remove_var(ENV_BOX_SIZE) };
    assert_eq!(BoxSandbox::new().name(), "box");
    let spec = BoxSandbox::new().spec();
    assert_eq!(spec.vcpu, 4);
    assert_eq!(spec.mem_gib, 8);
    assert_eq!(spec.storage_gib, 80);
    assert_eq!(spec.gpu, GpuKind::None);
}

#[tokio::test]
async fn detection_requires_a_token_without_network_io() {
    let _guard = lock_box_env().await;
    unsafe { std::env::remove_var(ENV_BOX_TOKEN) };
    assert!(matches!(detect().await, DetectResult::Unavailable(_)));
    unsafe { std::env::set_var(ENV_BOX_TOKEN, "box_test") };
    assert_eq!(detect().await, DetectResult::Available);
    unsafe { std::env::remove_var(ENV_BOX_TOKEN) };
}

#[test]
fn subscription_passthrough_is_explicit() {
    let _guard = lock_box_env_blocking();
    unsafe { std::env::remove_var(ENV_BOX_SUBSCRIPTION_PASSTHROUGH) };
    assert!(!subscription_passthrough());
    unsafe { std::env::set_var(ENV_BOX_SUBSCRIPTION_PASSTHROUGH, "true") };
    assert!(subscription_passthrough());
    unsafe { std::env::set_var(ENV_BOX_SUBSCRIPTION_PASSTHROUGH, "off") };
    assert!(!subscription_passthrough());
    unsafe { std::env::remove_var(ENV_BOX_SUBSCRIPTION_PASSTHROUGH) };
}

#[tokio::test]
async fn subscription_passthrough_active_requires_the_explicit_flag() {
    let _guard = lock_box_env().await;
    unsafe { std::env::remove_var(ENV_BOX_SUBSCRIPTION_PASSTHROUGH) };
    assert!(!subscription_passthrough_active().await);
}

/// Point the Box client at a scripted server for one test, restoring the
/// previous env on drop. Callers must hold the Box env lock.
struct BoxEnv(Vec<(&'static str, Option<std::ffi::OsString>)>);

impl BoxEnv {
    fn point_at(base_url: &str, timeout_secs: Option<&str>) -> Self {
        let saved = [ENV_BOX_URL, ENV_BOX_TOKEN, ENV_BOX_TIMEOUT_SECS]
            .into_iter()
            .map(|name| (name, std::env::var_os(name)))
            .collect();
        unsafe {
            std::env::set_var(ENV_BOX_URL, base_url);
            std::env::set_var(ENV_BOX_TOKEN, "box_test");
            match timeout_secs {
                Some(value) => std::env::set_var(ENV_BOX_TIMEOUT_SECS, value),
                None => std::env::remove_var(ENV_BOX_TIMEOUT_SECS),
            }
        }
        Self(saved)
    }
}

impl Drop for BoxEnv {
    fn drop(&mut self) {
        for (name, value) in &self.0 {
            match value {
                Some(value) => unsafe { std::env::set_var(name, value) },
                None => unsafe { std::env::remove_var(name) },
            }
        }
    }
}

/// Drive one async client call on a fresh runtime, so a plain test can hold
/// the Box env lock (`lock_box_env_blocking` panics inside a runtime).
fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build runtime")
        .block_on(future)
}

#[test]
fn failed_readiness_deletes_the_created_box() {
    use crate::test_http::{json_response, request_header, request_line, ScriptedServer};
    let _guard = lock_box_env_blocking();
    let server = ScriptedServer::start(|_index, request| {
        let line = request_line(request);
        Some(if line.starts_with("POST /boxes ") {
            json_response(201, r#"{"box":{"id":"b1","status":"provisioning"}}"#)
        } else if line.starts_with("GET /boxes/b1 ") {
            json_response(200, r#"{"box":{"id":"b1","status":"error"}}"#)
        } else {
            json_response(200, "{}")
        })
    });
    let _env = BoxEnv::point_at(&server.base_url, None);
    let error = block_on(BoxSandbox::new().create_workspace(SandboxCapabilities::default()))
        .expect_err("a box that never becomes runnable is not handed out");
    assert!(error.to_string().contains("not runnable"), "{error}");
    let requests = server.finish();
    let delete = requests
        .iter()
        .find(|request| request_line(request).starts_with("DELETE /boxes/b1 "))
        .expect("the created box is deleted after readiness fails");
    assert_eq!(request_header(delete, "X-Ascii-Confirm-Delete"), Some("b1"));
}

#[test]
fn timed_out_create_retries_with_the_same_idempotency_key() {
    use crate::test_http::{
        json_response, request_body, request_header, request_line, ScriptedServer,
    };
    let _guard = lock_box_env_blocking();
    let server = ScriptedServer::start(|index, request| {
        let line = request_line(request);
        if index == 0 {
            // Never answer the first POST: the client times out on it.
            return None;
        }
        Some(if line.starts_with("POST /boxes ") {
            json_response(200, r#"{"box":{"id":"b2","status":"provisioning"}}"#)
        } else {
            json_response(200, r#"{"box":{"id":"b2","status":"ready"}}"#)
        })
    });
    let _env = BoxEnv::point_at(&server.base_url, Some("1"));
    let workspace = block_on(BoxSandbox::new().create_workspace(SandboxCapabilities::default()))
        .expect("the retried create resolves to the box");
    assert_eq!(workspace.0, "b2");
    let requests = server.finish();
    let posts: Vec<&String> = requests
        .iter()
        .filter(|request| request_line(request).starts_with("POST /boxes "))
        .collect();
    assert_eq!(posts.len(), 2, "one timed-out attempt and one retry");
    let first_key = request_header(posts[0], "Idempotency-Key");
    assert!(first_key.is_some_and(|key| key.starts_with("ryu-")));
    assert_eq!(first_key, request_header(posts[1], "Idempotency-Key"));
    assert_eq!(request_body(posts[0]), request_body(posts[1]));
}

#[test]
fn reported_lifetime_reads_the_effective_ttl() {
    assert_eq!(
        reported_lifetime(&json!({ "box": { "id": "bx_1", "ttlSeconds": 86_400 } })),
        Some(Duration::from_secs(86_400))
    );
    assert_eq!(
        reported_lifetime(&json!({ "box": { "id": "bx_1", "ttlSeconds": null } })),
        None
    );
    assert_eq!(
        reported_lifetime(&json!({ "box": { "id": "bx_1", "ttlSeconds": 0 } })),
        None
    );
    assert_eq!(reported_lifetime(&json!({ "box": { "id": "bx_1" } })), None);
}

/// Serve canned Box API responses, one request per connection.
async fn serve_box_api(listener: tokio::net::TcpListener, responses: Vec<&'static str>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for body in responses {
        let Ok((mut socket, _)) = listener.accept().await else {
            return;
        };
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            let Ok(read) = socket.read(&mut buffer).await else {
                return;
            };
            if read == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..read]);
            let text = String::from_utf8_lossy(&request);
            if let Some(head_end) = text.find("\r\n\r\n") {
                let length = text[..head_end]
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    })
                    .unwrap_or(0);
                if request.len() >= head_end + 4 + length {
                    break;
                }
            }
        }
        let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        let _ = socket.write_all(response.as_bytes()).await;
        let _ = socket.shutdown().await;
    }
}

#[test]
fn create_reports_the_lifetime_the_service_applied() {
    let _guard = lock_box_env_blocking();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build runtime");
    let created = runtime.block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bind fake Box API");
            let port = listener.local_addr().expect("local addr").port();
            let server = tokio::spawn(serve_box_api(
                listener,
                vec![
                    r#"{"ok":true,"type":"box.created","box":{"id":"bx_ttl","status":"ready","ttlSeconds":86400}}"#,
                    r#"{"ok":true,"box":{"id":"bx_ttl","status":"ready","ttlSeconds":86400}}"#,
                ],
            ));
            unsafe {
                std::env::set_var(ENV_BOX_URL, format!("http://127.0.0.1:{port}/v1"));
                std::env::set_var(ENV_BOX_TOKEN, "box_test");
            }
            let created = BoxSandbox::new()
                .create_workspace_with_lifetime(SandboxCapabilities::default())
                .await;
            unsafe {
                std::env::remove_var(ENV_BOX_URL);
                std::env::remove_var(ENV_BOX_TOKEN);
            }
            server.abort();
            created
        });
    let created = created.expect("create against the fake Box API");
    assert_eq!(created.workspace, WorkspaceId("bx_ttl".to_owned()));
    assert_eq!(created.lifetime, Some(Duration::from_secs(86_400)));
}

#[test]
fn size_selection_maps_to_metered_resources() {
    let _guard = lock_box_env_blocking();
    unsafe { std::env::set_var(ENV_BOX_SIZE, "small") };
    assert_eq!(configured_spec().vcpu, 2);
    assert_eq!(box_size(), "small");
    unsafe { std::env::set_var(ENV_BOX_SIZE, "large") };
    assert_eq!(configured_spec().mem_gib, 16);
    unsafe { std::env::set_var(ENV_BOX_SIZE, "cpx22") };
    assert_eq!(configured_size(), BoxSize::Default);
    unsafe { std::env::remove_var(ENV_BOX_SIZE) };
    assert_eq!(box_size(), "default");
}

#[test]
fn box_backend_spec_for_ignores_the_env_size() {
    let _guard = lock_box_env_blocking();
    unsafe { std::env::set_var(ENV_BOX_SIZE, "small") };
    let large = spec_for(BoxSize::Large);
    assert_eq!((large.vcpu, large.mem_gib, large.storage_gib), (8, 16, 100));
    assert_eq!(configured_spec(), spec_for(BoxSize::Small));
    unsafe { std::env::remove_var(ENV_BOX_SIZE) };
}
