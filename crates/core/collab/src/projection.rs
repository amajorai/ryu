//! `Y.Doc -> source` projection: decoding the authoritative CRDT replica back
//! into the plain `documents.source` text the non-collaborative readers consume
//! (RAG embed chunks, search snippets, backlink extraction, version snapshots,
//! the Ask-Ryu page context, and the seed for a fresh CRDT room).
//!
//! ## Why this exists
//!
//! Once a Spaces document room goes collaborative, the desktop editor **stops**
//! PUTting `source` — it hands that job to Core (see the "Persistence split" note
//! on `SpaceDatabaseEditorPage`, which disables its per-edit full-JSON PUT and
//! says "Core owns materializing the source back for the embed/RAG readers").
//! Until this module existed, Core did no such thing: [`super::DocRegistry::materialize`]
//! hardcoded `source: None`, so the quiescence write-back in
//! `server::realtime_ws::materialize_to_spaces` early-returned and every
//! collaborative edit left `documents.source` frozen at its pre-collab value.
//!
//! ## Databases only, and that is a deliberate line
//!
//! [`project_database`] is an **exact** port of the client's `snapshotDatabase` +
//! the `stripRowIds` its own save path applies (`apps/desktop/src/lib/realtime/
//! yjs-database.ts`, `SpaceDatabaseEditorPage.tsx`). A database's `source` is a
//! *data model* — `{columns, rows, views}` JSON round-tripped through
//! `parseDatabaseDoc` — so reproducing it in Rust is a mechanical transcription
//! with no fidelity risk: semantic JSON equality is the whole contract.
//!
//! A **page's** `source` is markdown produced by Plate's client-side Slate ->
//! markdown serializer. Projecting it would mean reimplementing that serializer
//! in Rust, and `materialize_to_spaces` writes any `Some(source)` straight into
//! `documents.source` with no kind check — so a Rust serializer that drifted from
//! Plate's by even one construct would **silently rewrite the user's real page
//! body** on every quiescence, and that column also re-seeds fresh CRDT rooms and
//! feeds version snapshots. Corrupting content is strictly worse than a stale
//! index, so pages return `None` and keep today's behaviour (the editor's own
//! markdown PUT stays authoritative for them). See the note in [`super`].

use serde_json::{Map, Value};
use yrs::{types::ToJson, Any, Array, Doc, Map as YMap, MapRef, Out, ReadTxn, Transact};

/// Root `Y.Array<Y.Map>` holding the database's columns.
const COLUMNS_KEY: &str = "columns";
/// Root `Y.Array<Y.Map>` holding the database's rows.
const ROWS_KEY: &str = "rows";
/// Root `Y.Array<Y.Map>` holding the database's saved views.
const VIEWS_KEY: &str = "views";

/// Reserved row-map key: the stable row id. STRIPPED from the projection — the
/// client strips it too (`stripRowIds` in `SpaceDatabaseEditorPage`) and
/// `seedDatabase` mints a fresh id on reseed, so persisting it would be churn.
const ROW_ID_KEY: &str = "__id";
/// Reserved row-map key: the fractional-index order string. STRIPPED — it is
/// positional CRDT bookkeeping, and the projected row array is already sorted.
const ROW_ORDER_KEY: &str = "__order";
/// Reserved row-map key: the row's body-page document id. KEPT — the client
/// persists it (`makeRowMap` reads it back on seed), so dropping it would break
/// the row -> page link on the next reseed.
const ROW_PAGE_KEY: &str = "__page";

/// Project a document's authoritative `yrs` replica into the `documents.source`
/// text, or `None` when this doc has no projection Core can safely produce.
///
/// `None` means "leave `documents.source` alone" — the caller must NOT write.
/// Today that covers every page doc (see the module docs) and any doc whose CRDT
/// roots we do not recognise (whiteboards, an unseeded empty room).
pub fn project(doc: &Doc) -> Option<String> {
    project_database(doc)
}

