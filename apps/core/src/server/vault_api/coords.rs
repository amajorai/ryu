//! Coordinates and secret records on the wire.
//!
//! test-exempt: the wire coordinate types moved unchanged out of the former single-file `vault_api`; every route test in `tests.rs` and `routes_tests.rs` parses them.

use super::*;

/// Scope used when a request names none: the caller's own values.
pub(super) fn default_scope() -> SecretScope {
    SecretScope::User
}

/// Coordinates of one value (body form). `environment` defaults to
/// `default`, `path` to `/`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordsBody {
    #[serde(default = "default_scope")]
    pub(crate) scope: SecretScope,
    #[serde(default)]
    pub(crate) scope_id: Option<String>,
    #[serde(default)]
    pub(crate) binding: Option<SecretBinding>,
    #[serde(default)]
    pub(crate) environment: Option<String>,
    #[serde(default)]
    pub(crate) path: Option<String>,
}

/// Coordinates of one value (query form; `mcpId` is the binding).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordsQuery {
    #[serde(default = "default_scope")]
    pub(crate) scope: SecretScope,
    #[serde(default)]
    pub(crate) scope_id: Option<String>,
    #[serde(default)]
    pub(crate) mcp_id: Option<String>,
    #[serde(default)]
    pub(crate) environment: Option<String>,
    #[serde(default)]
    pub(crate) path: Option<String>,
}

impl From<CoordsQuery> for CoordsBody {
    fn from(query: CoordsQuery) -> Self {
        Self {
            scope: query.scope,
            scope_id: query.scope_id,
            binding: query.mcp_id.map(|id| SecretBinding {
                kind: SecretBindingKind::Mcp,
                id,
            }),
            environment: query.environment,
            path: query.path,
        }
    }
}

impl CoordsBody {
    pub(super) fn query_pairs(&self, target_scope_id: &str) -> Vec<(String, String)> {
        let mut pairs = vec![
            ("scope".to_owned(), self.scope.as_str().to_owned()),
            ("scopeId".to_owned(), target_scope_id.to_owned()),
            (
                "environment".to_owned(),
                self.environment
                    .clone()
                    .unwrap_or_else(|| DEFAULT_ENVIRONMENT.to_owned()),
            ),
            (
                "path".to_owned(),
                self.path.clone().unwrap_or_else(|| ROOT_PATH.to_owned()),
            ),
        ];
        if let Some(binding) = &self.binding {
            pairs.push(("mcpId".to_owned(), binding.id.clone()));
        }
        pairs
    }
}

pub(crate) fn coords_for(
    ctx: &Ctx,
    name: &str,
    body: CoordsBody,
) -> Result<SecretCoords, Response> {
    if !is_valid_vault_secret_name(name) {
        return Err(invalid_request(
            "name must be an environment-compatible identifier",
        ));
    }
    let target = resolve_target(
        body.scope,
        body.scope_id,
        body.binding,
        ctx.node.as_ref(),
        ctx.caller.as_ref(),
    )
    .map_err(invalid_request)?;
    SecretCoords {
        scope: target.scope,
        scope_id: target.scope_id,
        environment: body
            .environment
            .unwrap_or_else(|| DEFAULT_ENVIRONMENT.to_owned()),
        path: body.path.unwrap_or_else(|| ROOT_PATH.to_owned()),
        binding: target.binding,
        name: name.to_owned(),
    }
    .normalize()
    .map_err(|error| invalid_request(&error.to_string()))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SecretWire {
    pub(crate) name: String,
    pub(crate) scope: SecretScope,
    pub(crate) scope_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) binding: Option<SecretBinding>,
    pub(crate) environment: String,
    pub(crate) path: String,
    pub(crate) version: i64,
    /// Metadata check-and-set counter (`expectedMetadataVersion`).
    pub(crate) metadata_version: i64,
    pub(crate) status: crate::plugin_secrets::SecretStatus,
    pub(crate) metadata: crate::plugin_secrets::SecretMetadata,
    pub(crate) capabilities: Vec<Capability>,
    pub(crate) created_at: i64,
    pub(crate) created_by: Option<String>,
    pub(crate) updated_at: i64,
    pub(crate) updated_by: Option<String>,
    pub(crate) rotated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) deleted_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) source: Option<&'static str>,
}

pub(crate) fn to_wire(ctx: &Ctx, info: VaultSecretInfo) -> SecretWire {
    let caps = ctx.caps(&info.coords());
    let status = info.status(crate::vault::now_millis());
    SecretWire {
        capabilities: caps.into_iter().collect(),
        status,
        name: info.name,
        scope: info.scope,
        scope_id: info.scope_id,
        binding: info.binding,
        environment: info.environment,
        path: info.path,
        version: info.version,
        metadata_version: info.metadata_version,
        metadata: info.metadata,
        created_at: info.created_at,
        created_by: info.created_by,
        updated_at: info.updated_at,
        updated_by: info.updated_by,
        rotated_at: info.rotated_at,
        deleted_at: info.deleted_at,
        source: None,
    }
}
