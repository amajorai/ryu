//! Open Graph link previews fetched through public-only DNS pinning.

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LinkMetadataPreview {
    description: Option<String>,
    image: Option<String>,
    site_name: Option<String>,
    title: Option<String>,
    url: String,
}

pub(crate) fn is_public_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(ip) => {
            let octets = ip.octets();
            let is_shared_carrier_space = octets[0] == 100 && (64..=127).contains(&octets[1]);
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_multicast()
                || ip.is_unspecified()
                || is_shared_carrier_space)
        }
        std::net::IpAddr::V6(ip) => {
            if let Some(ipv4) = ip.to_ipv4_mapped() {
                return is_public_ip(std::net::IpAddr::V4(ipv4));
            }
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
                || ip.is_multicast())
        }
    }
}

pub(crate) async fn public_url_client(url: &reqwest::Url) -> Result<reqwest::Client, String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Only http and https links can be previewed.".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Link has no host.".to_string())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "Link has no usable port.".to_string())?;
    let addresses: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| format!("Could not resolve link host: {e}"))?
        .collect();
    if addresses.is_empty() || addresses.iter().any(|addr| !is_public_ip(addr.ip())) {
        return Err("Private and local network links are not previewed.".to_string());
    }
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(8))
        .user_agent("Ryu-Link-Preview/1.0");
    if host.parse::<std::net::IpAddr>().is_err() {
        builder = builder.resolve(host, addresses[0]);
    }
    builder.build().map_err(|e| e.to_string())
}

pub(crate) async fn fetch_public_bytes(
    mut url: reqwest::Url,
    max_bytes: usize,
) -> Result<(reqwest::Url, reqwest::header::HeaderMap, Vec<u8>), String> {
    for _ in 0..4 {
        let client = public_url_client(&url).await?;
        let mut response = client
            .get(url.clone())
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "Preview redirect had no location.".to_string())?;
            url = url.join(location).map_err(|e| e.to_string())?;
            continue;
        }
        if !response.status().is_success() {
            return Err(format!("Preview request failed: {}", response.status()));
        }
        let headers = response.headers().clone();
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            if bytes.len() + chunk.len() > max_bytes {
                return Err("Preview response was too large.".to_string());
            }
            bytes.extend_from_slice(&chunk);
        }
        return Ok((url, headers, bytes));
    }
    Err("Preview followed too many redirects.".to_string())
}

pub(crate) fn html_attribute(tag: &str, name: &str) -> Option<String> {
    for quote in ['"', '\''] {
        let needle = format!("{name}={quote}");
        let Some(start_offset) = tag.find(&needle) else {
            continue;
        };
        let start = start_offset + needle.len();
        let Some(end_offset) = tag[start..].find(quote) else {
            continue;
        };
        let end = end_offset + start;
        return Some(tag[start..end].trim().to_string());
    }
    None
}

pub(crate) fn metadata_content(html: &str, keys: &[&str]) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(offset) = lower[cursor..].find("<meta") {
        let start = cursor + offset;
        let Some(relative_end) = lower[start..].find('>') else {
            break;
        };
        let end = start + relative_end + 1;
        let tag = &html[start..end];
        let tag_lower = &lower[start..end];
        let property =
            html_attribute(tag_lower, "property").or_else(|| html_attribute(tag_lower, "name"));
        if property
            .as_deref()
            .is_some_and(|value| keys.iter().any(|key| value == *key))
        {
            return html_attribute(tag, "content");
        }
        cursor = end;
    }
    None
}

pub(crate) fn html_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title>")? + "<title>".len();
    let end = lower[start..].find("</title>")? + start;
    Some(html[start..end].trim().to_string()).filter(|value| !value.is_empty())
}

pub(crate) async fn preview_image_data_url(page_url: &reqwest::Url, raw: &str) -> Option<String> {
    use base64::Engine;
    let url = page_url.join(raw).ok()?;
    let (_, headers, bytes) = fetch_public_bytes(url, 2 * 1024 * 1024).await.ok()?;
    let content_type = headers
        .get(reqwest::header::CONTENT_TYPE)?
        .to_str()
        .ok()?
        .split(';')
        .next()?
        .trim();
    if !content_type.starts_with("image/") {
        return None;
    }
    Some(format!(
        "data:{content_type};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// Fetch Open Graph metadata for a hover preview. The shell performs the request
/// because the webview is CORS-bound; every hop is pinned to a public DNS result.
#[tauri::command]
pub(crate) async fn preview_link_metadata(url: String) -> Result<LinkMetadataPreview, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("Invalid URL: {e}"))?;
    let (final_url, headers, bytes) = fetch_public_bytes(parsed, 512 * 1024).await?;
    let content_type = headers
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !content_type.contains("text/html") {
        return Ok(LinkMetadataPreview {
            description: None,
            image: None,
            site_name: None,
            title: None,
            url: final_url.to_string(),
        });
    }
    let html = String::from_utf8_lossy(&bytes);
    let image_raw = metadata_content(&html, &["og:image", "twitter:image"]);
    let image = match image_raw {
        Some(raw) => preview_image_data_url(&final_url, &raw).await,
        None => None,
    };
    Ok(LinkMetadataPreview {
        description: metadata_content(
            &html,
            &["og:description", "twitter:description", "description"],
        ),
        image,
        site_name: metadata_content(&html, &["og:site_name"]),
        title: metadata_content(&html, &["og:title", "twitter:title"])
            .or_else(|| html_title(&html)),
        url: final_url.to_string(),
    })
}
