//! The two pure rules of a forced catalog install (CE-18 part 2).

use super::*;

fn remote(catalog_id: Option<&str>, url: &str) -> McpServerConfig {
    McpServerConfig {
        transport: Some("streamable-http".to_owned()),
        url: Some(url.to_owned()),
        catalog_id: catalog_id.map(str::to_owned),
        ..Default::default()
    }
}

fn local(catalog_id: Option<&str>, command: &str, args: &[&str]) -> McpServerConfig {
    McpServerConfig {
        command: Some(command.to_owned()),
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
        catalog_id: catalog_id.map(str::to_owned),
        ..Default::default()
    }
}

const ID: Option<&str> = Some("io.github.acme/weather");

#[test]
fn a_remote_target_is_the_same_only_on_the_same_origin() {
    let saved = remote(ID, "https://mcp.acme.com/weather");
    // The path, the query and the spelling of the host may change.
    for url in [
        "https://mcp.acme.com/weather",
        "https://mcp.acme.com/v2/weather?region=eu",
        "https://MCP.Acme.com:443/weather",
    ] {
        assert!(same_install_target(&saved, &remote(ID, url)), "{url}");
    }
    // Another host, another port, another scheme, a host that only starts
    // with the saved one, and a URL that does not parse.
    for url in [
        "https://mcp.evil.example/weather",
        "https://mcp.acme.com:8443/weather",
        "http://mcp.acme.com/weather",
        "https://mcp.acme.com.evil.example/weather",
        "https://mcp.acme.com@evil.example/weather",
        "not a url",
    ] {
        assert!(!same_install_target(&saved, &remote(ID, url)), "{url}");
    }
}

#[test]
fn a_target_is_never_the_same_without_the_same_catalog_id() {
    let url = "https://mcp.acme.com/weather";
    // A server the user added by hand records no catalog id.
    assert!(!same_install_target(&remote(None, url), &remote(ID, url)));
    assert!(!same_install_target(
        &remote(Some(" "), url),
        &remote(ID, url)
    ));
    assert!(!same_install_target(
        &remote(Some("io.github.other/weather"), url),
        &remote(ID, url)
    ));
    assert!(!same_install_target(&remote(ID, url), &remote(None, url)));
    assert!(!same_install_target(
        &local(None, "npx", &["-y", "@acme/mcp@1.0.0"]),
        &local(ID, "npx", &["-y", "@acme/mcp@1.0.0"])
    ));
}

#[test]
fn a_local_target_is_the_same_only_with_the_same_command() {
    let saved = local(ID, "npx", &["--ignore-scripts", "-y", "@acme/mcp@1.4.0"]);
    // An update changes the pinned version in the arguments.
    assert!(same_install_target(
        &saved,
        &local(ID, " npx ", &["--ignore-scripts", "-y", "@acme/mcp@1.5.0"])
    ));
    assert!(!same_install_target(
        &saved,
        &local(ID, "uvx", &["acme-mcp==1.5.0"])
    ));
    assert!(!same_install_target(&saved, &local(ID, "", &[])));
}

#[test]
fn a_change_between_local_and_remote_is_a_new_target() {
    let hosted = remote(ID, "https://mcp.acme.com/weather");
    let package = local(ID, "npx", &["-y", "@acme/mcp@1.4.0"]);
    assert!(!same_install_target(&hosted, &package));
    assert!(!same_install_target(&package, &hosted));
    // The legacy SSE transport on the same origin is still the same server.
    let mut sse = remote(ID, "https://mcp.acme.com/sse");
    sse.transport = Some("sse".to_owned());
    assert!(same_install_target(&sse, &hosted));
}

#[test]
fn a_catalog_remote_must_be_https() {
    assert_eq!(
        catalog_remote_url_refusal("https://mcp.acme.com/weather", None),
        None
    );
    let refusal = catalog_remote_url_refusal("http://mcp.acme.com/weather?api_key=k-123", None)
        .expect("plain http is refused");
    assert!(refusal.contains("plain http"), "{refusal}");
    // The message names the server, never a credential in the URL.
    assert!(refusal.contains("mcp.acme.com"), "{refusal}");
    assert!(!refusal.contains("k-123"), "{refusal}");
    assert!(catalog_remote_url_refusal("file:///etc/passwd", None).is_some());
    assert!(catalog_remote_url_refusal("not a url", None).is_some());
}

#[test]
fn plain_http_is_accepted_only_for_an_allowlisted_development_host() {
    let url = "http://127.0.0.1:3000/mcp";
    assert!(catalog_remote_url_refusal(url, None).is_some());
    assert!(catalog_remote_url_refusal(url, Some("127.0.0.1:3001")).is_some());
    assert_eq!(
        catalog_remote_url_refusal(url, Some("example.com, 127.0.0.1:3000")),
        None
    );
    // The allowlist widens which hosts may use http, never which schemes.
    assert!(catalog_remote_url_refusal("file:///etc/passwd", Some("*")).is_some());
}