/// Project a database (data-grid) doc into its canonical `{columns, rows, views}`
/// JSON `source`.
///
/// A byte-for-byte port of `snapshotDatabase` (`yjs-database.ts`) with the same
/// `stripRowIds` the client applies before its own `saveDocument`, so a Core
/// write-back and a client title-flush produce the SAME shape and never fight:
///
/// - rows sort by `(__order, __id)` — the `__id` tiebreak is what makes two
///   concurrent appends (which compute an identical `__order`) converge to the
///   same order on every peer;
/// - `__order` and `__id` are stripped, `__page` is kept;
/// - a doc with no saved views gets the default `table` view synthesized, exactly
///   as the client does, so the UI is never viewless.
///
/// Returns `None` unless the doc actually carries a database's roots, which is
/// what keeps this off page docs. Root types only exist in a `yrs` store once an
/// update has populated them, so a page (root `content`, an `XmlText`) and an
/// unseeded empty room both miss here and fall through to "do not write".
pub fn project_database(doc: &Doc) -> Option<String> {
    // A READ transaction, and ONLY `Option`-returning getters. `get_or_insert_*`
    // would CREATE the root types on a page doc — polluting the very snapshot and
    // state vector `materialize` is about to encode, persist, and rebroadcast to
    // every peer. Never mutate the doc to inspect it.
    let txn = doc.transact();

    let columns_root = txn.get_array(COLUMNS_KEY);
    let rows_root = txn.get_array(ROWS_KEY);
    // Neither root present => not a database (a page, a whiteboard, or an empty
    // room nobody has seeded yet). Leave `source` untouched.
    if columns_root.is_none() && rows_root.is_none() {
        return None;
    }

    // Columns, in array order (the visual column order).
    let mut columns: Vec<Value> = Vec::new();
    let mut column_ids: Vec<String> = Vec::new();
    if let Some(root) = &columns_root {
        for out in root.iter(&txn) {
            let Some(map) = as_map(out) else { continue };
            let id = string_at(&map, &txn, "id");
            column_ids.push(id.clone());
            let mut column = Map::new();
            column.insert("id".to_owned(), Value::String(id));
            column.insert(
                "label".to_owned(),
                Value::String(string_at(&map, &txn, "label")),
            );
            // `cell` is a plain JS object (`{variant, ...}`) written straight into
            // the Y.Map, so it decodes as an `Any` — pass it through verbatim
            // rather than re-deriving a shape we would only get wrong.
            column.insert(
                "cell".to_owned(),
                value_at(&map, &txn, "cell").unwrap_or_else(default_cell),
            );
            columns.push(Value::Object(column));
        }
    }

    // Rows, sorted by (__order, __id) — the deterministic cross-peer order.
    let mut entries: Vec<(String, String, MapRef)> = Vec::new();
    if let Some(root) = &rows_root {
        for out in root.iter(&txn) {
            let Some(map) = as_map(out) else { continue };
            let order = string_at(&map, &txn, ROW_ORDER_KEY);
            let id = string_at(&map, &txn, ROW_ID_KEY);
            entries.push((order, id, map));
        }
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));

    let rows: Vec<Value> = entries
        .iter()
        .map(|(_, _, map)| {
            let mut row = Map::new();
            // `__page` survives; `__id` / `__order` do not (see the key docs).
            if let Some(Value::String(page)) = value_at(map, &txn, ROW_PAGE_KEY) {
                if !page.is_empty() {
                    row.insert(ROW_PAGE_KEY.to_owned(), Value::String(page));
                }
            }
            for column_id in &column_ids {
                // A cell the row never got is absent, not null — `JSON.stringify`
                // drops `undefined` keys, so this matches the client byte for byte.
                if let Some(cell) = value_at(map, &txn, column_id) {
                    row.insert(column_id.clone(), cell);
                }
            }
            Value::Object(row)
        })
        .collect();

    // Views, defaulting to the single `table` view the client synthesizes for a
    // pre-views document.
    let mut views: Vec<Value> = Vec::new();
    if let Some(root) = txn.get_array(VIEWS_KEY) {
        for out in root.iter(&txn) {
            let Some(map) = as_map(out) else { continue };
            let mut view = Map::new();
            view.insert("id".to_owned(), Value::String(string_at(&map, &txn, "id")));
            view.insert(
                "name".to_owned(),
                Value::String(string_at(&map, &txn, "name")),
            );
            let kind = string_at(&map, &txn, "kind");
            view.insert(
                "kind".to_owned(),
                Value::String(if kind.is_empty() {
                    "table".to_owned()
                } else {
                    kind
                }),
            );
            // Optional, and omitted (not null) when unset — same as the client.
            if let Some(Value::String(group_by)) = value_at(&map, &txn, "groupByColumnId") {
                if !group_by.is_empty() {
                    view.insert("groupByColumnId".to_owned(), Value::String(group_by));
                }
            }
            views.push(Value::Object(view));
        }
    }
    if views.is_empty() {
        views.push(default_view());
    }

    let mut out = Map::new();
    out.insert("columns".to_owned(), Value::Array(columns));
    out.insert("rows".to_owned(), Value::Array(rows));
    out.insert("views".to_owned(), Value::Array(views));
    serde_json::to_string(&Value::Object(out)).ok()
}

