//! Spaces and RAG handlers: spaces, documents, files, graphs and embeddings.
//!
//! Split out of `server/mod.rs`; every item is re-exported from `crate::server`.

mod spaces_rag;
pub(in crate::server) use spaces_rag::*;
mod space_package;
pub(in crate::server) use space_package::*;
mod retrieval_mode;
pub(in crate::server) use retrieval_mode::*;
mod document_search;
pub(crate) use document_search::*;
mod space_search;
pub(crate) use space_search::*;
mod space_database;
pub(in crate::server) use space_database::*;
mod document_blob;
pub(in crate::server) use document_blob::*;
mod document_version;
pub(in crate::server) use document_version::*;
mod document_backlinks;
pub(in crate::server) use document_backlinks::*;
mod embedding_model;
pub(in crate::server) use embedding_model::*;
