//! Endpoint checks for the computer-use settings: Jev may be any HTTPS URL,
//! Laya must stay on the local Core loopback address.

pub(super) fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

pub(super) fn is_loopback_base_url(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    is_loopback_host(url.host_str().unwrap_or_default())
        && matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && matches!(url.path(), "" | "/")
}

pub(super) fn validate_endpoint(value: &str, loopback_only: bool) -> Result<(), &'static str> {
    if value.len() > 2048 {
        return Err("computer-use endpoint URLs must be at most 2048 bytes");
    }
    let url = url::Url::parse(value).map_err(|_| "computer-use endpoint must be a valid URL")?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("computer-use endpoints cannot contain credentials, query, or fragment");
    }
    let loopback = is_loopback_host(url.host_str().unwrap_or_default());
    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
        _ => return Err("computer-use endpoints require HTTPS; HTTP is loopback-only"),
    }
    if loopback_only && !loopback {
        return Err("layaUrl must use the local Core loopback address");
    }
    Ok(())
}
