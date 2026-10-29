//! Inbound protocol-compat translation: Anthropic Messages and Google Gemini
//! (generateContent) wire formats → the gateway's unified OpenAI-shaped body,
//! and the unified response/stream back to each native format.
//!
//! These are the RECEIVING side of the same formats the outbound providers
//! speak. The gateway already accepts OpenAI `/v1/chat/completions` and routes
//! every format through one pipeline; these pure functions let a Claude Code /
//! Gemini client point its `base_url` at this gateway and get the full governed
//! pipeline (budgets, firewall, routing, audit, live traffic) without speaking
//! OpenAI.
//!
//! Every function here is PURE (JSON in → JSON out, or SSE bytes in → SSE bytes
//! out) so the translation surface is unit-testable without a running gateway.
//! The axum handlers in `api/compat.rs` call the pipeline then map back through
//! these same functions.
//!
//! Lossiness policy: translate what a client needs to interoperate (text, roles,
//! tool definitions, tool calls, token counts, stop reasons). Anything a format
//! cannot represent is DROPPED — never guessed — and exotic blocks are passed
//! through verbatim where a native field exists (mirroring the outbound
//! providers' `ryu_content_blocks` convention).

pub mod anthropic;
pub mod gemini;
pub mod responses;
pub mod responses_tools;
