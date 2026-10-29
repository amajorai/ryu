//! Gaming mode: detect a running game and free the RAM/VRAM local models hold.
//!
//! Local inference engines (llama.cpp, Ollama, vLLM, …) and the other
//! weight-loading sidecars (embeddings, rerank, speech, TTS, image) can pin
//! gigabytes of memory while idle. When the user is playing a game that memory
//! is better spent on the game, so gaming mode:
//!
//! 1. detects a running game (opt-in, Discord-style process detection), or
//!    honours a manual "Gaming" status reported by the desktop;
//! 2. stops every model sidecar that has no request in flight, and asks an
//!    externally attached Ollama to unload its resident models; and
//! 3. refuses to start or wake those sidecars again until the game closes, so
//!    background features (embeddings, predictive typing, …) cannot quietly
//!    reload a model mid-match.
//!
//! Detection is **off by default**. It only reads the local process table
//! (names and executable paths); nothing leaves the node.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::sidecar::SidecarManager;

/// How often the detector re-scans the process table and re-applies the pause.
const SCAN_INTERVAL: Duration = Duration::from_secs(10);

/// File (under the Ryu data dir) holding the persisted [`GamingSettings`].
const SETTINGS_FILE: &str = "gaming-mode.json";

/// Upper bound on user-supplied extra process names, so a pasted list cannot make
/// every scan quadratic.
const MAX_EXTRA_PROCESSES: usize = 64;

/// Sidecars that load model weights. Every swappable local engine plus the
/// single-purpose model servers that are not engines (embeddings, rerank,
/// classifier, speech, TTS, image generation).
const NON_ENGINE_MODEL_SIDECARS: &[&str] = &[
    "llamacpp-embed",
    "llamacpp-rerank",
    "llamacpp-classify",
    "llamacpp-speech",
    "llamacpp-guard",
    "audiocpp",
    "outetts",
    "ryutts",
    "sdcpp",
    "whispercpp",
    "parakeet",
];

/// Executable-path fragments of game-library folders created by the common
/// launchers. Paths are compared lowercased with `/` separators.
const LIBRARY_ROOTS: &[&str] = &[
    "/steamapps/common/",
    "/epic games/",
    "/gog galaxy/games/",
    "/gog games/",
    "/xboxgames/",
    "/riot games/",
    "/ea games/",
    "/origin games/",
    "/ubisoft game launcher/games/",
    "/battle.net/games/",
    "/heroic/",
    "/lutris/",
];

/// Executable stems of well-known games that do not live under a launcher
/// library root (Battle.net and Riot install to arbitrary folders, and a
/// process without a readable executable path can still be matched by name).
const KNOWN_GAME_EXECUTABLES: &[&str] = &[
    "cs2",
    "csgo",
    "dota2",
    "valorant-win64-shipping",
    "league of legends",
    "fortniteclient-win64-shipping",
    "r5apex",
    "r5apex_dx12",
    "overwatch",
    "wow",
    "wowclassic",
    "diablo iv",
    "cod",
    "modernwarfare",
    "gta5",
    "gta5_enhanced",
    "eldenring",
    "rocketleague",
    "robloxplayerbeta",
    "destiny2",
    "minecraft.windows",
    "rainbowsix",
    "pubg",
    "tslgame",
    "helldivers2",
    "baldur's gate 3",
    "bg3",
    "bg3_dx11",
    "cyberpunk2077",
    "starfield",
    "marvel-win64-shipping",
    "deadlock",
];

/// Name fragments of launchers, helpers, installers, and anti-cheat services that
/// live next to games but are not games. A match here always wins, so a Steam
/// web helper under `steamapps` never flips gaming mode on.
const NON_GAME_FRAGMENTS: &[&str] = &[
    "launcher",
    "steamwebhelper",
    "steamservice",
    "steamerrorreporter",
    "crashhandler",
    "crashreport",
    "crashpad",
    "easyanticheat",
    "beservice",
    "battleye",
    "vanguard",
    "vgc",
    "riotclient",
    "redist",
    "vcredist",
    "vc_redist",
    "dxsetup",
    "dotnet",
    "installer",
    "setup",
    "uninstall",
    "unins000",
    "update",
    "prereq",
    "overlay",
    "helper",
    "service",
];

