import type { EngineInstallState } from "@ryu/blocks/desktop/store-engines.tsx";
import type { StatusKind } from "@ryu/ui/components/status-badge.tsx";
import type { SandboxBackendEntry } from "@/src/hooks/useSandboxBackends.ts";

export const SEARCH_DEBOUNCE_MS = 200;

/** Run-alongside (start/stop) categories, in display order under their headers. */
export const RUN_ALONGSIDE_CATEGORIES = ["media", "voice"] as const;
export const RESTARTABLE_CORE_CHAT_ENGINES = new Set([
	"llamacpp",
	"vllm",
	"sglang",
	"mlx",
	"mlx-vlm",
]);

export const GROUP_LABELS = {
	text: "Text and Embedding",
	media: "Image",
	voice: "Speech",
	sandbox: "Sandboxes",
} satisfies Record<EngineListKind, string>;

/** Human label for an OS family id (as Core reports it in `platforms`). Only the
 *  OS family: a CPU-arch requirement (e.g. Apple Silicon) comes from Core's
 *  `unsupported_reason`, since one `macos` entry may run on both arches. */
export const PLATFORM_LABELS = new Map<string, string>([
	["macos", "macOS"],
	["windows", "Windows"],
	["linux", "Linux"],
]);

export type EngineListKind = "text" | "media" | "voice" | "sandbox";

export interface EngineListItem {
	/** False when this node's OS can't run the engine — no Install is offered. */
	available: boolean;
	/** Uninstall is withheld while the engine is the resident/running one. */
	canUninstall: boolean;
	description: string;
	displayName: string;
	/** The node says a newer build is actually reachable (drives forced install). */
	hasUpdate: boolean;
	id: string;
	/** Installed (text/image/speech) or detected on the node (sandbox backends). */
	installed: boolean;
	/** Null for rows with no install lifecycle of their own (sandbox backends,
	 *  which are detected on the node rather than installed by Ryu). */
	installState: EngineInstallState | null;
	kind: EngineListKind;
	name: string;
	/** The row's live STATE, as the shared status glyph plus the word it shows on
	 *  hover. It used to be a bare `string | null` rendered as a grey text badge;
	 *  three words ("Active", "Running", "Default") repeated down a two-column
	 *  grid is most of what made the section look noisy, and none of them said
	 *  anything the glyph cannot.
	 *
	 *  `label` overrides the kind's default word, which is what lets an image or
	 *  speech engine say "Running" while wearing the same green check a text
	 *  engine's "Active" does — they are the same state under two vocabularies. */
	status: { kind: StatusKind; label?: string } | null;
	/** Current toggle position: active (text) / running (image, speech) /
	 *  default (sandbox). */
	toggled: boolean;
	/** Unknown process state cannot safely offer start/stop. */
	toggleKnown?: boolean;
	/** Why it is unavailable (Core's reason, else a platforms message). */
	unavailableReason?: string;
}

export type PendingKind = "install" | "uninstall" | "toggle";

export interface RowState {
	error: string | null;
	gatewayStale: boolean;
	pending: PendingKind | null;
}

export const EMPTY_ROW_STATE: RowState = {
	pending: null,
	error: null,
	gatewayStale: false,
};

/**
 * Why the connected node can't run an engine. Core's `unsupported_reason` wins:
 * it knows the node's OS, CPU arch, and any operator-placed binary. The
 * `platforms` message is only the fallback for an older Core that omits it.
 */
export function unsupportedReason(
	platforms: string[],
	coreReason?: string | null
): string {
	const fromCore = coreReason?.trim();
	if (fromCore) {
		return fromCore;
	}
	if (platforms.length === 0) {
		return "Not available on this node";
	}
	const labels = platforms.map((p) => PLATFORM_LABELS.get(p) ?? p).join(" / ");
	return `Requires ${labels} — the connected node can't run it`;
}

/**
 * Whether to offer an update for this engine — the NODE's verdict, not a version
 * comparison made here.
 *
 * Comparing `installedVersion` to `latestVersion` client-side is what made this
 * button a lie: engines whose downloader pins its tag at compile time can never
 * reach the upstream version the catalog used to advertise, so the row showed an
 * update forever and pressing it hit an already-installed fast path in Core that
 * did nothing at all.
 */
export function hasEngineUpdate(engine: { updateAvailable: boolean }): boolean {
	return engine.updateAvailable;
}

