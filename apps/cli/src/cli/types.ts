// Shared types for the non-interactive `ryu` command layer.
//
// The tui binary is BOTH an interactive TUI and a scriptable CLI (the gh/docker
// shape). This module defines the contracts the dispatcher (`dispatch.ts`) and the
// command registry (`commands.ts`) share: the parsed argv, the per-invocation
// context handed to each handler, the pluggable IO sink (so tests capture output
// instead of writing to the real stdout), and the `CoreApi` seam (so tests mock
// the HTTP layer without a running node). Handlers return a process EXIT CODE.

import type {
	ActionCallInput,
	ActionCallResult,
} from "@ryuhq/core-client/actions";
import type {
	ApiTarget,
	RequestOptions,
	request,
} from "@ryuhq/core-client/client";
import type {
	AppInfo,
	AppRecord,
	AppUninstallResult,
	CatalogEntry,
	previewAppLifecycle,
} from "@ryuhq/core-client/plugins";
import type {
	ChatStreamHandlers,
	ChatStreamOptions,
	ChatTurn,
} from "../core/chatStream.ts";
import { LocalizedError } from "./localizedText.ts";
import type { TroubleshootHost } from "./troubleshoot.ts";
import type { ContainerHost } from "./vaultIsolation.ts";

/** Output sink. Both methods write RAW strings (no implicit newline) so a handler
 *  controls its own line breaks and streaming (chat deltas) works verbatim. The
 *  real sink targets process.stdout/stderr; tests swap in a capturing sink. */
export interface CliIO {
	err: (s: string) => void;
	out: (s: string) => void;
}

/** Global flags recognized before/around any subcommand. */
export interface GlobalFlags {
	/** `--agent <id>` — calling agent for a governed Action invocation. */
	agent: string | null;
	/** `--cascade` — opt into disabling/uninstalling the dependent chain too. */
	cascade: boolean;
	/** `--dry-run` — preview a mutating command without applying changes. */
	dryRun: boolean;
	/** `-f`/`--file <path>` — input file for a file-backed command. */
	file: string | null;
	/** `--fix` — apply the safe fixes owned by the command, when supported. */
	fix: boolean;
	/** `--force` — override a refused update (downgrade). */
	force: boolean;
	/** `-h`/`--help`. */
	help: boolean;
	/** `--include-secrets` — include an encrypted local secret envelope. */
	includeSecrets: boolean;
	/** `--json` — machine-readable output for agents/CI instead of a human table. */
	json: boolean;
	/** `--kind app|plugin|all` — narrow `list`/`catalog` to one classification.
	 *  Null = unset, which resolves to `"all"` (see `parseKindFilter`). */
	kind: string | null;
	/** `--node <name|url>` — target a saved node (by name, then URL) or an http(s)
	 *  URL for this one invocation; see core/nodeTarget.ts. */
	node: string | null;
	/** `--print` — print a config snippet instead of writing it (`ryu connect`). */
	print: boolean;
	/** `--template <t>` — the `ryu init` scaffold template. Null = unset, in which
	 *  case create-ryu-app picks its own default; the tui deliberately does not
	 *  mirror that default so the two can never disagree. */
	template: string | null;
	/** `--token-env` — reference `$RYU_CORE_TOKEN` in a coding agent's config
	 *  instead of writing the node token inline (`ryu connect`). */
	tokenEnv: boolean;
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
	/** The raw argv tokens AFTER the subcommand token, unparsed. Command groups
	 *  with their own flags (`ryu secrets --env prod …`) or a `-- CMD ARGS…`
	 *  passthrough parse these instead of the global-flag-filtered `args`. */
	rawArgs: string[];
}

/** The subset of the typed Core client the command layer calls. Injecting it as a
 *  bundle (rather than importing the functions directly in handlers) is the test
 *  seam: `dispatch` accepts an override so bun tests run with a fake, no node. */
