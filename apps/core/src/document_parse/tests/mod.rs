use crate::document_parse::*;

/// The server route source (`server/mod.rs` and the submodules split out of
/// it), read as text. The route table is a builder
/// chain inside an `async fn` that needs a live `ServerState`, so there is no
/// cheap way to introspect the assembled `Router` for a path; the two source
/// tests below therefore read the registration the same way
/// `server::mod`'s own guard tests read theirs (`include_str!("voice_ws.rs")`,
/// `include_str!("learning.rs")`).
static SERVER_MOD_SRC: std::sync::LazyLock<String> =
    std::sync::LazyLock::new(crate::server::tests::source_text::server_source);

/// Whether the route table registers `path` as a literal route.
///
/// Anchored on `.route(` + the QUOTED path, not a bare `contains`. Two ways a
/// bare substring test lies here, and this module trips both:
///
/// - `"/api/documents/parse"` is a prefix of the registered
///   `"/api/documents/parse/capability"`, so `contains` on the unquoted form
///   cannot tell the submit route from the capability route;
/// - rustfmt moves a registration onto its own lines once the handler list
///   grows, so an indentation-sensitive needle reports a mounted route as
///   absent.
///
/// The closing quote is what makes the prefix case exact; `\s*` is what makes
/// it formatting-proof. Mirrors `isRegistered` in
/// `apps/desktop/src/lib/api/documents.test.ts`, deliberately: the same
/// question is asked from both sides of the wire.
fn is_registered(path: &str) -> bool {
    let needle = format!("\"{path}\"");
    SERVER_MOD_SRC.match_indices(".route(").any(|(at, marker)| {
        let rest = SERVER_MOD_SRC[at + marker.len()..].trim_start();
        rest.starts_with(&needle)
    })
}

mod floor_refuses;
mod missing_blob;
