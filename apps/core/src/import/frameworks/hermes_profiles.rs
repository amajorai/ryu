//! Hermes bots. In Hermes a Bot is a profile: `profiles/<name>/` under the
//! Hermes home mirrors the home itself (`SOUL.md`, `config.yaml`,
//! `memories/MEMORY.md`, `memories/USER.md`, `skills/`, `cron/`, `sessions/`),
//! and `profile.yaml` carries the friendly name and a short role description.
//! Each profile with a `SOUL.md` becomes one Ryu agent, beside the default
//! persona at the root of the home.

use super::*;

/// Most profiles listed per scan.
const MAX_HERMES_PROFILES: usize = 50;
/// Longest agent name or description taken from `profile.yaml`.
const MAX_PROFILE_NAME_CHARS: usize = 80;
const MAX_PROFILE_DESCRIPTION_CHARS: usize = 500;

/// Every `profiles/<name>/` under the Hermes home `root` that holds a
/// persona, sorted by folder name. A bot the user deleted in Hermes keeps its
/// folder for a while and is marked by `profiles/.deleted/<name>`; those are
/// left out.
pub(super) fn hermes_profile_dirs(root: &Path) -> Vec<PathBuf> {
    let profiles = root.join("profiles");
    let Ok(entries) = fs::read_dir(&profiles) else {
        return Vec::new();
    };
    let deleted = profiles.join(".deleted");
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| entry.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter(|entry| !deleted.join(entry.file_name()).exists())
        .map(|entry| entry.path())
        .filter(|dir| dir.join("SOUL.md").is_file())
        .collect();
    dirs.sort();
    dirs.truncate(MAX_HERMES_PROFILES);
    dirs
}

/// True when `dir` is `<home>/profiles/<name>`.
pub(super) fn is_hermes_profile_dir(dir: &Path) -> bool {
    dir.parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("profiles"))
}

/// What a source says about one of its bots: `profile.yaml` and the folder
/// of a Hermes bot, or the manifest of an export archive.
pub(super) struct PersonaProfile {
    /// Bot Mode title, else `display_name`, else the folder name.
    pub name: String,
    /// The role description, when the user or Hermes wrote one.
    pub description: Option<String>,
    /// The profile's own default model, else the one of the Hermes home.
    pub model: Option<String>,
}

/// Read the profile at `dir`. `None` when `dir` is not a profile folder.
pub(super) fn hermes_profile(dir: &Path) -> Option<PersonaProfile> {
    if !is_hermes_profile_dir(dir) {
        return None;
    }
    let folder = dir.file_name()?.to_str()?.to_string();
    let meta = read_yaml(&dir.join("profile.yaml")).unwrap_or(Value::Null);
    let field = |pointer: &str, max: usize| {
        meta.pointer(pointer)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(|text| text.chars().take(max).collect::<String>())
    };
    let name = field("/ui_meta/hermes-bots/title", MAX_PROFILE_NAME_CHARS)
        .or_else(|| field("/display_name", MAX_PROFILE_NAME_CHARS))
        .unwrap_or(folder);
    let home = dir.parent().and_then(Path::parent);
    let model = persona_model(dir, Framework::Hermes)
        .or_else(|| home.and_then(|home| persona_model(home, Framework::Hermes)));
    Some(PersonaProfile {
        name,
        description: field("/description", MAX_PROFILE_DESCRIPTION_CHARS),
        model,
    })
}

/// Memory and skills of every profile under the Hermes home `root`. A
/// profile's skills sit one level deeper than the shared walk reaches
/// (`profiles/<name>/skills/<category>/<skill>/`), so each profile's `skills/`
/// is walked as its own sub-root.
pub(super) fn collect_hermes_profiles(root: &Path, c: &mut Collector) {
    for profile in hermes_profile_dirs(root) {
        collect_memory_docs(&profile.join("memories"), Framework::Hermes, c);
        let skills = profile.join("skills");
        if skills.is_dir() {
            super::super::walk(root, &skills, 1, c);
        }
    }
}

/// True when the home or any of its profiles has `name` (a file or a folder).
pub(super) fn hermes_home_or_profile_has(root: &Path, name: &str) -> bool {
    root.join(name).exists()
        || hermes_profile_dirs(root)
            .iter()
            .any(|profile| profile.join(name).exists())
}

#[cfg(test)]
#[path = "hermes_profiles_tests.rs"]
mod tests;