/// Executable stems of non-game apps that Steam or Epic install under a game
/// library root (desktop tools, editors, the Heroic launcher itself). Running
/// one of these must never unload the user's models.
const KNOWN_NON_GAMES: &[&str] = &[
    "wallpaper32",
    "wallpaper64",
    "wallpaperservice32",
    "obs32",
    "obs64",
    "blender",
    "blender-launcher",
    "aseprite",
    "unrealeditor",
    "ue4editor",
    "unrealeditor-cmd",
    "heroic",
    "soundpad",
    "vtube studio",
    "fpsmonitor",
    "rtss",
    "msiafterburner",
];

/// Persisted user preferences for gaming mode.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(default, rename_all = "camelCase")]
pub struct GamingSettings {
    /// Detect running games from the process table. Off by default.
    pub detection_enabled: bool,
    /// Stop local model sidecars while gaming mode is active.
    pub free_local_models: bool,
    /// Extra executable names (without extension) the user wants treated as games.
    pub extra_processes: Vec<String>,
    /// Executable names (without extension) that must never count as games,
    /// for apps the heuristics misjudge.
    pub ignored_processes: Vec<String>,
}

impl Default for GamingSettings {
    fn default() -> Self {
        Self {
            detection_enabled: false,
            free_local_models: true,
            extra_processes: Vec::new(),
            ignored_processes: Vec::new(),
        }
    }
}

impl GamingSettings {
    /// Trim, lowercase, strip a trailing `.exe`, dedupe, and cap the custom lists.
    fn normalized(mut self) -> Self {
        self.extra_processes = normalize_list(&self.extra_processes);
        self.ignored_processes = normalize_list(&self.ignored_processes);
        self
    }
}

/// The game the detector currently sees.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DetectedGame {
    /// Display name: the executable stem, as the process table reports it.
    pub name: String,
    /// Unix epoch milliseconds when the detector first saw this game.
    pub since_ms: u64,
}

/// Gaming-mode state as reported by `GET /api/presence`.
#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct GamingSnapshot {
    /// Gaming mode is on (a game is detected or the user chose Gaming).
    pub active: bool,
    /// The detected game, when detection found one.
    pub detected_game: Option<DetectedGame>,
    /// Model sidecars are currently held stopped.
    pub models_paused: bool,
    /// Persisted preferences.
    pub settings: GamingSettings,
}

static SETTINGS: OnceLock<RwLock<GamingSettings>> = OnceLock::new();
static DETECTED: RwLock<Option<DetectedGame>> = RwLock::new(None);
static MODELS_PAUSED: AtomicBool = AtomicBool::new(false);
static SPAWNED: AtomicBool = AtomicBool::new(false);
/// Wakes the detector early after a settings or status change, so the pause
/// applies (or lifts) without waiting a full scan interval.
static KICK: OnceLock<tokio::sync::Notify> = OnceLock::new();

fn kick() -> &'static tokio::sync::Notify {
    KICK.get_or_init(tokio::sync::Notify::new)
}

fn settings_path() -> PathBuf {
    crate::paths::state_path(SETTINGS_FILE)
}

fn settings_cell() -> &'static RwLock<GamingSettings> {
    SETTINGS.get_or_init(|| {
        let loaded = std::fs::read(settings_path())
            .ok()
            .and_then(|bytes| serde_json::from_slice::<GamingSettings>(&bytes).ok())
            .map(GamingSettings::normalized)
            .unwrap_or_default();
        RwLock::new(loaded)
    })
}

/// Current persisted preferences.
pub fn settings() -> GamingSettings {
    settings_cell()
        .read()
        .map(|guard| guard.clone())
        .unwrap_or_default()
}

/// Replace the preferences, persist them, and re-evaluate the pause right away.
pub fn set_settings(next: GamingSettings) -> std::io::Result<GamingSettings> {
    let next = next.normalized();
    let path = settings_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(&next).map_err(std::io::Error::other)?;
    std::fs::write(&path, bytes)?;
    if let Ok(mut guard) = settings_cell().write() {
        *guard = next.clone();
    }
    if !next.detection_enabled {
        set_detected(None);
    }
    notify_changed();
    Ok(next)
}

