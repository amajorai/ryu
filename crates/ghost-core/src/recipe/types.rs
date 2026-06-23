// Recipe v2 types — compatible with ghost-os schema.
// Field names use snake_case JSON serialization to match ghost-os JSON files.

use std::collections::HashMap;
use serde::{Deserialize, Serialize};

/// A Ghost recipe: parameterized, replayable workflow.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Recipe {
    pub schema_version: u32,
    pub name: String,
    pub description: String,
    pub app: Option<String>,
    pub params: Option<HashMap<String, RecipeParam>>,
    pub preconditions: Option<RecipePreconditions>,
    pub steps: Vec<RecipeStep>,
    pub on_failure: Option<String>,
}

/// A recipe parameter definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecipeParam {
    #[serde(rename = "type")]
    pub param_type: String,
    pub description: String,
    pub required: Option<bool>,
}

/// Preconditions that must be true before a recipe runs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecipePreconditions {
    pub app_running: Option<String>,
    pub url_contains: Option<String>,
}

/// A single step in a recipe.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecipeStep {
    pub id: u32,
    pub action: String,
    pub target: Option<Locator>,
    pub params: Option<HashMap<String, String>>,
    pub wait_after: Option<RecipeWaitCondition>,
    pub note: Option<String>,
    pub on_failure: Option<String>,
}

/// Element locator used in recipe steps.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Locator {
    pub query: Option<String>,
    pub role: Option<String>,
    pub dom_id: Option<String>,
    pub dom_class: Option<String>,
    pub identifier: Option<String>,
    pub app: Option<String>,
}

/// A wait condition within a recipe step.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecipeWaitCondition {
    pub condition: String,
    pub target: Option<Locator>,
    pub value: Option<String>,
    pub timeout: Option<f64>,
}

/// Result of running a recipe.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecipeRunResult {
    pub recipe_name: String,
    pub success: bool,
    pub steps_completed: u32,
    pub total_steps: u32,
    pub step_results: Vec<RecipeStepResult>,
    pub error: Option<String>,
}

/// Result of a single recipe step.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecipeStepResult {
    pub step_id: u32,
    pub action: String,
    pub success: bool,
    pub duration_ms: u64,
    pub error: Option<String>,
    pub note: Option<String>,
}