/** Where to get each sandbox runtime, for the row that cannot install it.
 *
 *  Ryu deliberately never installs Docker: `crates/core/sandbox/src/docker.rs`
 *  carries a LOCKED DECISION (issue #191) to stay detection-only, enforced by a
 *  committed `detect_does_not_install_docker` test. That is not squeamishness —
 *  on macOS the cask still ends in a EULA modal and a privileged-helper prompt,
 *  on Linux the package needs root and `docker` group membership is
 *  root-equivalent, and on Windows it needs admin plus WSL2 plus a reboot. An
 *  "install" that ends with the user typing an admin password is a slower version
 *  of telling them to install it.
 *
 *  What was NOT defensible is what the row said about it. A non-interactive
 *  "Not detected" chip and a sentence reading "install its CLI on the node" named
 *  nothing, linked nowhere, and offered no action — so the honest answer ("Ryu
 *  will not install this one, here is where to get it") was indistinguishable
 *  from a broken feature.
 *
 *  The default "needs elevated privileges" copy is true for the container
 *  runtimes. A backend whose install needs no admin rights, or whose
 *  not-detected state is not always a missing install, overrides it with
 *  `notDetected`. */
export interface SandboxInstallDocs {
	href: string;
	/** Replaces the default not-detected sentence in the row and its badge. */
	notDetected?: string;
	what: string;
}

export const SANDBOX_INSTALL_DOCS = new Map<string, SandboxInstallDocs>([
	[
		"docker",
		{
			href: "https://docs.docker.com/get-started/get-docker/",
			what: "Docker Desktop or Colima",
		},
	],
	[
		"microsandbox",
		{
			href: "https://github.com/microsandbox/microsandbox",
			what: "the microsandbox CLI",
		},
	],
	[
		"opensandbox",
		{
			href: "https://github.com/agentsea/opensandbox",
			what: "the opensandbox CLI",
		},
	],
	[
		"mxc",
		{
			href: "https://github.com/microsoft/mxc",
			// MXC needs no admin setup, and an installed wxc-exec still reads as not
			// detected when this Windows build is unsupported or the only isolation
			// tier left needs host permission edits the operator has not allowed.
			notDetected:
				"Not detected. Ryu does not install MXC, and installing it needs no administrator rights: put wxc-exec on PATH or point RYU_SANDBOX_MXC_BINARY at it. If wxc-exec is already installed, this Windows build may be unsupported, or MXC may need RYU_SANDBOX_MXC_ALLOW_DACL_MUTATION=1 to edit host file permissions for each run.",
			what: "the MXC wxc-exec executor",
		},
	],
]);

/** Platforms a sandbox runtime exists on, mirroring Core's node-support gate. */
export const SANDBOX_PLATFORMS = new Map<string, string[]>([
	["microsandbox", ["linux", "macos"]],
	["opensandbox", ["linux", "macos"]],
	["mxc", ["windows"]],
	["singularity", ["linux"]],
]);

export function sandboxDescription(backend: SandboxBackendEntry): string {
	if (!backend.supported) {
		return unsupportedReason(SANDBOX_PLATFORMS.get(backend.name) ?? []);
	}
	if (backend.detected) {
		return "Detected on this node and ready to use.";
	}
	if (backend.name === "wasmtime") {
		return "Built-in WASM sandbox (compile with the sandbox-wasmtime feature).";
	}
	const docs = SANDBOX_INSTALL_DOCS.get(backend.name);
	if (!docs) {
		return "Not detected — install its CLI on the node to use it.";
	}
	return (
		docs.notDetected ??
		`Not detected. Ryu does not install this one — it needs elevated privileges on every platform — so install ${docs.what} yourself and it is picked up automatically.`
	);
}

export interface EngineToggleLabel {
	disable?: string;
	enable: string;
}

/** Per-kind wording for the engine toggle, so the menu says what the toggle
 *  actually does: a text engine is SWAPPED to (it can never be switched off — the
 *  node always has a resident engine), image/speech engines start and stop, and a
 *  sandbox backend is picked as the default. */
export const TOGGLE_LABELS = {
	text: { enable: "Set as active" },
	media: { enable: "Start", disable: "Stop" },
	voice: { enable: "Start", disable: "Stop" },
	sandbox: { enable: "Set as default" },
} satisfies Record<EngineListKind, EngineToggleLabel>;

/** The engine whose build can be swapped between CPU and GPU. */
export const ACCELERATION_ENGINE = "llamacpp";

/**
 * Image and speech engines whose detail page shows a launch settings section,
 * with the copy that explains when the settings apply.
 */
export const LAUNCH_SETTINGS_DESCRIPTIONS = new Map<string, string>([
	[
		"sdcpp",
		"Hardware and loading options for sd-server. Restart the engine to apply changes. If Core adopted an external server, its flags remain controlled by that server's owner.",
	],
	[
		"outetts",
		"Hardware and synthesis options passed to llama-tts. Changes apply to the next spoken reply.",
	],
	[
		"audiocpp",
		"Server options passed to audiocpp_server, in addition to the Audio runtime settings below. Restart the engine to apply changes. If Core adopted an external server, its flags remain controlled by that server's owner.",
	],
	[
		"ryutts",
		"Runtime and download options for the Ryu Audio sidecar, applied as its process environment. Restart the engine to apply changes. If Core adopted an external server, its environment stays controlled by that server's owner.",
	],
]);
