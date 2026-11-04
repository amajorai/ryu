//! Device-code pairing, the ACL vocabulary, per-resource permission enforcement and ACL CRUD.
//!
//! Split out of `server/mod.rs`; every item is re-exported from `crate::server`.

mod device_code_pairing;
pub(in crate::server) use device_code_pairing::*;
mod acl_permission_vocabulary;
pub(crate) use acl_permission_vocabulary::*;
mod per_resource_acl;
pub(in crate::server) use per_resource_acl::*;
mod principal_directory;
pub(in crate::server) use principal_directory::*;
