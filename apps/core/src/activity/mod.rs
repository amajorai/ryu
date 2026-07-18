//! Core-side activity glue.
//!
//! The activity **primitive** (the [`ryu_activity::ActivityItem`] contract and the
//! SQLite-backed [`ryu_activity::ActivityStore`]) lives in the extracted
//! `ryu-activity` crate. What stays here is [`ingest`] — the per-engine event
//! *mappers* and their subscribe-loops — because they consume Core types
//! (monitors/approvals/meetings/quests) and cannot move into the crate without it
//! depending back on `apps/core`.

pub mod ingest;