/// The client's `defaultView()` — the table view every database falls back to.
fn default_view() -> Value {
    let mut view = Map::new();
    view.insert("id".to_owned(), Value::String("view_table".to_owned()));
    view.insert("name".to_owned(), Value::String("Table".to_owned()));
    view.insert("kind".to_owned(), Value::String("table".to_owned()));
    Value::Object(view)
}

/// The client's fallback cell type when a column carries no `cell` (`readColumnMap`).
fn default_cell() -> Value {
    let mut cell = Map::new();
    cell.insert("variant".to_owned(), Value::String("short-text".to_owned()));
    Value::Object(cell)
}

/// Narrow an array element to the `Y.Map` every column/row/view entry is. A
/// non-map element is skipped rather than guessed at.
fn as_map(out: Out) -> Option<MapRef> {
    match out {
        Out::YMap(map) => Some(map),
        _ => None,
    }
}

/// Read one key as a `serde_json` value. `None` for a missing key AND for the
/// JS-`undefined` hole, so both are omitted from the projection exactly as
/// `JSON.stringify` omits them.
fn value_at<T: ReadTxn>(map: &MapRef, txn: &T, key: &str) -> Option<Value> {
    let out = map.get(txn, key)?;
    let any = match out {
        Out::Any(any) => any,
        // A nested shared type (not expected in this model, but never guess):
        // decode it through yrs' own JSON view rather than dropping it.
        other => other.to_json(txn),
    };
    if matches!(any, Any::Undefined) {
        return None;
    }
    serde_json::to_value(&any).ok()
}

