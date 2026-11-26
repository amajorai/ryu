//! Daytona backend tests: config, the create body, and the request sequence
//! against a scripted local server.

use super::client::{
    append_response_chunk, checked_toolbox_url, create_body, output_bytes, size_mismatch,
    DaytonaClient, MAX_DAYTONA_OUTPUT_BYTES, MAX_DAYTONA_RESPONSE_BYTES,
};
use super::*;

/// Serializes tests that mutate the process-global Daytona env vars,
/// including the heartbeat kill tests that point Daytona at a mock server.
static DAYTONA_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
pub(crate) fn lock_env() -> std::sync::MutexGuard<'static, ()> {
    DAYTONA_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

fn sample_spec(gpu: GpuKind, gpu_count: u32) -> SandboxSpec {
    SandboxSpec {
        vcpu: 2,
        mem_gib: 4,
        storage_gib: 10,
        gpu,
        gpu_count,
        os: OsKind::Linux,
    }
}

/// Restores the Daytona URL and token env vars when a test ends.
struct RestoreEnv(Vec<(&'static str, Option<std::ffi::OsString>)>);

impl RestoreEnv {
    fn point_at(base_url: &str) -> Self {
        let saved = [ENV_DAYTONA_URL, ENV_DAYTONA_TOKEN]
            .into_iter()
            .map(|name| (name, std::env::var_os(name)))
            .collect();
        unsafe {
            std::env::set_var(ENV_DAYTONA_URL, base_url);
            std::env::set_var(ENV_DAYTONA_TOKEN, "mock-token");
        }
        Self(saved)
    }
}

impl Drop for RestoreEnv {
    fn drop(&mut self) {
        for (name, value) in &self.0 {
            unsafe {
                match value {
                    Some(value) => std::env::set_var(name, value),
                    None => std::env::remove_var(name),
                }
            }
        }
    }
}

/// Read one HTTP request, body included, so the client never sees a reset.
fn read_request(stream: &mut std::net::TcpStream) -> String {
    use std::io::Read;
    let mut bytes = Vec::new();
    let mut chunk = [0; 4096];
    loop {
        let count = stream.read(&mut chunk).unwrap();
        bytes.extend_from_slice(&chunk[..count]);
        let text = String::from_utf8_lossy(&bytes);
        if let Some(head_end) = text.find("\r\n\r\n") {
            let wanted = text[..head_end]
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())?
                })
                .unwrap_or(0);
            if bytes.len() >= head_end + 4 + wanted {
                return text.into_owned();
            }
        }
        if count == 0 {
            return text.into_owned();
        }
    }
}

/// A local server that answers each connection with the next scripted body.
/// `{base}` in a body is replaced with the server's own URL. Returns the base
/// URL and a handle yielding the raw requests it saw, in order.
fn scripted_server(
    responses: Vec<(&'static str, &'static str)>,
) -> (String, std::thread::JoinHandle<Vec<String>>) {
    use std::io::Write;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let own_base = base.clone();
    let server = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for (status, body) in responses {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            requests.push(read_request(&mut stream));
            let body = body.replace("{base}", &own_base);
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).unwrap();
        }
        requests
    });
    (base, server)
}

#[test]
fn backend_name_is_daytona() {
    assert_eq!(DaytonaSandbox::new().name(), "daytona");
}

#[tokio::test]
async fn detect_reflects_token_presence() {
    let _lock = lock_env();
    unsafe {
        std::env::remove_var(ENV_DAYTONA_TOKEN);
        std::env::remove_var(ENV_DAYTONA_TOKEN_ALT);
    }
    assert!(matches!(detect().await, DetectResult::Unavailable(_)));
    unsafe { std::env::set_var(ENV_DAYTONA_TOKEN, "tok_test") };
    assert_eq!(detect().await, DetectResult::Available);
    unsafe { std::env::remove_var(ENV_DAYTONA_TOKEN) };
}

#[test]
fn gpu_count_normalized_to_one_when_gpu_selected() {
    let _lock = lock_env();
    unsafe {
        std::env::set_var(ENV_DAYTONA_GPU, "h100");
        std::env::remove_var(ENV_DAYTONA_GPU_COUNT);
    }
    let spec = configured_spec();
    assert_eq!(spec.gpu, GpuKind::H100);
    assert_eq!(spec.gpu_count, 1, "a selected GPU must bill at least one");
    unsafe {
        std::env::remove_var(ENV_DAYTONA_GPU);
    }
}

