//! The browser page an OAuth sign-in returns to, and the desktop loopback
//! listener that serves it.
//!
//! The vault cannot depend on Core's message catalog, so the page copy is
//! injected: Core registers a [`CallbackPageCopyFn`] that picks the reader's
//! language from the callback request's `Accept-Language`. Without one (tests,
//! other hosts) the page is English.

use std::future::Future;
use std::pin::Pin;
use std::sync::OnceLock;

use super::*;

/// The text of one callback page, already in the reader's language.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallbackPageCopy {
    /// BCP 47 tag for `<html lang>`.
    pub lang: String,
    /// `ltr` or `rtl`, for `<html dir>`.
    pub dir: String,
    pub title: String,
    pub detail: String,
}

impl CallbackPageCopy {
    /// The built-in English copy.
    pub fn english(connected: bool) -> Self {
        let (title, detail) = if connected {
            (
                "Connection complete",
                "You can close this window and return to Ryu.",
            )
        } else {
            (
                "Connection failed",
                "Return to Ryu for details and try connecting again.",
            )
        };
        Self {
            lang: "en".to_owned(),
            dir: "ltr".to_owned(),
            title: title.to_owned(),
            detail: detail.to_owned(),
        }
    }
}

/// Copy for a callback page: the request's `Accept-Language` header (if any)
/// and whether the connection completed.
pub type CallbackPageCopyFn = fn(
    accept_language: Option<String>,
    connected: bool,
) -> Pin<Box<dyn Future<Output = CallbackPageCopy> + Send>>;

static PAGE_COPY: OnceLock<CallbackPageCopyFn> = OnceLock::new();

/// Register the host's localized copy. The first registration wins.
pub fn set_callback_page_copy(copy: CallbackPageCopyFn) {
    let _ = PAGE_COPY.set(copy);
}

pub(super) async fn page_copy(
    accept_language: Option<String>,
    connected: bool,
) -> CallbackPageCopy {
    match PAGE_COPY.get() {
        Some(copy) => copy(accept_language, connected).await,
        None => CallbackPageCopy::english(connected),
    }
}

/// The callback page's HTML. Every value is escaped.
pub fn render_callback_page(copy: &CallbackPageCopy) -> String {
    let dir = if copy.dir == "rtl" { "rtl" } else { "ltr" };
    format!(
        "<!doctype html><html lang=\"{lang}\" dir=\"{dir}\"><meta charset=\"utf-8\"><meta name=\"referrer\" content=\"no-referrer\"><title>{title}</title><h1>{title}</h1><p>{detail}</p></html>",
        lang = escape_html(&copy.lang),
        title = escape_html(&copy.title),
        detail = escape_html(&copy.detail),
    )
}

fn escape_html(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
}

/// The `Accept-Language` header of a raw HTTP request.
fn accept_language(request: &str) -> Option<String> {
    request
        .lines()
        .skip(1)
        .take_while(|line| !line.is_empty())
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.trim()
                .eq_ignore_ascii_case("accept-language")
                .then(|| value.trim().to_owned())
        })
        .filter(|value| !value.is_empty())
}

pub(super) async fn accept_loopback_callback(
    manager: Arc<McpOAuthManager>,
    listener: TcpListener,
    flow_id: String,
) {
    let result = async {
        let (mut stream, _) = tokio::time::timeout(Duration::from_secs(FLOW_TTL_SECS as u64), listener.accept())
            .await
            .context("OAuth callback timed out")??;
        let mut buffer = vec![0_u8; 16 * 1024];
        let count = stream.read(&mut buffer).await.context("reading OAuth callback")?;
        let request = String::from_utf8_lossy(&buffer[..count]);
        let target = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .context("invalid OAuth callback request")?;
        let callback = Url::parse(&format!("http://127.0.0.1{target}"))?;
        let params: HashMap<String, String> = callback.query_pairs().into_owned().collect();
        let completion = manager
            .complete_callback(
                &flow_id,
                params.get("code").cloned(),
                params.get("state").cloned(),
                params.get("iss").cloned(),
                params.get("error").cloned(),
            )
            .await;
        let status = if completion.is_ok() { "200 OK" } else { "400 Bad Request" };
        let copy = page_copy(accept_language(&request), completion.is_ok()).await;
        let body = render_callback_page(&copy);
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Language: {lang}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len(),
            lang = copy.lang.replace(['\r', '\n'], ""),
        );
        stream.write_all(response.as_bytes()).await?;
        Result::<()>::Ok(())
    }
    .await;
    if let Err(error) = result {
        let _ = manager.fail_flow(&flow_id, &error.to_string()).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_default_copy_is_english_and_escaped() {
        // No host registered copy in this crate's tests.
        let copy = page_copy(Some("ar".to_owned()), true).await;
        assert_eq!(copy, CallbackPageCopy::english(true));
        let page = render_callback_page(&copy);
        assert!(page.contains("<html lang=\"en\" dir=\"ltr\">"), "{page}");
        assert!(page.contains("<h1>Connection complete</h1>"));
        assert!(page.contains("You can close this window and return to Ryu."));
        let failed = render_callback_page(&CallbackPageCopy::english(false));
        assert!(failed.contains("<title>Connection failed</title>"));

        let hostile = CallbackPageCopy {
            lang: "x\"><script>".to_owned(),
            dir: "sideways".to_owned(),
            title: "<b>".to_owned(),
            detail: "a & b".to_owned(),
        };
        let page = render_callback_page(&hostile);
        assert!(page.contains("lang=\"x&quot;&gt;&lt;script&gt;\" dir=\"ltr\""));
        assert!(page.contains("<h1>&lt;b&gt;</h1><p>a &amp; b</p>"));
    }

    #[test]
    fn the_accept_language_header_is_read_from_the_raw_request() {
        let request = "GET /callback?code=x HTTP/1.1\r\nHost: 127.0.0.1\r\naccept-language: ja,en;q=0.5\r\n\r\n";
        assert_eq!(accept_language(request).as_deref(), Some("ja,en;q=0.5"));
        assert_eq!(accept_language("GET / HTTP/1.1\r\nHost: x\r\n\r\n"), None);
    }
}