/// Ask the detector loop to re-evaluate now (a status report changed).
pub fn notify_changed() {
    kick().notify_one();
}

fn set_detected(game: Option<DetectedGame>) {
    if let Ok(mut guard) = DETECTED.write() {
        *guard = game;
    }
}

/// The game the detector currently sees, if any.
pub fn detected_game() -> Option<DetectedGame> {
    DETECTED.read().ok().and_then(|guard| guard.clone())
}

/// Gaming mode is on: a game is detected, or the desktop reported "Gaming".
pub fn is_active() -> bool {
    detected_game().is_some() || crate::presence::reported_gaming()
}

/// Whether model sidecars are currently held stopped. Checked by the sidecar
/// manager before it starts or wakes a model sidecar.
pub fn models_paused() -> bool {
    MODELS_PAUSED.load(Ordering::Relaxed)
}

/// True for every sidecar that loads model weights.
pub fn is_model_sidecar(name: &str) -> bool {
    crate::sidecar::active_engine::is_local_engine(name)
        || NON_ENGINE_MODEL_SIDECARS.contains(&name)
}

/// Error text for a refused start, shared so every caller shows the same hint.
pub fn paused_error(name: &str) -> anyhow::Error {
    anyhow::anyhow!(
        "gaming mode is freeing memory for your game, so the local model '{name}' stays stopped \
         until the game closes (or until you turn off Gaming mode or its model freeing in Settings)"
    )
}

/// Snapshot for the presence API.
pub fn snapshot() -> GamingSnapshot {
    GamingSnapshot {
        active: is_active(),
        detected_game: detected_game(),
        models_paused: models_paused(),
        settings: settings(),
    }
}

fn normalize_list(names: &[String]) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    names
        .iter()
        .map(|name| normalize_stem(name))
        .filter(|name| !name.is_empty() && seen.insert(name.clone()))
        .take(MAX_EXTRA_PROCESSES)
        .collect()
}

fn normalize_stem(name: &str) -> String {
    let lowered = name.trim().to_lowercase();
    lowered
        .strip_suffix(".exe")
        .map(str::to_owned)
        .unwrap_or(lowered)
        .trim()
        .to_owned()
}

/// Classify one process. Returns the display name when it looks like a game.
///
/// Pure so the heuristics are unit-testable without a process table: a process is
/// a game when its executable lives under a launcher library root, or its stem is a
/// known game or on the user's list, and it is not a launcher/helper/installer or a
/// known non-game tool. The user's ignore list beats everything.
pub fn classify_process(
    name: &str,
    exe: Option<&Path>,
    extra: &[String],
    ignored: &[String],
) -> Option<String> {
    let stem = normalize_stem(name);
    if stem.is_empty() || ignored.iter().any(|entry| entry == &stem) {
        return None;
    }
    let user_listed = extra.iter().any(|entry| entry == &stem);
    if !user_listed
        && (KNOWN_NON_GAMES.contains(&stem.as_str())
            || NON_GAME_FRAGMENTS.iter().any(|frag| stem.contains(frag)))
    {
        return None;
    }
    let known = user_listed || KNOWN_GAME_EXECUTABLES.contains(&stem.as_str());
    let under_library = exe.is_some_and(|path| {
        let normalized = path.to_string_lossy().replace('\\', "/").to_lowercase();
        LIBRARY_ROOTS.iter().any(|root| normalized.contains(root))
            // Launcher installs share the "Epic Games" folder with the games,
            // and so does the Unreal Engine editor (`Epic Games/UE_5.x`).
            && !normalized.contains("/epic games/launcher/")
            && !normalized.contains("/epic games/ue_")
            && !normalized.contains("/riot client/")
    });
    (known || under_library).then(|| name.trim().trim_end_matches(".exe").to_owned())
}

