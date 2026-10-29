//! Portable Space packages: OKF-compatible Markdown in, local RAG out.
//!
//! A Space package deliberately carries source content only. Pages are Markdown
//! concepts with YAML frontmatter, and databases are folders containing an
//! index.md schema plus one Markdown file per row. Embeddings, vector tables,
//! provider ids, binary files, and node ACLs never enter the package.

use std::collections::{BTreeMap, HashMap};
use std::io::{Cursor, Write};

use anyhow::{bail, Context, Result};
use noyalib::compat::serde_yaml::Value as YamlValue;
use ryu_knowledge::{Concept, IndexDoc, LogDoc, LogEntry, OKF_VERSION};
use serde_json::{json, Map, Value};

use super::spaces::{DocOwner, DocumentContent, RetrievalMode, Space, SpaceStore};
use crate::portable_packages::{PortablePackageManifest, PACKAGE_MANIFEST_FILE};

pub(crate) const MAX_SPACE_PACKAGE_ARCHIVE_BYTES: usize = 64 * 1024 * 1024;
pub(crate) const MAX_SPACE_PACKAGE_BODY_BYTES: usize = 90 * 1024 * 1024;
pub(crate) const SPACE_PACKAGE_VERSION: &str = "1.0.0";

#[derive(Debug, Clone)]
pub(crate) struct SpacePackageExport {
    pub archive: Vec<u8>,
    pub database_count: usize,
    pub excluded_count: usize,
    pub file_paths: Vec<String>,
    pub page_count: usize,
    pub row_count: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct SpacePackageImportSummary {
    pub database_count: usize,
    pub needs_reindex: bool,
    pub page_count: usize,
    pub row_count: usize,
    pub space_id: String,
    pub space_name: String,
}

#[derive(Debug, Clone)]
struct ParsedPage {
    database_path: Option<String>,
    icon: Option<Value>,
    path: String,
    source: String,
    title: String,
}

#[derive(Debug, Clone)]
struct ParsedRow {
    page_path: Option<String>,
    title: String,
    values: Map<String, Value>,
}

#[derive(Debug, Clone)]
struct ParsedDatabase {
    columns: Value,
    icon: Option<Value>,
    path: String,
    rows: Vec<ParsedRow>,
    title: String,
    views: Value,
}

#[derive(Debug, Clone)]
pub(crate) struct ParsedSpacePackage {
    databases: Vec<ParsedDatabase>,
    description: Option<String>,
    mode: RetrievalMode,
    name: String,
    pages: Vec<ParsedPage>,
}

fn slug(value: &str, fallback: &str) -> String {
    let mut output = String::new();
    for character in value.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
            output.push(character.to_ascii_lowercase());
        } else if !output.ends_with('-') {
            output.push('-');
        }
    }
    let output = output.trim_matches('-');
    if output.is_empty() {
        fallback.to_owned()
    } else {
        output.to_owned()
    }
}

fn indexed_path(prefix: &str, index: usize, title: &str) -> String {
    format!("{prefix}{index:04}-{}.md", slug(title, "untitled"))
}

fn database_index_path(index: usize, title: &str) -> String {
    format!("databases/{index:04}-{}/index.md", slug(title, "database"))
}

fn yaml_value(value: &Value) -> Result<YamlValue> {
    noyalib::compat::serde_yaml::to_value(value).context("serializing Space frontmatter")
}

fn yaml_to_json(value: &YamlValue) -> Result<Value> {
    let yaml =
        noyalib::compat::serde_yaml::to_string(value).context("encoding Space frontmatter")?;
    noyalib::compat::serde_yaml::from_str(&yaml).context("decoding Space frontmatter")
}

fn extra_json(concept: &Concept, key: &str) -> Option<Value> {
    concept
        .extra
        .get(key)
        .and_then(|value| yaml_to_json(value).ok())
}

fn extra_string(concept: &Concept, key: &str) -> Option<String> {
    extra_json(concept, key).and_then(|value| value.as_str().map(str::to_owned))
}

fn concept_markdown(
    path: String,
    type_: &str,
    title: &str,
    body: String,
    extra: BTreeMap<String, YamlValue>,
) -> Result<Vec<u8>> {
    let concept = Concept {
        file_path: path,
        type_: type_.to_owned(),
        title: Some(title.to_owned()),
        description: None,
        resource: None,
        timestamp: None,
        tags: Vec::new(),
        extra,
        body,
        links: Vec::new(),
    };
    Ok(concept.to_markdown().into_bytes())
}

