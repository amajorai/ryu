//! Core OpenAPI paths for the HashiCorp Vault-compatible `/v1/*` surface
//! ([`crate::server::vault_compat_api`]).
//!
//! Merged into the Core spec by [`super::api_doc`]. Every operation id carries
//! a `vault_compat_` prefix so it never shadows the native `/api/vault/*`
//! handler of the same name. OpenAPI has no `LIST` method, so listings are
//! documented as `GET …/metadata/{path}?list=true`, which the router also
//! accepts.

use utoipa::OpenApi;

#[derive(OpenApi)]
#[openapi(paths(
    crate::server::vault_compat_api::sys_health,
    crate::server::vault_compat_api::seal_status,
    crate::server::vault_compat_api::leader,
    crate::server::vault_compat_api::ui_mount,
    crate::server::vault_compat_api::tools_random,
    crate::server::vault_compat_api::tools_random_params,
    crate::server::vault_compat_api::tools_hash,
    crate::server::vault_compat_api::tools_hash_algorithm,
    crate::server::vault_compat_api::approle_login,
    crate::server::vault_compat_api::jwt_login,
    crate::server::vault_compat_api::cert_login,
    crate::server::vault_compat_api::aws_login,
    crate::server::vault_compat_api::kubernetes_login,
    crate::server::vault_compat_api::lookup_self,
    crate::server::vault_compat_api::lookup_self_post,
    crate::server::vault_compat_api::revoke_self,
    crate::server::vault_compat_api::renew_self,
    crate::server::vault_compat_api::token_create,
    crate::server::vault_compat_api::token_create_role,
    crate::server::vault_compat_api::read_data,
    crate::server::vault_compat_api::write_data,
    crate::server::vault_compat_api::write_data_post,
    crate::server::vault_compat_api::delete_data,
    crate::server::vault_compat_api::get_metadata,
    crate::server::vault_compat_api::get_metadata_root,
    crate::server::vault_compat_api::delete_metadata,
    crate::server::vault_compat_api::transit_encrypt,
    crate::server::vault_compat_api::transit_decrypt,
    crate::server::vault_compat_api::transit_rewrap,
    crate::server::vault_compat_api::transit_datakey,
    crate::server::vault_compat_api::transit_sign,
    crate::server::vault_compat_api::transit_verify,
    crate::server::vault_compat_api::transit_hmac,
    crate::server::vault_compat_api::transit_rotate,
))]
pub(super) struct VaultCompatPaths;
