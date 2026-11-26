//! The `host.spaces_*` verbs - the app's own Space documents and databases.
// test-exempt: moved verbatim out of plugin_host/bridge.rs; tests in bridge/tests.rs and bridge/runtime_tests.rs.

use super::*;

impl PluginHookBridge {
    /// `host.spaces_*` — a full-page Companion app OWNS Space documents: created in
    /// the `documents` table, search-embedded, `[[backlinked]]`, versioned, and
    /// Space-routed, exactly like a built-in page/database/whiteboard. Every doc an
    /// app touches carries `kind = "app:<plugin_id>"`, and the store enforces that
    /// isolation on every read/update/delete, so one app can never reach another's
    /// docs or a built-in doc. `plugin_id` is the bridge's path-bound owner id, so
    /// it cannot be spoofed by the frame.
    pub(super) async fn spaces(&self, method: &str, args: Value) -> InvokeOutcome {
        let database_method = matches!(
            method,
            "spaces_create_database"
                | "spaces_list_databases"
                | "spaces_get_database"
                | "spaces_update_database"
                | "spaces_query_database"
                | "spaces_delete_database"
        );
        let required_grant = if database_method {
            GRANT_SPACES_DATABASE
        } else {
            GRANT_SPACES
        };
        if !self.grants.contains(required_grant) {
            return err(format!(
                "capability '{required_grant}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        if method == "spaces_search" {
            return self.spaces_search(args).await;
        }
        let store = &self.state.spaces;
        let owner = self.verified_caller.as_ref().map_or_else(
            crate::server::spaces::background_owner,
            |_| {
                crate::server::spaces::owner_of(&crate::server::caller_tenancy(
                    &self.verified_caller,
                ))
            },
        );
        let space_id = args
            .get("space_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        let doc_id = args
            .get("doc_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        let database_id = args
            .get("database_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();

        // App namespace ownership does not replace the request caller's Space ACL.
        // Apply the same coarse and resource gates used by the public document routes.
        use crate::identity_verify::permissions::{SPACE_READ, SPACE_WRITE};
        let caller = &self.verified_caller;
        if method == "spaces_ensure_space" {
            if crate::server::enforce_permission(&self.state, caller, SPACE_WRITE)
                .await
                .is_err()
            {
                return err("Space creation is not permitted for this caller".to_owned());
            }
        } else if matches!(
            method,
            "spaces_create_doc"
                | "spaces_list_docs"
                | "spaces_create_database"
                | "spaces_list_databases"
        ) && !space_id.is_empty()
        {
            let write = matches!(method, "spaces_create_doc" | "spaces_create_database");
            if crate::server::enforce_permission_on(
                &self.state,
                caller,
                if write { SPACE_WRITE } else { SPACE_READ },
                crate::acl::KIND_SPACE,
                space_id,
            )
            .await
            .is_err()
            {
                return err("Space access is not permitted for this caller".to_owned());
            }
            if write
                && crate::server::require_space_content_write(
                    &self.state,
                    caller,
                    space_id,
                    "space not found",
                )
                .await
                .is_err()
            {
                return err("Space is unavailable or not writable".to_owned());
            }
        } else if matches!(
            method,
            "spaces_get_doc" | "spaces_update_doc" | "spaces_delete_doc"
        ) && !doc_id.is_empty()
        {
            let write = method != "spaces_get_doc";
            let Some(parent) = crate::server::document_parent_space(&self.state, doc_id).await
            else {
                if !write {
                    return ok(Value::Null);
                }
                return err("Document is unavailable".to_owned());
            };
            if crate::server::enforce_permission_on(
                &self.state,
                caller,
                if write { SPACE_WRITE } else { SPACE_READ },
                crate::acl::KIND_SPACE,
                &parent,
            )
            .await
            .is_err()
            {
                return err("Document access is not permitted for this caller".to_owned());
            }
            let meta = crate::server::spaces::doc_access_meta(store, doc_id).await;
            let allowed = if write {
                crate::server::require_resource_write(meta, caller.as_ref(), "document not found")
            } else {
                crate::server::require_resource_read(meta, caller.as_ref(), "document not found")
            };
            if allowed.is_err() {
                return err("Document is unavailable or access was denied".to_owned());
            }
        } else if matches!(
            method,
            "spaces_get_database"
                | "spaces_update_database"
                | "spaces_query_database"
                | "spaces_delete_database"
        ) && !database_id.is_empty()
        {
            let write = matches!(method, "spaces_update_database" | "spaces_delete_database");
            let Some(parent) = crate::server::document_parent_space(&self.state, database_id).await
            else {
                return err("Database is unavailable".to_owned());
            };
            if parent != space_id {
                return err("Database is unavailable".to_owned());
            }
            if crate::server::enforce_permission_on(
                &self.state,
                caller,
                if write { SPACE_WRITE } else { SPACE_READ },
                crate::acl::KIND_SPACE,
                &parent,
            )
            .await
            .is_err()
            {
                return err("Database access is not permitted for this caller".to_owned());
            }
            let meta = crate::server::spaces::doc_access_meta(store, database_id).await;
            let allowed = if write {
                crate::server::require_resource_write(meta, caller.as_ref(), "database not found")
            } else {
                crate::server::require_resource_read(meta, caller.as_ref(), "database not found")
            };
            if allowed.is_err() {
                return err("Database is unavailable or access was denied".to_owned());
            }
        }

        match method {
            // `host.spaces.ensureSpace({ name, description? })` — resolve a Space by
            // NAME, creating it if absent, and return its id.
            //
            // Without this the rest of this facade is unreachable from a turn hook:
            // every other method needs a `space_id`, ids are uuids, and a sandboxed
            // hook has no route parameter to read one from. The name is the caller's
            // argument (never a constant in Core) so this stays a generic seam rather
            // than one plugin's Space wired into the kernel.
            "spaces_ensure_space" => {
                let name = args
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim();
                if name.is_empty() {
                    return err("host.spaces.ensureSpace requires a non-empty 'name'".to_string());
                }
                let description = args
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                match store.ensure_named_space(name, description, &owner).await {
                    Ok(id) => ok(json!(id)),
                    Err(e) => err(e.to_string()),
                }
            }
            "spaces_create_doc" => {
                if space_id.is_empty() {
                    return err("host.spaces.createDoc requires a non-empty 'space_id'".to_string());
                }
                let title = args
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Untitled");
                match store
                    .app_create_doc(&self.plugin_id, space_id, title, &owner)
                    .await
                {
                    Ok(id) => ok(json!(id)),
                    Err(e) => err(e.to_string()),
                }
            }
            "spaces_get_doc" => {
                if doc_id.is_empty() {
                    return err("host.spaces.getDoc requires a non-empty 'doc_id'".to_string());
                }
                match store.app_get_doc(&self.plugin_id, doc_id).await {
                    Ok(Some(doc)) => match serde_json::to_value(doc) {
                        Ok(v) => ok(v),
                        Err(e) => err(e.to_string()),
                    },
                    Ok(None) => ok(Value::Null),
                    Err(e) => err(e.to_string()),
                }
            }
            "spaces_update_doc" => {
                if doc_id.is_empty() {
                    return err("host.spaces.updateDoc requires a non-empty 'doc_id'".to_string());
                }
                let title = args
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
                let source = args
                    .get("source")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                match store
                    .app_update_doc(&self.plugin_id, doc_id, title.as_deref(), source)
                    .await
                {
                    Ok(()) => ok(json!(true)),
                    Err(e) => err(e.to_string()),
                }
            }
            "spaces_list_docs" => {
                if space_id.is_empty() {
                    return err("host.spaces.listDocs requires a non-empty 'space_id'".to_string());
                }
                match store
                    .list_documents(space_id, crate::server::caller_doc_filter(caller))
                    .await
                {
                    Ok(docs) => {
                        let kind = format!("app:{}", self.plugin_id);
                        let visible: Vec<Value> = docs.into_iter().filter(|doc| doc.kind == kind).map(|doc| json!({"id":doc.id,"title":doc.title,"updated_at":doc.updated_at})).collect();
                        ok(json!(visible))
                    }
                    Err(e) => err(e.to_string()),
                }
            }

            "spaces_delete_doc" => {
                if doc_id.is_empty() {
                    return err("host.spaces.deleteDoc requires a non-empty 'doc_id'".to_string());
                }
                match store.app_delete_doc(&self.plugin_id, doc_id).await {
                    Ok(()) => ok(json!(true)),
                    Err(e) => err(e.to_string()),
                }
            }
            "spaces_create_database" => {
                if space_id.is_empty() {
                    return err(
                        "host.spaces.createDatabase requires a non-empty 'space_id'".to_owned()
                    );
                }
                let title = args
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|title| !title.is_empty() && title.len() <= 100)
                    .unwrap_or("Untitled");
                match store.create_database(space_id, title, &owner).await {
                    Ok(id) => ok(json!(id)),
                    Err(error) => err(error.to_string()),
                }
            }
            "spaces_list_databases" => {
                if space_id.is_empty() {
                    return err(
                        "host.spaces.listDatabases requires a non-empty 'space_id'".to_owned()
                    );
                }
                match store
                    .list_documents(space_id, crate::server::caller_doc_filter(caller))
                    .await
                {
                    Ok(documents) => {
                        let databases: Vec<Value> = documents
                            .into_iter()
                            .filter(|document| document.kind == "database")
                            .map(|document| {
                                json!({
                                    "id": document.id,
                                    "title": document.title,
                                    "updated_at": document.updated_at,
                                })
                            })
                            .collect();
                        ok(json!(databases))
                    }
                    Err(error) => err(error.to_string()),
                }
            }
            "spaces_get_database" => {
                if database_id.is_empty() {
                    return err(
                        "host.spaces.getDatabase requires a non-empty 'database_id'".to_owned()
                    );
                }
                match store.get_document(database_id).await {
                    Ok(Some(document))
                        if document.space_id == space_id && document.kind == "database" =>
                    {
                        match serde_json::to_value(document) {
                            Ok(value) => ok(value),
                            Err(error) => err(error.to_string()),
                        }
                    }
                    Ok(_) => ok(Value::Null),
                    Err(error) => err(error.to_string()),
                }
            }
            "spaces_update_database" => {
                if database_id.is_empty() {
                    return err(
                        "host.spaces.updateDatabase requires a non-empty 'database_id'".to_owned(),
                    );
                }
                let Some(expected_revision) = args
                    .get("expected_revision")
                    .and_then(Value::as_i64)
                    .filter(|revision| *revision >= 0)
                else {
                    return err(
                        "host.spaces.updateDatabase requires a non-negative 'expected_revision'"
                            .to_owned(),
                    );
                };
                let source = args
                    .get("source")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if source.len() > 1_500_000 {
                    return err("database source exceeds the 1500000 byte limit".to_owned());
                }
                let title = match args.get("title").and_then(Value::as_str) {
                    Some(title) if !title.trim().is_empty() && title.len() <= 100 => {
                        title.trim().to_owned()
                    }
                    Some(_) => return err("database title must contain 1 to 100 bytes".to_owned()),
                    None => match store.get_document(database_id).await {
                        Ok(Some(document))
                            if document.space_id == space_id && document.kind == "database" =>
                        {
                            document.title
                        }
                        _ => return err("Database is unavailable".to_owned()),
                    },
                };
                match store
                    .update_database_document(
                        space_id,
                        database_id,
                        &title,
                        source,
                        expected_revision,
                    )
                    .await
                {
                    Ok(crate::server::spaces::DocumentUpdateOutcome::Applied(result)) => {
                        ok(json!(result))
                    }
                    Ok(crate::server::spaces::DocumentUpdateOutcome::Conflict {
                        current_revision,
                    }) => err(format!("database revision conflict at {current_revision}")),
                    Err(error) => err(error.to_string()),
                }
            }
            "spaces_query_database" => {
                if database_id.is_empty() {
                    return err(
                        "host.spaces.queryDatabase requires a non-empty 'database_id'".to_owned(),
                    );
                }
                let query = args
                    .get("query")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let parameters = match args.get("parameters") {
                    Some(Value::Array(parameters)) => parameters.as_slice(),
                    Some(_) => return err("query 'parameters' must be an array".to_owned()),
                    None => &[],
                };
                match store
                    .query_database(space_id, database_id, query, parameters)
                    .await
                {
                    Ok(result) => match serde_json::to_value(result) {
                        Ok(value) => ok(value),
                        Err(error) => err(error.to_string()),
                    },
                    Err(error) => err(error.to_string()),
                }
            }
            "spaces_delete_database" => {
                if database_id.is_empty() {
                    return err(
                        "host.spaces.deleteDatabase requires a non-empty 'database_id'".to_owned(),
                    );
                }
                match store.delete_database_document(space_id, database_id).await {
                    Ok(()) => ok(json!(true)),
                    Err(error) => err(error.to_string()),
                }
            }
            _ => err(format!("unknown spaces method '{method}'")),
        }
    }
}
