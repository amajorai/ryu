//! Response-side cookie isolation for the ext-proxy.
//!
//! Every app's proxied responses share Core's browser origin. The request side
//! already forwards only the browser cookies an app declared in its own manifest
//! namespace (`HttpProxySpec::forward_cookie_names`). This module enforces the
//! matching response-side rule: an upstream `Set-Cookie` crosses the proxy only
//! when it names one of the hop plugin's declared cookies. Any other name could
//! only overwrite or fixate a cookie that belongs to Core or to another app on the
//! same origin, because Core would never forward it back to the app that set it.

use std::collections::HashSet;

/// The cookie name a `Set-Cookie` header value sets, or `None` when the value is
/// not valid UTF-8 or carries no `name=` pair (a nameless cookie).
fn set_cookie_name(value: &[u8]) -> Option<&str> {
    let raw = std::str::from_utf8(value).ok()?;
    let pair = raw.split(';').next()?;
    let (name, _value) = pair.split_once('=')?;
    let name = name.trim();
    (!name.is_empty()).then_some(name)
}

/// Whether an upstream `Set-Cookie` header value may reach the browser.
///
/// Fails closed: only exact, case-sensitive matches against the hop plugin's
/// declared cookie names pass. Undeclared names, nameless cookies and malformed
/// values are dropped.
pub(super) fn set_cookie_allowed(value: &[u8], declared_cookie_names: &[String]) -> bool {
    let Some(name) = set_cookie_name(value) else {
        return false;
    };
    let declared: HashSet<&str> = declared_cookie_names.iter().map(String::as_str).collect();
    declared.contains(name)
}

#[cfg(test)]
mod tests {
    use super::super::{forward_to_sidecar, ForwardArgs};
    use super::*;
    use crate::sidecar::manager::ForwardTarget;
    use axum::http::{HeaderMap, StatusCode};

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|name| (*name).to_owned()).collect()
    }

    #[test]
    fn declared_cookie_names_pass() {
        let declared = names(&["ryu_rooms_session"]);
        assert!(set_cookie_allowed(
            b"ryu_rooms_session=abc; Path=/api/rooms; HttpOnly; SameSite=Strict",
            &declared
        ));
        assert!(set_cookie_allowed(
            b" ryu_rooms_session =; Max-Age=0",
            &declared
        ));
    }

    #[test]
    fn foreign_nameless_and_malformed_cookies_are_dropped() {
        let declared = names(&["acme_a_session"]);
        for value in [
            b"ryu_rooms_session=attacker; Path=/api/rooms".as_slice(),
            b"better-auth.session_token=x; Path=/",
            b"ACME_A_SESSION=x",
            b"acme_a_session_extra=x",
            b"no-equals-sign; Path=/",
            b"=value-only",
            b"",
            &[0xff, b'=', b'x'],
        ] {
            assert!(
                !set_cookie_allowed(value, &declared),
                "{:?} must be dropped",
                String::from_utf8_lossy(value)
            );
        }
        assert!(!set_cookie_allowed(b"acme_a_session=x", &[]));
    }

    /// Regression for cross-app cookie fixation on the shared origin: a stub app
    /// sidecar answers with its own declared cookie plus another app's session
    /// cookie and Core's auth cookie. Only the declared one may reach the browser;
    /// unrelated response headers still pass through.
    #[tokio::test]
    async fn proxied_responses_carry_only_the_apps_declared_cookies() {
        use axum::response::IntoResponse;
        use axum::routing::get;
        use axum::Router;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = Router::new().route(
            "/page",
            get(|| async {
                let mut headers = HeaderMap::new();
                for cookie in [
                    "acme_a_session=mine; Path=/api/ext/com.acme.a; HttpOnly",
                    "ryu_rooms_session=attacker; Path=/api/rooms; HttpOnly",
                    "better-auth.session_token=attacker; Path=/",
                ] {
                    headers.append("set-cookie", cookie.parse().unwrap());
                }
                headers.insert("x-app-marker", "kept".parse().unwrap());
                (headers, "PAGE").into_response()
            }),
        );
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let src_headers = HeaderMap::new();
        let declared = names(&["acme_a_session"]);
        let response = forward_to_sidecar(ForwardArgs {
            target: ForwardTarget::for_test(port),
            upstream_path: "/page",
            query: "",
            method: reqwest::Method::GET,
            src_headers: &src_headers,
            body: Vec::new(),
            hop_plugin_id: "com.acme.a",
            forward_payment_authorization: false,
            forward_cookie_names: &declared,
            forward_caller_email: false,
            caller: None,
            caller_resource_ids: None,
            caller_rate_subject: None,
            caller_agent_id: None,
            caller_agent_egress_allowlist: None,
            caller_agent_restricted: false,
            event_delivery: None,
            trusted_first_party: false,
        })
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let cookies: Vec<&str> = response
            .headers()
            .get_all("set-cookie")
            .iter()
            .map(|value| value.to_str().unwrap())
            .collect();
        assert_eq!(
            cookies,
            vec!["acme_a_session=mine; Path=/api/ext/com.acme.a; HttpOnly"]
        );
        assert_eq!(response.headers().get("x-app-marker").unwrap(), "kept");
    }
}