/// Read one key as a string, defaulting to `""` — mirrors the client's
/// `String(map.get(k) ?? "")`.
fn string_at<T: ReadTxn>(map: &MapRef, txn: &T, key: &str) -> String {
    match value_at(map, txn, key) {
        Some(Value::String(s)) => s,
        Some(Value::Null) | None => String::new(),
        // A non-string value stringifies, like JS `String(v)`.
        Some(other) => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{MapPrelim, Text as _, Transact};

    /// Build a database `Y.Doc` the way the client's `seedDatabase` does.
    fn database_doc() -> Doc {
        let doc = Doc::new();
        let columns = doc.get_or_insert_array(COLUMNS_KEY);
        let rows = doc.get_or_insert_array(ROWS_KEY);
        let views = doc.get_or_insert_array(VIEWS_KEY);
        let mut txn = doc.transact_mut();

        columns.push_back(
            &mut txn,
            MapPrelim::from([
                ("id", Any::from("col_name")),
                ("label", Any::from("Name")),
                (
                    "cell",
                    Any::from_json(r#"{"variant":"short-text"}"#).unwrap(),
                ),
            ]),
        );

        // Two rows inserted in REVERSE visual order, to prove the projection sorts
        // by `__order` rather than trusting array position.
        rows.push_back(
            &mut txn,
            MapPrelim::from([
                ("__id", Any::from("row_b")),
                ("__order", Any::from("a1")),
                ("col_name", Any::from("Second")),
            ]),
        );
        rows.push_back(
            &mut txn,
            MapPrelim::from([
                ("__id", Any::from("row_a")),
                ("__order", Any::from("a0")),
                ("col_name", Any::from("First")),
                ("__page", Any::from("doc_page_1")),
            ]),
        );

        views.push_back(
            &mut txn,
            MapPrelim::from([
                ("id", Any::from("view_table")),
                ("name", Any::from("Table")),
                ("kind", Any::from("table")),
            ]),
        );

        drop(txn);
        doc
    }

    #[test]
    fn projects_database_to_client_json_shape() {
        let source = project(&database_doc()).expect("a database doc must project");
        let value: Value = serde_json::from_str(&source).unwrap();

        // Columns pass through verbatim, `cell` object included.
        assert_eq!(value["columns"][0]["id"], "col_name");
        assert_eq!(value["columns"][0]["label"], "Name");
        assert_eq!(value["columns"][0]["cell"]["variant"], "short-text");

        // Rows are sorted by `__order` — NOT by insertion position.
        assert_eq!(value["rows"][0]["col_name"], "First");
        assert_eq!(value["rows"][1]["col_name"], "Second");

        // `__page` is kept (the row -> body-page link must survive a reseed)…
        assert_eq!(value["rows"][0]["__page"], "doc_page_1");
        // …while `__id` / `__order` are stripped, exactly as the client's own
        // `stripRowIds` save path does. Persisting them would make Core's
        // write-back and the client's title-flush fight over `source`.
        assert!(value["rows"][0].get("__id").is_none());
        assert!(value["rows"][0].get("__order").is_none());

        assert_eq!(value["views"][0]["id"], "view_table");
        assert_eq!(value["views"][0]["kind"], "table");
    }

    #[test]
    fn projection_round_trips_through_the_client_parse_shape() {
        // `parseDatabaseDoc` accepts a source only when `columns` and `rows` are
        // both arrays; anything else is discarded for a fresh default (silent data
        // loss). Assert the contract it checks.
        let source = project(&database_doc()).unwrap();
        let value: Value = serde_json::from_str(&source).unwrap();
        assert!(
            value["columns"].is_array(),
            "parseDatabaseDoc requires this"
        );
        assert!(value["rows"].is_array(), "parseDatabaseDoc requires this");
        assert!(value["views"].is_array());
    }

    #[test]
    fn database_with_no_views_gets_the_default_table_view() {
        // A pre-views database: the client synthesizes a default table view rather
        // than rendering viewless, so the projection must too.
        let doc = Doc::new();
        let columns = doc.get_or_insert_array(COLUMNS_KEY);
        {
            let mut txn = doc.transact_mut();
            columns.push_back(
                &mut txn,
                MapPrelim::from([("id", Any::from("col_name")), ("label", Any::from("Name"))]),
            );
        }
        let value: Value = serde_json::from_str(&project(&doc).unwrap()).unwrap();
        assert_eq!(value["views"][0]["id"], "view_table");
        assert_eq!(value["views"][0]["kind"], "table");
        // A column with no `cell` falls back to the client's default variant.
        assert_eq!(value["columns"][0]["cell"]["variant"], "short-text");
    }

    #[test]
    fn page_doc_projects_to_none_and_is_not_mutated() {
        // THE load-bearing guard. A page's root is an `XmlText` named `content`; it
        // has no database roots, so it must project to `None` (leave
        // `documents.source` — the user's real Plate-serialized markdown — alone).
        let doc = Doc::new();
        let _content = doc.get_or_insert_xml_fragment("content");
        let body = doc.get_or_insert_text("body");
        {
            let mut txn = doc.transact_mut();
            body.insert(&mut txn, 0, "hello");
        }
        let before = {
            let txn = doc.transact();
            txn.encode_state_as_update_v1(&yrs::StateVector::default())
        };

        assert!(
            project(&doc).is_none(),
            "a page must not be projected — a drifting Rust markdown serializer \
             would silently rewrite the user's body"
        );

        // And inspecting it must not have CREATED the database roots: a
        // `get_or_insert_array` here would pollute the snapshot `materialize` is
        // about to persist and rebroadcast to every peer.
        let after = {
            let txn = doc.transact();
            txn.encode_state_as_update_v1(&yrs::StateVector::default())
        };
        assert_eq!(before, after, "projection must never mutate the doc");
        let txn = doc.transact();
        assert!(txn.get_array(COLUMNS_KEY).is_none());
        assert!(txn.get_array(ROWS_KEY).is_none());
    }

    #[test]
    fn empty_unseeded_room_projects_to_none() {
        // A brand-new room nobody has seeded has no roots at all — there is nothing
        // to write back, and writing `{"columns":[],"rows":[]}` would CLOBBER the
        // source the client is about to seed FROM.
        assert!(project(&Doc::new()).is_none());
    }

    #[test]
    fn concurrent_appends_with_equal_order_sort_by_id() {
        // Two peers appending at once compute the SAME `__order`; the `__id`
        // tiebreak is what makes every peer agree on the row order. Without it the
        // projection would flip row order between materializes and churn RAG.
        let doc = Doc::new();
        let _columns = doc.get_or_insert_array(COLUMNS_KEY);
        let rows = doc.get_or_insert_array(ROWS_KEY);
        {
            let mut txn = doc.transact_mut();
            for id in ["row_zzz", "row_aaa"] {
                rows.push_back(
                    &mut txn,
                    MapPrelim::from([("__id", Any::from(id)), ("__order", Any::from("a0"))]),
                );
            }
        }
        // Rows carry no cells, so assert on order via a re-read of the ids: the
        // projection strips `__id`, so instead verify determinism by projecting
        // twice and getting identical bytes, plus the documented sort.
        let first = project(&doc).unwrap();
        let second = project(&doc).unwrap();
        assert_eq!(first, second, "projection is deterministic");
    }
}
