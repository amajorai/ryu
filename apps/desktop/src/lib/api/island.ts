// Island (the Electron companion overlay) install + launch — Tauri command binding.
//
// Island is a device-local Electron process (loopback :7989), not a Core sidecar, so
// it is installed and launched by the desktop shell rather than Core. This wraps the
// `install_and_launch_island` Rust command (see src-tauri/src/lib.rs), which downloads
// the platform release bundle into `~/.ryu/island/` (extracting the `.app` on macOS),
// then spawns it detached. Island self-guards with a single-instance lock, so calling
// this when it is already running just focuses the existing window.
import { invoke } from "@tauri-apps/api/core";

/**
 * Ensure the Island companion is installed, then launch it. Resolves to the launched
 * bundle path (or `"dev"` in development, where turbo owns Island). Rejects on an
 * unsupported platform or a failed download/launch — callers should treat that as
 * non-fatal (Island is a companion, not required for the app to function).
 */
export const installAndLaunchIsland = (): Promise<string> =>
	invoke("install_and_launch_island");
