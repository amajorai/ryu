// Integration test: spawn ghost mcp, perform initialize handshake, verify tools/list.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

fn send_ndjson(stdin: &mut impl Write, msg: &str) {
    stdin.write_all(msg.as_bytes()).unwrap();
    stdin.write_all(b"\n").unwrap();
    stdin.flush().unwrap();
}

fn read_ndjson(reader: &mut BufReader<impl std::io::Read>) -> serde_json::Value {
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    serde_json::from_str(line.trim()).expect("valid JSON response")
}

#[test]
fn test_mcp_initialize_and_tools_list() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_ghost"))
        .arg("mcp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("failed to spawn ghost mcp");

    let mut stdin  = child.stdin.take().unwrap();
    let stdout     = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);

    // 1. Initialize
    send_ndjson(&mut stdin, r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#);
    let init_resp = read_ndjson(&mut reader);
    assert_eq!(init_resp["id"], 1);
    assert_eq!(init_resp["result"]["protocolVersion"], "2024-11-05");
    assert_eq!(init_resp["result"]["serverInfo"]["name"], "ghost");

    // 2. Notify initialized
    send_ndjson(&mut stdin, r#"{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}"#);

    // 3. List tools
    send_ndjson(&mut stdin, r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#);
    let list_resp = read_ndjson(&mut reader);
    assert_eq!(list_resp["id"], 2);
    let tools = list_resp["result"]["tools"].as_array().expect("tools array");
    assert_eq!(tools.len(), 29, "Expected exactly 29 tools, got {}", tools.len());

    // Verify some key tools exist
    let tool_names: Vec<&str> = tools.iter()
        .filter_map(|t| t["name"].as_str())
        .collect();
    for expected in &["ghost_context", "ghost_screenshot", "ghost_click", "ghost_annotate", "ghost_recipes"] {
        assert!(tool_names.contains(expected), "Missing tool: {expected}");
    }

    // 4. Ping
    send_ndjson(&mut stdin, r#"{"jsonrpc":"2.0","id":3,"method":"ping","params":{}}"#);
    let ping_resp = read_ndjson(&mut reader);
    assert_eq!(ping_resp["id"], 3);

    // Close stdin to trigger server shutdown
    drop(stdin);
    let _ = child.wait();
}
