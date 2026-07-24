// Recipe store: CRUD operations on ~/.ghost/recipes/ JSON files.

use anyhow::{Context, Result};
use std::path::PathBuf;

use super::types::Recipe;

/// Persistent recipe store backed by JSON files in ~/.ghost/recipes/.
pub struct RecipeStore {
    dir: PathBuf,
}

impl RecipeStore {
    /// Open (or create) the recipe store at the default location. Honors
    /// `GHOST_DATA_DIR` (Core sets it to the profile-aware `~/.ryu{profile}/ghost`, so
    /// a dev and a release Ghost don't share one recipe store); falls back to the
    /// legacy `~/.ghost` when unset.
    pub fn open() -> Result<Self> {
        let base = match std::env::var_os("GHOST_DATA_DIR") {
            Some(dir) => PathBuf::from(dir),
            None => dirs::home_dir()
                .ok_or_else(|| anyhow::anyhow!("Cannot determine home directory"))?
                .join(".ghost"),
        };
        let dir = base.join("recipes");
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("Failed to create recipe dir: {}", dir.display()))?;
        Ok(Self { dir })
    }

    /// Open at a custom directory (for testing).
    pub fn open_at(dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&dir)?;
        Ok(Self { dir })
    }

    /// List all recipes.
    pub fn list(&self) -> Result<Vec<Recipe>> {
        let mut recipes = vec![];
        for entry in std::fs::read_dir(&self.dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                if let Ok(r) = self.load_file(&path) {
                    recipes.push(r);
                }
            }
        }
        recipes.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(recipes)
    }

    /// Get a recipe by name.
    pub fn get(&self, name: &str) -> Result<Recipe> {
        let path = self.recipe_path(name);
        self.load_file(&path)
            .with_context(|| format!("Recipe '{}' not found", name))
    }

    /// Save a recipe (create or overwrite).
    pub fn save(&self, recipe: &Recipe) -> Result<()> {
        let path = self.recipe_path(&recipe.name);
        let json = serde_json::to_string_pretty(recipe)?;
        std::fs::write(&path, json)
            .with_context(|| format!("Failed to write recipe to {}", path.display()))
    }

    /// Save a recipe from a JSON string.
    pub fn save_json(&self, json: &str) -> Result<Recipe> {
        let recipe: Recipe = serde_json::from_str(json).context("Invalid recipe JSON")?;
        self.save(&recipe)?;
        Ok(recipe)
    }

    /// Delete a recipe by name.
    pub fn delete(&self, name: &str) -> Result<()> {
        let path = self.recipe_path(name);
        if path.exists() {
            std::fs::remove_file(&path)
                .with_context(|| format!("Failed to delete recipe '{}'", name))
        } else {
            Err(anyhow::anyhow!("Recipe '{}' not found", name))
        }
    }

    fn recipe_path(&self, name: &str) -> PathBuf {
        let safe = name.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_");
        self.dir.join(format!("{safe}.json"))
    }

    fn load_file(&self, path: &PathBuf) -> Result<Recipe> {
        let data = std::fs::read_to_string(path)?;
        serde_json::from_str(&data).with_context(|| format!("Invalid JSON in {}", path.display()))
    }
}
