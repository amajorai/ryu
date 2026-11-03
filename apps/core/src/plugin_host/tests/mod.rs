// Each split-out module is named here so its suite is visible from the module
// it covers; everything else arrives through the parent's glob.
use super::app_events::AppEventActivity;
use super::context::HookContext;
use super::dispatch::phase_matches;
use super::lifecycle_events::plugin_update_event;
use super::middleware::preserve_middleware_identity;
use super::phases::ON_TOOL_RESULT;
use super::run::{glob_match, parse_directive};
use super::view_actions::view_action_event;
use super::*;
use crate::plugin_manifest::HookMatch;
use serde_json::json;

mod directives;
mod events;
mod gates;
mod live;
mod live_guards;