fn scan_for_game(
    sys: &mut sysinfo::System,
    extra: &[String],
    ignored: &[String],
) -> Option<String> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, UpdateKind};
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_exe(UpdateKind::OnlyIfNotSet)
            .with_user(UpdateKind::Always),
    );
    // Process names are controlled by their owners. Only the OS user running
    // Core may put its model sidecars into gaming mode.
    let current_pid = sysinfo::get_current_pid().ok()?;
    let current_user = sys.process(current_pid)?.user_id()?.clone();
    // Pick deterministically so a multi-process game does not flicker its name.
    let mut found: Vec<String> = sys
        .processes()
        .values()
        .filter(|process| process.user_id() == Some(&current_user))
        .filter_map(|process| {
            classify_process(
                &process.name().to_string_lossy(),
                process.exe(),
                extra,
                ignored,
            )
        })
        .collect();
    found.sort();
    found.into_iter().next()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// Ask an Ollama daemon on its default port to drop every resident model. Covers
/// the case where the user runs Ollama themselves, outside Core's sidecar
/// manager, so stopping the managed sidecar would not free anything.
async fn unload_external_ollama() {
    let Some(base) = crate::sidecar::active_engine::local_engine_base_url("ollama") else {
        return;
    };
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
    {
        Ok(client) => client,
        Err(_) => return,
    };
    let Ok(response) = client.get(format!("{base}/api/ps")).send().await else {
        return;
    };
    let Ok(body) = response.json::<serde_json::Value>().await else {
        return;
    };
    let models = body
        .get("models")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    for model in models {
        let Some(name) = model.get("name").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let unload = client
            .post(format!("{base}/api/generate"))
            .json(&serde_json::json!({ "model": name, "keep_alive": 0 }))
            .send()
            .await;
        match unload {
            Ok(_) => tracing::info!(model = name, "gaming mode: unloaded Ollama model"),
            Err(error) => {
                tracing::debug!(model = name, "gaming mode: Ollama unload failed: {error}")
            }
        }
    }
}

