//! Tests for the self-API: catalog, denylist, restricted writes and the acting loopback.

use super::*;

mod acting;
mod catalog;
mod restricted;

fn sample_spec() -> Value {
    json!({
        "paths": {
            "/api/quests": {
                "get": { "summary": "List quests" },
                "post": {
                    "summary": "Create a quest",
                    "requestBody": { "required": true }
                }
            },
            "/api/quests/{id}": {
                "delete": {
                    "summary": "Delete a quest",
                    "parameters": [
                        { "name": "id", "in": "path", "required": true, "schema": { "type": "string" } }
                    ]
                }
            },
            "/api/memory": {
                "get": {
                    "summary": "List memory",
                    "parameters": [
                        { "name": "scope", "in": "query", "required": false, "schema": { "type": "string" } }
                    ]
                }
            }
        }
    })
}

fn route(method: &str, path: &str) -> CoreApiRoute {
    CoreApiRoute {
        id: format!("ryu_api.{}_x", method.to_lowercase()),
        method: method.to_owned(),
        path_template: path.to_owned(),
        summary: String::new(),
        path_params: vec![],
        query_params: vec![],
        has_body: false,
        input_schema: json!({ "type": "object" }),
    }
}
