//! The canonical verb table.

use super::*;

/// The canonical verb table. Adding a verb here is a contract change: providers opt
/// in by declaring it in `provides[].tools`, and a verb no provider declares is
/// simply never listed.
///
/// ## Every verb here is served by at least one shipped provider
///
/// That was not true when the table was written — six verbs were forward-declared
/// placeholders — and the gap was not a design problem but a GRAMMAR one: the binding
/// language could rename keys and array-wrap a scalar, so any provider whose request
/// body was an array of objects (Mem0's `messages: [{role, content}]`) was unbindable
/// in principle. `arg_template` closed it, and the browser sidecar gained real
/// accessibility-tree and synthetic-input routes.
///
/// Keep it that way when adding a verb: a verb no provider can serve is never
/// advertised, so it fails silently rather than loudly. Before adding one, name the
/// provider that will serve it and check the grammar can express its request shape.
///
/// Every verb is also one promoted capability in Ryu's capability taxonomy
/// (`crates/gateway/contracts/fixtures/capability-taxonomy-v1.json`), with `layer`
/// set to the verb's `capability`. Add the taxonomy row in the same change;
/// `ryu-gw-contracts`' `capability_taxonomy_fixture` test reads this table and
/// fails until it is there.
pub fn verbs() -> &'static [Verb] {
    &[
        Verb {
            id: "decision.predict",
            server: SERVER_DECISION,
            name: "predict",
            capability: CAP_DECISION_TYPED,
            description: "Answer typed choice, score, or yes/no questions about a text or JSON state. Uses the currently selected Decision Models provider and returns structured answers rather than prose.",
            schema: schema_decision_predict,
        },
        Verb {
            id: "decision.predict_multimodal",
            server: SERVER_DECISION,
            name: "predict_multimodal",
            capability: CAP_DECISION_TYPED,
            description: "Answer typed questions about a text or JSON state plus embedded images. This verb appears only when the selected Decision Models provider supports image inputs.",
            schema: schema_decision_predict_multimodal,
        },
        Verb {
            id: "verify.claim",
            server: SERVER_VERIFY,
            name: "claim",
            capability: CAP_VERIFY,
            description: "Check a plain-language claim against a source of truth and return a \
                          verdict: proved (the source entails it), refuted (the source contradicts \
                          it, with a counterexample), undecided (consistent but not implied), \
                          inconsistent (the source contradicts itself), or unverifiable (no verdict \
                          covers the whole claim, as when only part of it could be checked). Only \
                          `proved` means the claim is backed. Backed by the currently selected \
                          verification provider.",
            schema: schema_verify_claim,
        },
        Verb {
            id: "verify.scopes",
            server: SERVER_VERIFY,
            name: "scopes",
            capability: CAP_VERIFY,
            description: "List the sources of truth verify.claim can check against, with their ids, \
                          names, and descriptions.",
            schema: schema_empty,
        },
        Verb {
            id: "web.search",
            server: SERVER_WEB,
            name: "search",
            capability: CAP_WEB_SEARCH,
            description: "Search the web and return ranked results (title, url, snippet). Backed by \
                          the currently selected search provider; the tool and its result shape are \
                          the same whichever provider is selected.",
            schema: schema_search,
        },
        Verb {
            id: "web.extract",
            server: SERVER_WEB,
            name: "extract",
            capability: CAP_WEB_EXTRACT,
            description: "Extract the readable content of a single web page. Backed by the currently \
                          selected extraction provider.",
            schema: schema_extract,
        },
        Verb {
            id: "web.crawl",
            server: SERVER_WEB,
            name: "crawl",
            capability: CAP_WEB_CRAWL,
            description: "Crawl a site from a start URL, following links, and return the extracted \
                          pages. Backed by the currently selected crawl provider.",
            schema: schema_crawl,
        },
        Verb {
            id: "browser.navigate",
            server: SERVER_BROWSER,
            name: "navigate",
            capability: CAP_BROWSER,
            description: "Open a URL in a real browser and return the resulting tab. Backed by the \
                          currently selected browser provider (local Chromium or a cloud browser).",
            schema: schema_browser_navigate,
        },
        Verb {
            id: "browser.snapshot",
            server: SERVER_BROWSER,
            name: "snapshot",
            capability: CAP_BROWSER,
            description: "Return the page's accessibility tree with stable element references \
                          (@e1, @e2, …) to use with browser.click and browser.type.",
            schema: schema_browser_tab_only,
        },
        Verb {
            id: "browser.click",
            server: SERVER_BROWSER,
            name: "click",
            capability: CAP_BROWSER,
            description: "Click an element identified by a reference from browser.snapshot.",
            schema: schema_browser_click,
        },
        Verb {
            id: "browser.type",
            server: SERVER_BROWSER,
            name: "type",
            capability: CAP_BROWSER,
            description: "Type text into an element identified by a reference from browser.snapshot. \
                          Text is inserted at the caret and APPENDS by default — pass `replace` to \
                          overwrite a field that already has a value.",
            schema: schema_browser_type,
        },
        Verb {
            id: "browser.scroll",
            server: SERVER_BROWSER,
            name: "scroll",
            capability: CAP_BROWSER,
            description: "Scroll the page in a direction.",
            schema: schema_browser_scroll,
        },
        Verb {
            id: "browser.screenshot",
            server: SERVER_BROWSER,
            name: "screenshot",
            capability: CAP_BROWSER,
            description: "Capture a screenshot of the page, for visual content the accessibility \
                          tree cannot describe.",
            schema: schema_browser_tab_only,
        },
        Verb {
            id: "browser.tabs",
            server: SERVER_BROWSER,
            name: "tabs",
            capability: CAP_BROWSER,
            description: "List the open browser tabs with their ids, urls, and titles.",
            schema: schema_browser_tabs,
        },
        Verb {
            id: "browser.context",
            server: SERVER_BROWSER,
            name: "context",
            capability: CAP_BROWSER,
            description: "Return the current page's screenshot, accessibility snapshot, saved annotations, and optional DOM context for pointed elements.",
            schema: schema_browser_context,
        },
        Verb {
            id: "browser.annotate",
            server: SERVER_BROWSER,
            name: "annotate",
            capability: CAP_BROWSER,
            description: "Attach a frozen-frame visual comment to a browser element, group of elements, or area so the next agent turn can act on it.",
            schema: schema_browser_annotate,
        },
        Verb {
            id: "browser.clear_annotations",
            server: SERVER_BROWSER,
            name: "clear_annotations",
            capability: CAP_BROWSER,
            description: "Clear the saved visual annotations from a browser tab.",
            schema: schema_browser_tab_only,
        },
        Verb {
            id: "browser.hover",
            server: SERVER_BROWSER,
            name: "hover",
            capability: CAP_BROWSER,
            description: "Move the real pointer over a snapshot element without clicking it.",
            schema: schema_browser_hover,
        },
        Verb {
            id: "browser.click_at",
            server: SERVER_BROWSER,
            name: "click_at",
            capability: CAP_BROWSER,
            description: "Click a CSS-pixel viewport coordinate when no accessibility reference exists, such as a canvas control.",
            schema: schema_browser_click_at,
        },
        Verb {
            id: "browser.key",
            server: SERVER_BROWSER,
            name: "key",
            capability: CAP_BROWSER,
            description: "Press a browser key or key chord at the current focus.",
            schema: schema_browser_key,
        },
        Verb {
            id: "browser.drag",
            server: SERVER_BROWSER,
            name: "drag",
            capability: CAP_BROWSER,
            description: "Drag the real browser pointer between two CSS-pixel viewport coordinates.",
            schema: schema_browser_drag,
        },
        Verb {
            id: "browser.fill_credential",
            server: SERVER_BROWSER,
            name: "fill_credential",
            capability: CAP_BROWSER,
            description: "Fill one field (username, email, password or authenticator code) of an account into the input a browser.snapshot `ref` names, without you ever seeing the value. Pass an account id from your account list (browser.list_credentials) or an attached item's handle. In a session Box a password is typed as a one-time placeholder, and the site receives the real value only when the page submits it to the account's login URL; if the password field then holds text you did not type, that is expected, so do not copy it. For your own accounts the login URL is the one you saved on the account. Never ask the user for a password and never type one with browser.type.",
            schema: schema_browser_fill_credential,
        },
        Verb {
            id: "browser.list_credentials",
            server: SERVER_BROWSER,
            name: "list_credentials",
            capability: CAP_BROWSER,
            description: "List the accounts you may fill with browser.fill_credential: your own accounts (id, site, username, email, whether a password and an authenticator are set, and their login URLs) and the items the user attached to your browser session (handle, site, fillable fields, and whether a login URL binds them). Metadata only: it never returns a password, code or seed.",
            schema: schema_browser_list_credentials,
        },
        Verb {
            id: "computer.capture",
            server: SERVER_COMPUTER,
            name: "capture",
            capability: CAP_COMPUTER,
            description: "Capture the screen with accessibility metadata, so subsequent computer.* \
                          calls can target what is on screen.",
            schema: schema_computer_capture,
        },
        Verb {
            id: "computer.click",
            server: SERVER_COMPUTER,
            name: "click",
            capability: CAP_COMPUTER,
            description: "Click at a screen coordinate.",
            schema: schema_computer_click,
        },
        Verb {
            id: "computer.type",
            server: SERVER_COMPUTER,
            name: "type",
            capability: CAP_COMPUTER,
            description: "Type text into whatever currently has keyboard focus.",
            schema: schema_computer_type,
        },
        Verb {
            id: "computer.key",
            server: SERVER_COMPUTER,
            name: "key",
            capability: CAP_COMPUTER,
            description: "Press a key or key chord.",
            schema: schema_computer_key,
        },
        Verb {
            id: "computer.scroll",
            server: SERVER_COMPUTER,
            name: "scroll",
            capability: CAP_COMPUTER,
            description: "Scroll at a screen coordinate.",
            schema: schema_computer_scroll,
        },
        Verb {
            id: "computer.focus_app",
            server: SERVER_COMPUTER,
            name: "focus_app",
            capability: CAP_COMPUTER,
            description: "Bring an application to the front before interacting with it.",
            schema: schema_computer_focus_app,
        },
        Verb {
            id: "memory.search",
            server: SERVER_MEMORY,
            name: "search",
            capability: CAP_MEMORY,
            description: "Recall durable facts from long-term memory. Backed by the currently \
                          selected memory provider; the built-in store is always available.",
            schema: schema_memory_search,
        },
        Verb {
            id: "memory.store",
            server: SERVER_MEMORY,
            name: "store",
            capability: CAP_MEMORY,
            description: "Remember a durable fact at a given scope level (agent, user, node, \
                          project, or org).",
            schema: schema_memory_store,
        },
        Verb {
            id: "memory.context",
            server: SERVER_MEMORY,
            name: "context",
            capability: CAP_MEMORY,
            description: "Ask the memory provider for a short standing summary of what it knows \
                          about this user — the provider's own synthesis, not a list of raw \
                          facts. Providers that model a user over time (Honcho's dialectic, \
                          Mem0's summaries) serve this; ones that only do retrieval do not.",
            schema: schema_memory_context,
        },
        Verb {
            id: "memory.sync",
            server: SERVER_MEMORY,
            name: "sync",
            capability: CAP_MEMORY,
            description: "Hand a raw conversation turn to the memory provider and let IT decide \
                          what is worth remembering. Distinct from memory.store, which records \
                          a fact you have already decided on: sync delegates the extraction, \
                          which is how server-side-extraction providers are meant to be fed.",
            schema: schema_memory_sync,
        },
        Verb {
            id: "memory.forget",
            server: SERVER_MEMORY,
            name: "forget",
            capability: CAP_MEMORY,
            description: "Delete a remembered fact by id.",
            schema: schema_memory_forget,
        },
    ]
}