fn row_database_path(path: &str) -> Option<String> {
    path.split_once("/rows/")
        .map(|(prefix, _)| format!("{prefix}/index.md"))
}

fn database_source(source: &str) -> (Value, Value, Vec<Value>) {
    let parsed = serde_json::from_str::<Value>(source).unwrap_or_else(|_| json!({}));
    let object = parsed.as_object();
    let columns = object
        .and_then(|value| value.get("columns"))
        .filter(|value| value.is_array())
        .cloned()
        .unwrap_or_else(|| {
            json!([{
                "id": "col_name",
                "label": "Name",
                "cell": { "variant": "short-text" }
            }])
        });
    let views = object
        .and_then(|value| value.get("views"))
        .filter(|value| value.is_array())
        .cloned()
        .unwrap_or_else(|| json!([{"id": "view_table", "name": "Table", "kind": "table"}]));
    let rows = object
        .and_then(|value| value.get("rows"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    (columns, views, rows)
}

fn row_title(row: &Map<String, Value>, columns: &Value, index: usize) -> String {
    let Some(columns) = columns.as_array() else {
        return format!("Row {}", index + 1);
    };
    for column in columns {
        let Some(column) = column.as_object() else {
            continue;
        };
        let Some(id) = column.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(value) = row.get(id) else {
            continue;
        };
        let title = match value {
            Value::String(value) => value.trim().to_owned(),
            Value::Number(value) => value.to_string(),
            Value::Bool(value) => value.to_string(),
            _ => String::new(),
        };
        if !title.is_empty() {
            return title;
        }
    }
    format!("Row {}", index + 1)
}

fn build_manifest(space: &Space, artifacts: &[String], excluded_count: usize) -> Value {
    json!({
        "schemaVersion": 1,
        "id": format!("space/{}", space.id),
        "name": space.name,
        "version": SPACE_PACKAGE_VERSION,
        "kind": "space",
        "artifacts": artifacts,
        "targets": ["desktop", "node"],
        "scopes": ["space"],
        "requires": {},
        "capabilities": ["space.import"],
        "security": {
            "containsSecrets": false,
            "permissions": [],
            "privateContent": false,
            "redacted": false
        },
        "metadata": {
            "format": "okf-space",
            "okfVersion": OKF_VERSION,
            "retrievalMode": space.retrieval_mode.as_str(),
            "excludedDocumentCount": excluded_count
        }
    })
}

fn package_archive(manifest: &Value, files: &BTreeMap<String, Vec<u8>>) -> Result<Vec<u8>> {
    let manifest_bytes =
        serde_json::to_vec_pretty(manifest).context("encoding Space package manifest")?;
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    writer.start_file(PACKAGE_MANIFEST_FILE, options)?;
    writer.write_all(&manifest_bytes)?;
    for (path, data) in files {
        writer.start_file(path, options)?;
        writer.write_all(data)?;
    }
    Ok(writer.finish()?.into_inner())
}

/// Build a deterministic Markdown package from the visible, non-binary Space
/// documents. The caller applies the Space ACL before passing documents here.
pub(crate) fn export_space(
    space: &Space,
    documents: &[DocumentContent],
) -> Result<SpacePackageExport> {
    let mut files = BTreeMap::new();
    let mut database_paths = HashMap::new();
    let mut document_paths = HashMap::new();
    let mut database_docs = Vec::new();
    let mut pages = Vec::new();
    let mut excluded_count = 0;

    for (index, document) in documents.iter().enumerate() {
        match document.kind.as_str() {
            "database" => {
                let path = database_index_path(index, &document.title);
                database_paths.insert(document.id.clone(), path.clone());
                document_paths.insert(document.id.clone(), path.clone());
                database_docs.push((document, path));
            }
            "page" => pages.push(document),
            _ => excluded_count += 1,
        }
    }

    let mut row_paths_by_page_id = HashMap::new();
    let mut row_count = 0;
    for (document, database_path) in &database_docs {
        let (columns, views, rows) = database_source(&document.source);
        let database_dir = database_path
            .strip_suffix("/index.md")
            .context("database package path has no index")?;
        let database_extra = BTreeMap::from([
            ("source_id".to_owned(), yaml_value(&json!(document.id))?),
            ("columns".to_owned(), yaml_value(&columns)?),
            ("views".to_owned(), yaml_value(&views)?),
        ]);
        let index_bytes = concept_markdown(
            database_path.clone(),
            "database",
            &document.title,
            format!(
                "# {}\n\nRows are stored as Markdown files in this folder.\n",
                document.title
            ),
            database_extra,
        )?;
        files.insert(database_path.clone(), index_bytes);

        for (row_index, row) in rows.iter().enumerate() {
            let Some(row) = row.as_object() else {
                continue;
            };
            let title = row_title(row, &columns, row_index);
            let row_path = indexed_path(&format!("{database_dir}/rows/"), row_index, &title);
            let mut values = Map::new();
            for (key, value) in row {
                if !key.starts_with("__") {
                    values.insert(key.clone(), value.clone());
                }
            }
            let mut row_extra = BTreeMap::new();
            row_extra.insert("database".to_owned(), yaml_value(&json!(database_path))?);
            row_extra.insert("source_row".to_owned(), yaml_value(&json!(row_index))?);
            row_extra.insert("values".to_owned(), yaml_value(&Value::Object(values))?);
            if let Some(page_id) = row.get("__page").and_then(Value::as_str) {
                // Keep the linked row-body page in its own directory. A row may
                // legitimately be titled "body", so `{index}-body.md` would
                // overwrite the row artifact in the archive.
                let page_path = format!("{database_dir}/rows/{row_index:04}/body.md");
                row_extra.insert("page".to_owned(), yaml_value(&json!(page_path))?);
                row_paths_by_page_id.insert(page_id.to_owned(), page_path);
            }
            files.insert(
                row_path.clone(),
                concept_markdown(row_path, "row", &title, String::new(), row_extra)?,
            );
            row_count += 1;
        }
    }

    let mut page_count = 0;
    for (index, document) in pages.iter().enumerate() {
        let database_path = document
            .parent_id
            .as_deref()
            .and_then(|parent| database_paths.get(parent))
            .cloned();
        let path = if let Some(database_path) = database_path.as_deref() {
            let directory = database_path
                .strip_suffix("/index.md")
                .context("database page parent has no index")?;
            row_paths_by_page_id
                .get(&document.id)
                .cloned()
                .unwrap_or_else(|| {
                    indexed_path(&format!("{directory}/rows/"), index, &document.title)
                })
        } else {
            indexed_path("pages/", index, &document.title)
        };
        document_paths.insert(document.id.clone(), path.clone());
        let mut extra = BTreeMap::new();
        extra.insert("source_id".to_owned(), yaml_value(&json!(document.id))?);
        if let Some(database_path) = database_path {
            extra.insert("database".to_owned(), yaml_value(&json!(database_path))?);
        }
        if let Some(icon) = &document.icon {
            extra.insert("icon".to_owned(), yaml_value(icon)?);
        }
        files.insert(
            path.clone(),
            concept_markdown(
                path,
                "page",
                &document.title,
                document.source.clone(),
                extra,
            )?,
        );
        page_count += 1;
    }

    let mut index_body = String::from("# Contents\n\n");
    let mut document_paths_sorted = document_paths.values().cloned().collect::<Vec<_>>();
    document_paths_sorted.sort();
    for path in document_paths_sorted {
        index_body.push_str(&format!("- [{path}]({path})\n"));
    }
    let index_extra = BTreeMap::from([
        ("space_id".to_owned(), yaml_value(&json!(space.id))?),
        (
            "retrieval_mode".to_owned(),
            yaml_value(&json!(space.retrieval_mode.as_str()))?,
        ),
        ("visibility".to_owned(), yaml_value(&json!("private"))?),
    ]);
    let index = IndexDoc {
        okf_version: Some(OKF_VERSION.to_owned()),
        title: Some(space.name.clone()),
        description: space.description.clone(),
        extra: index_extra,
        body: index_body,
    };
    files.insert("index.md".to_owned(), index.to_markdown().into_bytes());

    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let log = LogDoc {
        entries: vec![LogEntry {
            date: today.clone(),
            content: "Exported source Markdown from Ryu; embeddings are intentionally omitted."
                .to_owned(),
        }],
        body: format!(
            "# Changelog\n\n## {today}\n\nExported source Markdown from Ryu; embeddings are intentionally omitted.\n"
        ),
    };
    files.insert("log.md".to_owned(), log.to_markdown().into_bytes());

    let artifacts = files.keys().cloned().collect::<Vec<_>>();
    let manifest = build_manifest(space, &artifacts, excluded_count);
    let archive = package_archive(&manifest, &files)?;
    if archive.len() > MAX_SPACE_PACKAGE_ARCHIVE_BYTES {
        bail!(
            "Space package exceeds the {} MiB archive limit",
            MAX_SPACE_PACKAGE_ARCHIVE_BYTES / (1024 * 1024)
        );
    }
    Ok(SpacePackageExport {
        archive,
        database_count: database_docs.len(),
        excluded_count,
        file_paths: artifacts,
        page_count,
        row_count,
    })
}

fn package_metadata(manifest: &PortablePackageManifest) -> Option<&Map<String, Value>> {
    manifest.extra.get("metadata").and_then(Value::as_object)
}

fn package_mode(manifest: &PortablePackageManifest) -> RetrievalMode {
    package_metadata(manifest)
        .and_then(|metadata| metadata.get("retrievalMode"))
        .and_then(Value::as_str)
        .and_then(RetrievalMode::parse)
        .unwrap_or(RetrievalMode::Vector)
}

/// Parse a portable package's source tree. Ordinary OKF concept files become
/// pages, while Ryu's database and row frontmatter extensions are recognised.
pub(crate) fn parse_package(
    manifest: &PortablePackageManifest,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<ParsedSpacePackage> {
    if manifest.kind != "space" {
        bail!("portable package kind must be space");
    }
    let mut description = None;
    if let Some(index) = files.get("index.md") {
        let content = String::from_utf8(index.clone()).context("Space index.md is not UTF-8")?;
        let index = IndexDoc::parse(&content);
        description = index.description;
    }
    let mut pages = Vec::new();
    let mut databases = Vec::new();
    let mut rows_by_database: HashMap<String, Vec<ParsedRow>> = HashMap::new();
    for (path, bytes) in files {
        if path == "index.md" || path == "log.md" {
            continue;
        }
        if !path.ends_with(".md") {
            bail!("Space packages may contain Markdown files only; found path {path}");
        }
        let content = String::from_utf8(bytes.clone())
            .with_context(|| format!("Space package file {path} is not UTF-8"))?;
        let concept = Concept::parse(path.clone(), &content)
            .map_err(|error| anyhow::anyhow!("invalid Space concept {path}: {error}"))?;
        let normalized_type = concept.type_.trim().to_ascii_lowercase();
        if normalized_type == "database" {
            let path = path.clone();
            databases.push(ParsedDatabase {
                columns: extra_json(&concept, "columns").unwrap_or_else(|| json!([])),
                icon: extra_json(&concept, "icon"),
                path: path.clone(),
                rows: Vec::new(),
                title: concept
                    .title
                    .clone()
                    .unwrap_or_else(|| "Untitled database".to_owned()),
                views: extra_json(&concept, "views").unwrap_or_else(|| json!([])),
            });
            rows_by_database.entry(path).or_default();
            continue;
        }
        if normalized_type == "row" {
            let database_path = extra_string(&concept, "database")
                .or_else(|| row_database_path(path))
                .ok_or_else(|| anyhow::anyhow!("row {path} does not name its database"))?;
            let values = extra_json(&concept, "values")
                .and_then(|value| value.as_object().cloned())
                .unwrap_or_default();
            rows_by_database
                .entry(database_path)
                .or_default()
                .push(ParsedRow {
                    page_path: extra_string(&concept, "page"),
                    title: concept
                        .title
                        .clone()
                        .unwrap_or_else(|| "Untitled row".to_owned()),
                    values,
                });
            continue;
        }
        let database_path = extra_string(&concept, "database").or_else(|| {
            if path.starts_with("databases/") {
                row_database_path(path)
            } else {
                None
            }
        });
        pages.push(ParsedPage {
            database_path,
            icon: extra_json(&concept, "icon"),
            path: path.clone(),
            source: concept.body,
            title: concept.title.unwrap_or_else(|| slug(path, "Untitled page")),
        });
    }
    for database in &mut databases {
        database.rows = rows_by_database.remove(&database.path).unwrap_or_default();
    }
    if !rows_by_database.is_empty() {
        let unknown = rows_by_database.keys().next().cloned().unwrap_or_default();
        bail!("Space package row refers to missing database {unknown}");
    }
    pages.sort_by(|left, right| left.path.cmp(&right.path));
    databases.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(ParsedSpacePackage {
        databases,
        description,
        mode: package_mode(manifest),
        name: manifest.name.clone(),
        pages,
    })
}

fn valid_database_source(database: &ParsedDatabase, page_ids: &HashMap<String, String>) -> Value {
    let columns = if database.columns.is_array() {
        database.columns.clone()
    } else {
        json!([{
            "id": "col_name",
            "label": "Name",
            "cell": { "variant": "short-text" }
        }])
    };
    let rows = database
        .rows
        .iter()
        .map(|row| {
            let mut values = row.values.clone();
            if let Some(page_path) = row.page_path.as_deref() {
                if let Some(page_id) = page_ids.get(page_path) {
                    values.insert("__page".to_owned(), json!(page_id));
                }
            }
            Value::Object(values)
        })
        .collect::<Vec<_>>();
    json!({
        "columns": columns,
        "rows": rows,
        "views": if database.views.is_array() { database.views.clone() } else { json!([]) }
    })
}

/// Import source files into a new private Space without embedding them. The
/// target node can run the manual embedding re-index when the user wants RAG;
/// no source package embedding data is consumed or trusted.
pub(crate) async fn import_package(
    store: &SpaceStore,
    package: &ParsedSpacePackage,
    owner: &DocOwner,
    name_override: Option<&str>,
) -> Result<SpacePackageImportSummary> {
    let name = name_override
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(package.name.as_str());
    if name.is_empty() {
        bail!("Space package name is required");
    }
    let space_id = store
        .create_space_with_mode_and_visibility(
            name,
            package.description.as_deref(),
            package.mode,
            owner,
            "private",
            None,
        )
        .await?;
    let result = async {
        let mut database_ids = HashMap::new();
        for database in &package.databases {
            let source = serde_json::to_string(&valid_database_source(database, &HashMap::new()))?;
            let id = store
                .import_document(&space_id, &database.title, &source, "database", None, owner)
                .await?;
            if let Some(icon) = &database.icon {
                store.set_document_icon(&id, Some(icon)).await?;
            }
            database_ids.insert(database.path.clone(), id);
        }

        let mut page_ids = HashMap::new();
        for page in &package.pages {
            let parent_id = page
                .database_path
                .as_deref()
                .and_then(|path| database_ids.get(path).map(String::as_str));
            let id = store
                .import_document(
                    &space_id,
                    &page.title,
                    &page.source,
                    "page",
                    parent_id,
                    owner,
                )
                .await?;
            if let Some(icon) = &page.icon {
                store.set_document_icon(&id, Some(icon)).await?;
            }
            page_ids.insert(page.path.clone(), id);
        }

        for database in &package.databases {
            let id = database_ids
                .get(&database.path)
                .context("database import id was not created")?;
            let source = serde_json::to_string(&valid_database_source(database, &page_ids))?;
            store
                .replace_document_source_without_embedding(id, &database.title, &source)
                .await?;
        }

        Ok::<(), anyhow::Error>(())
    }
    .await;
    if let Err(error) = result {
        let _ = store.delete_space(&space_id).await;
        return Err(error);
    }
    Ok(SpacePackageImportSummary {
        database_count: package.databases.len(),
        needs_reindex: true,
        page_count: package.pages.len(),
        row_count: package.databases.iter().map(|db| db.rows.len()).sum(),
        space_id,
        space_name: name.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> PortablePackageManifest {
        PortablePackageManifest {
            schema_version: 1,
            id: "space/demo".to_owned(),
            name: "Demo Space".to_owned(),
            version: "1.0.0".to_owned(),
            kind: "space".to_owned(),
            artifacts: vec![
                "index.md".to_owned(),
                "pages/0000-note.md".to_owned(),
                "databases/0001-tasks/index.md".to_owned(),
                "databases/0001-tasks/rows/0000-task.md".to_owned(),
            ],
            targets: vec!["desktop".to_owned()],
            scopes: vec!["space".to_owned()],
            requires: BTreeMap::new(),
            capabilities: Vec::new(),
            security: Default::default(),
            extra: BTreeMap::from([(
                "metadata".to_owned(),
                json!({ "format": "okf-space", "retrievalMode": "vector" }),
            )]),
        }
    }

    #[test]
    fn parses_pages_and_database_rows_without_embeddings() {
        let files = BTreeMap::from([
            (
                "index.md".to_owned(),
                b"---\nokf: 0.1\ntitle: Demo Space\n---\n# Contents\n".to_vec(),
            ),
            (
                "pages/0000-note.md".to_owned(),
                b"---\ntype: page\ntitle: Note\n---\nhello\n".to_vec(),
            ),
            (
                "databases/0001-tasks/index.md".to_owned(),
                b"---\ntype: database\ntitle: Tasks\ncolumns:\n  - id: col_name\n    label: Name\n    cell:\n      variant: short-text\nviews: []\n---\n# Tasks\n".to_vec(),
            ),
            (
                "databases/0001-tasks/rows/0000-task.md".to_owned(),
                b"---\ntype: row\ntitle: Ship it\ndatabase: databases/0001-tasks/index.md\nvalues:\n  col_name: Ship it\n---\n".to_vec(),
            ),
        ]);
        let package = parse_package(&manifest(), &files).expect("package parses");
        assert_eq!(package.pages.len(), 1);
        assert_eq!(package.databases.len(), 1);
        assert_eq!(package.databases[0].rows.len(), 1);
        assert_eq!(package.databases[0].rows[0].values["col_name"], "Ship it");
    }

    #[test]
    fn exports_source_only_pages_and_database_folders() {
        let space = Space {
            id: "space-1".to_owned(),
            name: "Research".to_owned(),
            description: Some("Shared notes".to_owned()),
            created_at: 1,
            updated_at: 2,
            document_count: 2,
            retrieval_mode: RetrievalMode::Vector,
            system: false,
            visibility: "private".to_owned(),
            team_id: None,
            icon: None,
        };
        let documents = vec![
            DocumentContent {
                id: "page-1".to_owned(),
                space_id: space.id.clone(),
                title: "Note".to_owned(),
                source: "# Hello".to_owned(),
                created_at: 1,
                updated_at: 1,
                revision: 0,
                chunk_count: 1,
                kind: "page".to_owned(),
                parent_id: None,
                icon: None,
            },
            DocumentContent {
                id: "db-1".to_owned(),
                space_id: space.id.clone(),
                title: "Tasks".to_owned(),
                source: serde_json::json!({
                    "columns": [{
                        "id": "col_name",
                        "label": "Name",
                        "cell": { "variant": "short-text" }
                    }],
                    "rows": [{
                        "col_name": "body",
                        "__page": "row-page-1"
                    }],
                    "views": [{
                        "id": "view_table",
                        "name": "Table",
                        "kind": "table"
                    }]
                })
                .to_string(),
                created_at: 2,
                updated_at: 2,
                revision: 0,
                chunk_count: 1,
                kind: "database".to_owned(),
                parent_id: None,
                icon: None,
            },
            DocumentContent {
                id: "row-page-1".to_owned(),
                space_id: space.id.clone(),
                title: "Ship it".to_owned(),
                source: "Row notes".to_owned(),
                created_at: 3,
                updated_at: 3,
                revision: 0,
                chunk_count: 1,
                kind: "page".to_owned(),
                parent_id: Some("db-1".to_owned()),
                icon: None,
            },
        ];
        let exported = export_space(&space, &documents).expect("export package");
        let extracted =
            crate::portable_packages::extract_archive(&exported.archive).expect("valid package");
        assert_eq!(extracted.manifest.kind, "space");
        assert!(extracted.files.contains_key("index.md"));
        assert!(extracted
            .files
            .keys()
            .any(|path| path.starts_with("databases/") && path.ends_with("/index.md")));
        assert!(extracted
            .files
            .keys()
            .any(|path| path.contains("/rows/") && path.ends_with(".md")));
        let row = extracted
            .files
            .get("databases/0001-tasks/rows/0000-body.md")
            .expect("a row titled body keeps its own artifact");
        assert!(String::from_utf8_lossy(row).contains("type: row"));
        let body = extracted
            .files
            .get("databases/0001-tasks/rows/0000/body.md")
            .expect("the linked row body uses a separate artifact path");
        assert!(String::from_utf8_lossy(body).contains("type: page"));
        assert!(!extracted
            .files
            .values()
            .any(|bytes| String::from_utf8_lossy(bytes).contains("chunk_vectors")));
        assert!(!extracted.files.keys().any(|path| path.ends_with(".json")));
    }

    #[test]
    fn rejects_non_markdown_artifacts() {
        let files = BTreeMap::from([
            ("index.md".to_owned(), b"# Contents\n".to_vec()),
            ("secret.json".to_owned(), b"{}".to_vec()),
        ]);
        let error = parse_package(&manifest(), &files).expect_err("binary artifact rejected");
        assert!(error.to_string().contains("Markdown files only"));
    }
}