export interface CoreApi {
	/** Raw Core request seam for legacy lifecycle commands not yet specialized in core-client. */
	call?: (
		t: ApiTarget,
		path: string,
		options?: RequestOptions
	) => ReturnType<typeof request>;
	/** Call one canonical Action through Core's existing approval/tool plane. */
	callAction?: (
		t: ApiTarget,
		actionId: string,
		input: ActionCallInput
	) => Promise<ActionCallResult>;
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
	/** Preview a supported app/plugin lifecycle operation without changing Core. */
	previewAppLifecycle?: (
		t: ApiTarget,
		id: string,
		action: "install" | "enable" | "disable" | "uninstall" | "update",
		options?: {
			cascade?: boolean;
			channel?: string;
			force?: boolean;
			version?: string;
		}
	) => ReturnType<typeof previewAppLifecycle>;
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

/** The captured result of one out-of-process scaffold run. Output is CAPTURED
 *  rather than inherited so it flows back through {@link CliIO}: a child writing
 *  straight to the real stdout would corrupt a `--json` envelope, and an inherited
 *  stream is invisible to the tests. */
export interface ScaffoldResult {
	exitCode: number;
	stderr: string;
	stdout: string;
}

/** Runs the external scaffolder with `argv` (already the create-ryu-app argv:
 *  `<name> [--template <t>]`). Kept as an injected function for the same reason
 *  {@link CoreApi} is: it is the only side-effecting escape hatch in the command
 *  layer, so tests swap in a fake and `ryu init` never spawns a process. */
export type ScaffoldRunner = (argv: string[]) => Promise<ScaffoldResult>;

/** Runs a child process with inherited stdio and the given environment, resolving
 *  to its exit code (`ryu secrets run`). Injected so tests never spawn and so a
 *  test can assert the environment a child would receive. */
export type ProcessRunner = (
	cmd: string[],
	env: Record<string, string>
) => Promise<number>;

/** A minimal `fetch` for local probes (`ryu doctor agents`). Injected so tests
 *  never open a socket. */
export type FetchLike = (
	input: string,
	init?: RequestInit
) => Promise<Response>;

/** Asks one question and resolves to the answer, or null without a terminal. */
export type LinePrompter = (question: string) => Promise<string | null>;

/** Everything a command handler needs for one invocation. */
export interface CliContext {
	api: CoreApi;
	args: string[];
	/** Docker and host seams for `ryu secrets run --isolation=container`;
	 *  the real host when unset. */
	containerHost?: ContainerHost;
	/** Process environment for commands that read credentials from it
	 *  (`RYU_VAULT_TOKEN`). Defaults to `process.env`. */
	env: Record<string, string | undefined>;
	/** HTTP for direct probes that do not go through core-client. */
	fetch: FetchLike;
	flags: GlobalFlags;
	io: CliIO;
	/** Ask one question on the terminal and resolve to the typed line, or null
	 *  when stdin/stdout is not an interactive terminal (or input ended). Used by
	 *  interactive commands such as `ryu-cli agents access <id> pick`. */
	promptLine: LinePrompter;
	/** See {@link ParsedArgs.rawArgs}. */
	rawArgs: string[];
	/** Read all of stdin as text, or null when stdin is an interactive TTY. */
	readStdin: () => Promise<string | null>;
	/** Out-of-process project scaffolding (`ryu init`). Not part of {@link CoreApi}
	 *  because it never touches the node — it is a local developer action. */
	scaffold: ScaffoldRunner;
	/** Child-process runner for `ryu secrets run`. */
	spawn: ProcessRunner;
	target: ApiTarget;
	/** Filesystem, socket, browser and network seams for `ryu troubleshoot`;
	 *  the real host when unset. */
	troubleshootHost?: TroubleshootHost;
}

/** One registered subcommand. `name`/`aliases` are matched case-sensitively. */
export interface Command {
	aliases?: string[];
	name: string;
	/** Run the command; resolve to the process exit code (0 = success). */
	run: (ctx: CliContext) => Promise<number>;
	/** One-line summary shown in `ryu help`. */
	summary: string;
	/** Usage string shown in `ryu help` (e.g. `ryu add <id>`). */
	usage: string;
}

/** Thrown by a handler for a bad/missing argument. The dispatcher maps it to exit
 *  code 2 (usage error), distinct from a runtime failure (exit 1). */
export class UsageError extends LocalizedError {}