#[test]
fn cpu_only_spec_has_zero_gpu_count() {
    let _lock = lock_env();
    unsafe {
        std::env::remove_var(ENV_DAYTONA_GPU);
        std::env::set_var(ENV_DAYTONA_GPU_COUNT, "4");
    }
    let spec = configured_spec();
    assert_eq!(spec.gpu, GpuKind::None);
    assert_eq!(spec.gpu_count, 0, "no GPU class means zero billable GPUs");
    unsafe { std::env::remove_var(ENV_DAYTONA_GPU_COUNT) };
}

#[test]
fn provider_response_chunks_are_bounded_before_buffer_growth() {
    let mut body = Vec::new();
    let at_limit = vec![b'x'; MAX_DAYTONA_RESPONSE_BYTES];
    append_response_chunk(&mut body, &at_limit, "test").expect("limit is accepted");
    assert_eq!(body.len(), MAX_DAYTONA_RESPONSE_BYTES);

    assert!(append_response_chunk(&mut body, b"x", "test").is_err());
    assert_eq!(body.len(), MAX_DAYTONA_RESPONSE_BYTES);
}

#[test]
fn provider_output_fields_match_the_local_stream_cap() {
    let at_limit = serde_json::json!({
        "stdout": "x".repeat(MAX_DAYTONA_OUTPUT_BYTES),
    });
    assert_eq!(
        output_bytes(&at_limit, &["stdout"], "stdout")
            .expect("output at the cap is accepted")
            .len(),
        MAX_DAYTONA_OUTPUT_BYTES
    );

    let oversized = serde_json::json!({
        "stdout": "x".repeat(MAX_DAYTONA_OUTPUT_BYTES + 1),
    });
    assert!(output_bytes(&oversized, &["stdout"], "stdout").is_err());
}

#[tokio::test]
async fn client_from_env_requires_token() {
    let _lock = lock_env();
    unsafe {
        std::env::remove_var(ENV_DAYTONA_TOKEN);
        std::env::remove_var(ENV_DAYTONA_TOKEN_ALT);
    }
    assert!(DaytonaClient::from_env().is_err());
    unsafe { std::env::set_var(ENV_DAYTONA_TOKEN, "tok_test") };
    assert!(DaytonaClient::from_env().is_ok());
    unsafe { std::env::remove_var(ENV_DAYTONA_TOKEN) };
}

#[test]
fn create_body_uses_only_fields_the_api_defines() {
    let body = create_body(true, Some("us"), Some("snap"));
    let mut keys: Vec<_> = body.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, ["networkBlockAll", "public", "snapshot", "target"]);
    assert_eq!(body["target"], "us");
    assert_eq!(body["snapshot"], "snap");
}

#[test]
fn create_body_never_publishes_the_preview_and_maps_network_to_the_block() {
    let allowed = create_body(true, None, None);
    assert_eq!(allowed["public"], false, "network access is not a public preview");
    assert_eq!(allowed["networkBlockAll"], false);

    let denied = create_body(false, None, None);
    assert_eq!(denied["public"], false);
    assert_eq!(denied["networkBlockAll"], true, "deny-all must block egress");
}

/// Daytona answers HTTP 400 "Cannot specify Sandbox resources when using a
/// snapshot" when a size rides along, with or without a named snapshot.
#[test]
fn create_body_never_sends_a_size() {
    for snapshot in [None, Some("daytona-gpu")] {
        let body = create_body(true, None, snapshot);
        for field in ["cpu", "memory", "disk", "gpu", "gpuType"] {
            assert!(body.get(field).is_none(), "{field} must not be sent");
        }
    }
}

#[test]
fn size_mismatch_names_each_field_the_snapshot_sized_differently() {
    let spec = sample_spec(GpuKind::None, 0);
    let same = serde_json::json!({ "cpu": 2, "memory": 4, "disk": 10 });
    assert_eq!(size_mismatch(&spec, &same), None);
    assert_eq!(size_mismatch(&spec, &serde_json::json!({ "id": "x" })), None);

    let smaller = serde_json::json!({ "cpu": 1, "memory": 1, "disk": 10 });
    let text = size_mismatch(&spec, &smaller).expect("cpu and memory differ");
    assert!(text.contains("cpu billed 2, sandbox has 1"), "{text}");
    assert!(text.contains("memory billed 4, sandbox has 1"), "{text}");
    assert!(!text.contains("disk"), "{text}");
}