/// Start the detector loop once per process.
pub fn spawn(manager: Arc<SidecarManager>) {
    if SPAWNED.swap(true, Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async move {
        let mut sys = sysinfo::System::new();
        let mut was_paused = false;
        loop {
            let prefs = settings();
            // A node shared with an organization has no single player to detect
            // games for; presence writes are refused there too.
            let personal_node = crate::server::node_org_id().is_none();
            if prefs.detection_enabled && personal_node {
                let found =
                    scan_for_game(&mut sys, &prefs.extra_processes, &prefs.ignored_processes);
                let current = detected_game();
                match (found, current) {
                    (Some(name), Some(existing)) if existing.name == name => {}
                    (Some(name), _) => {
                        tracing::info!(game = %name, "gaming mode: game detected");
                        set_detected(Some(DetectedGame {
                            name,
                            since_ms: now_ms(),
                        }));
                    }
                    (None, Some(existing)) => {
                        tracing::info!(game = %existing.name, "gaming mode: game closed");
                        set_detected(None);
                    }
                    (None, None) => {}
                }
            } else {
                set_detected(None);
            }

            let pause = is_active() && prefs.free_local_models;
            MODELS_PAUSED.store(pause, Ordering::Relaxed);
            if pause {
                // Re-applied every tick: a sidecar busy on the first pass is
                // stopped once its request finishes.
                let stopped = manager.pause_model_sidecars().await;
                if !stopped.is_empty() {
                    tracing::info!(?stopped, "gaming mode: stopped local model sidecars");
                }
                if !was_paused {
                    unload_external_ollama().await;
                }
            } else if was_paused {
                tracing::info!("gaming mode: local models may load again");
            }
            was_paused = pause;

            tokio::select! {
                () = tokio::time::sleep(SCAN_INTERVAL) => {}
                () = kick().notified() => {}
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steam_library_game_is_detected() {
        let path = Path::new(r"C:\Program Files (x86)\Steam\steamapps\common\Hades\Hades.exe");
        assert_eq!(
            classify_process("Hades.exe", Some(path), &[], &[]),
            Some("Hades".to_owned())
        );
    }

    #[test]
    fn launcher_helpers_are_not_games() {
        let helper =
            Path::new(r"C:\Program Files (x86)\Steam\steamapps\common\Foo\UnityCrashHandler64.exe");
        assert_eq!(
            classify_process("UnityCrashHandler64.exe", Some(helper), &[], &[]),
            None
        );
        let launcher = Path::new(
            r"C:\Program Files (x86)\Epic Games\Launcher\Portal\Binaries\Win64\EpicGamesLauncher.exe",
        );
        assert_eq!(
            classify_process("EpicGamesLauncher.exe", Some(launcher), &[], &[]),
            None
        );
        let redist = Path::new(
            "/home/me/.steam/steam/steamapps/common/Steamworks Shared/_CommonRedist/vcredist.exe",
        );
        assert_eq!(
            classify_process("vcredist.exe", Some(redist), &[], &[]),
            None
        );
    }

    #[test]
    fn known_game_matches_without_exe_path() {
        // Elevated processes can hide their path; the stem is enough.
        assert_eq!(
            classify_process("cs2.exe", None, &[], &[]),
            Some("cs2".to_owned())
        );
        assert_eq!(classify_process("notepad.exe", None, &[], &[]), None);
    }

    #[test]
    fn user_listed_process_wins_over_exclusions() {
        let extra = vec!["mygameservice".to_owned()];
        assert_eq!(
            classify_process("MyGameService.exe", None, &extra, &[]),
            Some("MyGameService".to_owned())
        );
    }

    #[test]
    fn settings_normalize_extra_processes() {
        let settings = GamingSettings {
            detection_enabled: true,
            free_local_models: true,
            extra_processes: vec![" Foo.EXE ".into(), "foo".into(), String::new()],
            ignored_processes: vec!["Wallpaper64.exe".into()],
        }
        .normalized();
        assert_eq!(settings.extra_processes, vec!["foo".to_owned()]);
        assert_eq!(settings.ignored_processes, vec!["wallpaper64".to_owned()]);
    }

    #[test]
    fn steam_and_epic_tools_are_not_games() {
        let cases = [
            (
                "wallpaper64.exe",
                r"C:\Program Files (x86)\Steam\steamapps\common\wallpaper_engine\wallpaper64.exe",
            ),
            (
                "obs64.exe",
                r"C:\Program Files (x86)\Steam\steamapps\common\OBS Studio\bin\64bit\obs64.exe",
            ),
            (
                "blender.exe",
                r"C:\Program Files (x86)\Steam\steamapps\common\Blender\blender.exe",
            ),
            (
                "Aseprite.exe",
                r"C:\Program Files (x86)\Steam\steamapps\common\Aseprite\Aseprite.exe",
            ),
            (
                "UnrealEditor.exe",
                r"C:\Program Files\Epic Games\UE_5.4\Engine\Binaries\Win64\UnrealEditor.exe",
            ),
            (
                "ShaderCompileWorker.exe",
                r"C:\Program Files\Epic Games\UE_5.4\Engine\Binaries\Win64\ShaderCompileWorker.exe",
            ),
            ("heroic", "/home/me/.config/heroic/heroic"),
        ];
        for (name, path) in cases {
            assert_eq!(
                classify_process(name, Some(Path::new(path)), &[], &[]),
                None,
                "{name}"
            );
        }
    }

    #[test]
    fn user_ignore_list_beats_every_heuristic() {
        let path = Path::new(r"C:\Program Files (x86)\Steam\steamapps\common\Hades\Hades.exe");
        let ignored = vec!["hades".to_owned()];
        assert_eq!(
            classify_process("Hades.exe", Some(path), &[], &ignored),
            None
        );
        let cs2 = vec!["cs2".to_owned()];
        assert_eq!(classify_process("cs2.exe", None, &cs2, &cs2), None);
    }

    #[test]
    fn model_sidecars_cover_engines_and_speech() {
        assert!(is_model_sidecar("llamacpp"));
        assert!(is_model_sidecar("ollama"));
        assert!(is_model_sidecar("llamacpp-embed"));
        assert!(is_model_sidecar("whispercpp"));
        assert!(!is_model_sidecar("ghost"));
        assert!(!is_model_sidecar("tailscale"));
    }
}
