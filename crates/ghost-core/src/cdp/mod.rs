// CDP bridge — Chrome DevTools Protocol over HTTP + WebSocket.
//
// Chrome must be launched with --remote-debugging-port=9222.
// Provides element finding in pages where the AX tree is empty or incomplete
// (iframes, canvas-heavy SPAs, Gmail, Figma, etc.).
//
// Port from ghost-os/Sources/GhostOS/Vision/CDPBridge.swift.

use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};

const CDP_HTTP: &str = "http://127.0.0.1:9222/json";
const HTTP_TIMEOUT_MS: u64 = 1500;
const WS_TIMEOUT_MS: u64 = 3000;

/// One element found via CDP Runtime.evaluate.
/// Coordinates are viewport-relative (not screen-absolute).
#[derive(Debug, Clone)]
pub struct CdpElement {
    /// Viewport-relative horizontal center.
    pub center_x: f64,
    /// Viewport-relative vertical center.
    pub center_y: f64,
    pub text: String,
    pub tag: String,
    pub match_type: String,
}

/// Returns `true` if Chrome is listening on port 9222.
pub async fn is_available() -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(HTTP_TIMEOUT_MS))
        .build()
    else {
        return false;
    };
    client.get(CDP_HTTP).send().await.is_ok()
}

/// Find elements matching `query` in the frontmost Chrome tab.
///
/// Uses five strategies in order: aria-label, placeholder, text content,
/// label-for, title/alt — same as CDPBridge.swift.
pub async fn find_elements(query: &str) -> Result<Vec<CdpElement>> {
    // 1. List open tabs via HTTP
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(HTTP_TIMEOUT_MS))
        .build()?;
    let tabs: Value = client.get(CDP_HTTP).send().await?.json().await?;

    let ws_url = tabs
        .as_array()
        .and_then(|a| a.iter().find(|t| t["type"].as_str() == Some("page")))
        .and_then(|t| t["webSocketDebuggerUrl"].as_str())
        .ok_or_else(|| anyhow::anyhow!("No Chrome page tab found on port 9222"))?
        .to_string();

    // 2. Open WebSocket connection to the tab
    let (mut ws, _) = tokio::time::timeout(
        std::time::Duration::from_millis(WS_TIMEOUT_MS),
        tokio_tungstenite::connect_async(&ws_url),
    )
    .await
    .map_err(|_| anyhow::anyhow!("WebSocket connect timeout"))??;

    // 3. Build the JS element-matching expression (5 strategies, de-duplicated by position)
    //    Sanitise query for template literal embedding.
    let q = query.replace('`', "\\`").replace('\\', "\\\\");
    let js = format!(
        r#"
(() => {{
  const q = `{q}`;
  const ql = q.toLowerCase();
  const dedup = new Set();
  const out = [];
  const push = (e, mt) => {{
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const key = `${{Math.round(r.x)}}_${{Math.round(r.y)}}`;
    if (dedup.has(key)) return;
    dedup.add(key);
    out.push({{
      text: e.textContent.trim().slice(0, 80),
      tag:  e.tagName.toLowerCase(),
      role: e.getAttribute('role') || '',
      centerX: r.x + r.width  / 2,
      centerY: r.y + r.height / 2,
      matchType: mt,
    }});
  }};
  // 1. aria-label
  Array.from(document.querySelectorAll('[aria-label]'))
    .filter(e => (e.getAttribute('aria-label') || '').toLowerCase().includes(ql))
    .forEach(e => push(e, 'aria-label'));
  // 2. placeholder
  Array.from(document.querySelectorAll('input[placeholder],textarea[placeholder]'))
    .filter(e => (e.getAttribute('placeholder') || '').toLowerCase().includes(ql))
    .forEach(e => push(e, 'placeholder'));
  // 3. text content (buttons, links, tabs, menu items)
  Array.from(document.querySelectorAll('button,a,[role="tab"],[role="menuitem"],[role="option"]'))
    .filter(e => e.textContent.trim().toLowerCase().includes(ql))
    .forEach(e => push(e, 'text'));
  // 4. label element text → associated input
  Array.from(document.querySelectorAll('label'))
    .filter(e => e.textContent.trim().toLowerCase().includes(ql))
    .map(l => document.getElementById(l.getAttribute('for') || '') || l)
    .forEach(e => push(e, 'label'));
  // 5. title / alt attributes
  Array.from(document.querySelectorAll('[title],[alt]'))
    .filter(e => ((e.getAttribute('title') || '') + (e.getAttribute('alt') || '')).toLowerCase().includes(ql))
    .forEach(e => push(e, 'title'));
  // 6. CSS selector (for dom_class queries like ".myClass" or id-selectors)
  if (q.startsWith('.') || q.startsWith('\x23')) {{
    try {{
      Array.from(document.querySelectorAll(q)).forEach(e => push(e, 'css'));
    }} catch(e) {{}}
  }}
  return out.slice(0, 20);
}})()
"#
    );

    // 4. Send Runtime.evaluate command
    let cmd = json!({
        "id": 1,
        "method": "Runtime.evaluate",
        "params": { "expression": js, "returnByValue": true }
    });
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        cmd.to_string(),
    ))
    .await?;

    // 5. Read response — skip Ping/Pong/Close; match on id=1
    let resp_text = tokio::time::timeout(std::time::Duration::from_millis(WS_TIMEOUT_MS), async {
        loop {
            match ws.next().await {
                Some(Ok(tokio_tungstenite::tungstenite::Message::Text(t))) => {
                    let v: Value = serde_json::from_str(&t)?;
                    if v["id"] == 1 {
                        return Ok::<_, anyhow::Error>(t);
                    }
                }
                Some(Ok(_)) => continue, // Ping, Pong, Binary — skip
                Some(Err(e)) => return Err(anyhow::anyhow!("WebSocket error: {e}")),
                None => return Err(anyhow::anyhow!("WebSocket closed unexpectedly")),
            }
        }
    })
    .await
    .map_err(|_| anyhow::anyhow!("WebSocket response timeout"))??;

    // 6. Parse results from Runtime.evaluate response
    let resp: Value = serde_json::from_str(&resp_text)?;
    let items = resp["result"]["result"]["value"]
        .as_array()
        .cloned()
        .unwrap_or_default();

    Ok(items
        .iter()
        .filter_map(|item| {
            Some(CdpElement {
                center_x: item["centerX"].as_f64()?,
                center_y: item["centerY"].as_f64()?,
                text: item["text"].as_str().unwrap_or("").to_string(),
                tag: item["tag"].as_str().unwrap_or("").to_string(),
                match_type: item["matchType"].as_str().unwrap_or("").to_string(),
            })
        })
        .collect())
}

/// Convert viewport-relative coordinates to screen-absolute coordinates.
///
/// Chrome reports element positions relative to the viewport (top-left of page
/// content area). To click them we need screen-absolute coords, which requires
/// adding the Chrome window origin and the browser chrome height (toolbar).
///
/// `win_x`, `win_y` — screen position of the Chrome window's top-left corner.
/// Chrome toolbar height (title bar 36px + toolbar 52px) is hardcoded at 88px,
/// matching CDPBridge.swift's value.
pub fn viewport_to_screen(vp_x: f64, vp_y: f64, win_x: i32, win_y: i32) -> (i32, i32) {
    const CHROME_TOOLBAR_HEIGHT: i32 = 88;
    (
        win_x + vp_x as i32,
        win_y + CHROME_TOOLBAR_HEIGHT + vp_y as i32,
    )
}