#[test]
fn toolbox_url_must_be_https_unless_the_api_itself_is_plain_http() {
    let api = "https://app.daytona.io/api";
    assert_eq!(
        checked_toolbox_url(api, "https://proxy.app.daytona.io/toolbox/").unwrap(),
        "https://proxy.app.daytona.io/toolbox"
    );
    assert!(checked_toolbox_url(api, "http://proxy.example/toolbox").is_err());
    assert!(checked_toolbox_url(api, "").is_err());
    assert!(checked_toolbox_url(api, "https://").is_err());
    assert!(checked_toolbox_url(api, "ftp://proxy.example").is_err());
    assert_eq!(
        checked_toolbox_url("http://127.0.0.1:9", "http://127.0.0.1:9/toolbox").unwrap(),
        "http://127.0.0.1:9/toolbox"
    );
}

#[tokio::test]
async fn workspace_exec_looks_up_the_toolbox_then_runs_through_it() {
    let _lock = lock_env();
    let (base, server) = scripted_server(vec![
        ("200 OK", r#"{"url":"{base}/toolbox/"}"#),
        ("200 OK", r#"{"exitCode":3,"result":"hello\n"}"#),
    ]);
    let _restore = RestoreEnv::point_at(&base);

    let mut spec = ExecSpec::new("echo", vec!["hello".into()]);
    spec.timeout_secs = Some(45);
    let output = DaytonaSandbox::new()
        .exec_in_workspace(&WorkspaceId("ws-1".into()), spec)
        .await
        .expect("exec succeeds");
    assert_eq!(output.exit_code, 3);
    assert_eq!(output.stdout, b"hello\n");

    let requests = server.join().unwrap();
    assert!(requests[0].starts_with("GET /sandbox/ws-1/toolbox-proxy-url HTTP/1.1"));
    assert!(requests[1].starts_with("POST /toolbox/ws-1/process/execute HTTP/1.1"));
    assert!(requests[1].to_ascii_lowercase().contains("authorization: bearer mock-token"));
    let sent: serde_json::Value =
        serde_json::from_str(requests[1].split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(sent, serde_json::json!({"command": "echo hello", "timeout": 45}));
}

#[tokio::test]
async fn ephemeral_exec_reuses_the_created_toolbox_url_and_always_destroys() {
    let _lock = lock_env();
    let (base, server) = scripted_server(vec![
        ("200 OK", r#"{"id":"sb-9","toolboxProxyUrl":"{base}/toolbox"}"#),
        ("500 Internal Server Error", r#"{"message":"boom"}"#),
        ("204 No Content", ""),
    ]);
    let _restore = RestoreEnv::point_at(&base);

    let error = DaytonaSandbox::new()
        .exec(ExecSpec::new("true", Vec::new()))
        .await
        .expect_err("a failed run surfaces its error");
    assert!(error.to_string().contains("daytona exec failed (HTTP 500"));

    let requests = server.join().unwrap();
    assert!(requests[0].starts_with("POST /sandbox HTTP/1.1"));
    assert!(requests[1].starts_with("POST /toolbox/sb-9/process/execute HTTP/1.1"));
    assert!(requests[2].starts_with("DELETE /sandbox/sb-9 HTTP/1.1"));
}

#[tokio::test]
async fn exec_refuses_a_toolbox_host_that_would_leak_the_token() {
    let _lock = lock_env();
    // The API is plain HTTP here, so an HTTP toolbox is fine; a non-HTTP one is not.
    let (base, server) = scripted_server(vec![("200 OK", r#"{"url":"file:///etc/passwd"}"#)]);
    let _restore = RestoreEnv::point_at(&base);

    let error = DaytonaSandbox::new()
        .exec_in_workspace(
            &WorkspaceId("ws-2".into()),
            ExecSpec::new("true", Vec::new()),
        )
        .await
        .expect_err("an unusable toolbox URL is refused");
    assert!(error.to_string().contains("unusable toolbox proxy URL"));
    assert_eq!(server.join().unwrap().len(), 1, "no request reached the toolbox");
}
