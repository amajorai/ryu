//! English sources for the context-window breakdown.
//!
//! Same shape as the templates in [`super`]: each `*_MESSAGE` is a
//! [`Template`](crate::i18n::Template) built with `format!` and one named
//! argument per placeholder, written as a whole sentence. They are re-exported
//! from [`super`], so callers keep using `i18n::messages::NAME_MESSAGE`.
#![allow(clippy::useless_format)]

/// Every template in this module, for the catalog round-trip test; add each
/// new `*_MESSAGE` here too.
#[cfg(test)]
pub(super) const ALL: &[super::Template] = &[];
