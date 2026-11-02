//! Opening external URLs with the OS default handler.

/// Open a URL with the OS default handler. Only web/mail schemes are allowed:
/// callers pass backend-supplied URLs, and a hand-rolled command bypasses the
/// shell plugin's scope validation, so a `file://`/`smb://` URL from a spoofed
/// backend must never reach the opener.
#[tauri::command]
pub(crate) async fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    let mut parsed = tauri::Url::parse(&url).map_err(|e| format!("Invalid URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        return Err(format!(
            "Refusing to open URL with disallowed scheme '{}'.",
            parsed.scheme()
        ));
    }

    // A local desktop must never send device authorization to the hosted site.
    // The auth server can return a public verification origin when its
    // FRONTEND_URL has stale deployment defaults; keep the debug app on its
    // loopback Web server at the final OS-browser boundary as well.
    #[cfg(debug_assertions)]
    localize_debug_device_url(&mut parsed)?;

    app.shell()
        .open(parsed.as_str(), None)
        .map_err(|e| e.to_string())
}

#[cfg(debug_assertions)]
pub(crate) fn localize_debug_device_url(parsed: &mut tauri::Url) -> Result<(), String> {
    const DEBUG_FRONTEND_ORIGIN: &str = "http://localhost:3001";
    let is_loopback = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    let is_device_flow = parsed.path() == "/device"
        || (parsed.path() == "/login"
            && parsed.query().is_some_and(|query| query.contains("device")));
    if !(is_device_flow && !is_loopback) {
        return Ok(());
    }

    let origin = tauri::Url::parse(DEBUG_FRONTEND_ORIGIN)
        .map_err(|_| "Could not parse the debug frontend origin".to_string())?;
    parsed
        .set_scheme(origin.scheme())
        .map_err(|_| "Could not localize device verification scheme".to_string())?;
    parsed
        .set_host(origin.host_str())
        .map_err(|_| "Could not localize device verification host".to_string())?;
    parsed
        .set_port(origin.port())
        .map_err(|_| "Could not localize device verification port".to_string())?;
    Ok(())
}

#[cfg(test)]
mod debug_device_url_tests {
    #[cfg(debug_assertions)]
    use super::localize_debug_device_url;

    #[cfg(debug_assertions)]
    #[test]
    fn localizes_any_non_loopback_device_url() {
        let mut url = tauri::Url::parse("https://example.com/device?user_code=TEST").unwrap();

        localize_debug_device_url(&mut url).unwrap();

        assert_eq!(url.as_str(), "http://localhost:3001/device?user_code=TEST");
    }

    #[cfg(debug_assertions)]
    #[test]
    fn leaves_loopback_and_non_device_urls_untouched() {
        let mut loopback =
            tauri::Url::parse("http://127.0.0.1:5222/device?user_code=TEST").unwrap();
        let mut login = tauri::Url::parse("https://example.com/login?next=%2Fhome").unwrap();

        localize_debug_device_url(&mut loopback).unwrap();
        localize_debug_device_url(&mut login).unwrap();

        assert_eq!(
            loopback.as_str(),
            "http://127.0.0.1:5222/device?user_code=TEST"
        );
        assert_eq!(login.as_str(), "https://example.com/login?next=%2Fhome");
    }
}
