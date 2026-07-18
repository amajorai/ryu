// Shared types for the non-interactive `ryu` command layer.
//
// The tui binary is BOTH an interactive TUI and a scriptable CLI (the gh/docker
// shape). This module defines the contracts the dispatcher (`dispatch.ts`) and the
// command registry (`commands.ts`) share: the parsed argv, the per-invocation
// context handed to each handler, the pluggable IO sink (so tests capture output
// instead of writing to the real stdout), and the `CoreApi` seam (so tests mock
// the HTTP layer without a running node). Handlers return a process EXIT CODE.

import type { ApiTarget } from "@ryuhq/core-client/client";
import type {
	AppInfo,
	AppRecord,
	AppUninstallResult,
	CatalogEntry,
} from "@ryuhq/core-client/plugins";
import type {
	ChatStreamHandlers,
	ChatStreamOptions,
	ChatTurn,
} from "../core/chatStream.ts";

/** Output sink. Both methods write RAW strings (no implicit newline) so a handler
 *  controls its own line breaks and streaming (chat deltas) works verbatim. The
 *  real sink targets process.stdout/stderr; tests swap in a capturing sink. */
export interface CliIO {
	err: (s: string) => void;
	out: (s: string) => void;
}

/** Global flags recognized before/around any subcommand. */
export interface GlobalFlags {
	/** `--cascade` — opt into disabling/uninstalling the dependent chain too. */
	cascade: boolean;
	/** `--force` — override a refused update (downgrade). */
	force: boolean;
	/** `-h`/`--help`. */
	help: boolean;
	/** `--json` — machine-readable output for agents/CI instead of a human table. */
	json: boolean;
	/** `--node <url>` — target an arbitrary node URL for this one invocation. */
	node: string | null;
	/** `--version`. */
	version: boolean;
}

/** The result of parsing `process.argv.slice(2)`. */
export interface ParsedArgs {
	/** Positional args AFTER the subcommand (e.g. the app id for `ryu add <id>`). */
	args: string[];
	/** The subcommand token, or null when none was given (→ interactive shell). */
	command: string | null;
	flags: GlobalFlags;
}

/** The subset of the typed Core client the command layer calls. Injecting it as a
 *  bundle (rather than importing the functions directly in handlers) is the test
 *  seam: `dispatch` accepts an override so bun tests run with a fake, no node. */
export interface CoreApi {
	disableApp: (
		t: ApiTarget,
		id: string,
		o?: { cascade?: boolean }
	) => Promise<AppRecord>;
	enableApp: (t: ApiTarget, id: string) => Promise<AppRecord>;
	/** Route one app-contributed `ryu <app> <cmd>` call to the app's sidecar via
	 *  Core's `ext_proxy` (`<method> /api/ext/<pluginId><path>`). Returns the raw
	 *  status + body without throwing on non-2xx — the dispatcher maps the status
	 *  to an exit code so it controls the CLI contract, not the transport. */
	execAppCommand: (
		t: ApiTarget,
		pluginId: string,
		cmd: { method: string; path: string },
		args: string[]
	) => Promise<{ body: string; status: number }>;
	fetchApps: (t: ApiTarget) => Promise<AppInfo[]>;
	fetchAppsCatalog: (t: ApiTarget) => Promise<CatalogEntry[]>;
	installApp: (t: ApiTarget, id: string) => Promise<AppRecord>;
	streamChat: (
		t: ApiTarget,
		turns: ChatTurn[],
		options: ChatStreamOptions,
		handlers: ChatStreamHandlers,
		signal?: AbortSignal
	) => Promise<void>;
	uninstallApp: (
		t: ApiTarget,
		id: string,
		o?: { cascade?: boolean }
	) => Promise<AppUninstallResult>;
}

/** Everything a command handler needs for one invocation. */
export interface CliContext {
	api: CoreApi;
	args: string[];
	flags: GlobalFlags;
	io: CliIO;
	target: ApiTarget;
}

/** One registered subcommand. `name`/`aliases` are matched case-sensitively. */
export interface Command {
	aliases?: string[];
	name: string;
	/** One-line summary shown in `ryu help`. */
	summary: string;
	/** Usage string shown in `ryu help` (e.g. `ryu add <id>`). */
	usage: string;
	/** Run the command; resolve to the process exit code (0 = success). */
	run: (ctx: CliContext) => Promise<number>;
}

/** Thrown by a handler for a bad/missing argument. The dispatcher maps it to exit
 *  code 2 (usage error), distinct from a runtime failure (exit 1). */
export class UsageError extends Error {}
