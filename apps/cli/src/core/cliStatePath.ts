import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ryuHomeDir, statePath } from "@ryuhq/core-client/data-dir";

export interface CliStateEnvironment {
	readonly HOME?: string;
	readonly RYU_CLI_CONFIG_DIR?: string;
	readonly RYU_DIR?: string;
	readonly RYU_PROFILE?: string;
	readonly USERPROFILE?: string;
	readonly [key: string]: string | undefined;
}

type CliStateFile =
	| "nodes.json"
	| "cli-product-mode.json"
	| "prompt-history.json"
	| "cli-memory.json"
	| "cli-layout.json"
	| "agent-connect.json";

/** The user home, resolved like the Rust CLI (USERPROFILE, then HOME). */
export function cliUserHome(
	environment: CliStateEnvironment = process.env
): string {
	return environment.USERPROFILE || environment.HOME || homedir();
}

/**
 * The Ryu data dir, resolved exactly like Core:
 * `RYU_DIR` > Storage pointer > `~/.ryu<sfx>` (profile-aware).
 */
export function cliDataDir(
	environment: CliStateEnvironment = process.env
): string {
	return ryuHomeDir(environment, cliUserHome(environment));
}

/**
 * Where each CLI state file lives under the data dir: `nodes.json` is Core's
 * shared node registry (`state/nodes.json`, also read by Desktop); the rest are
 * the CLI's own state (`state/cli/<file>`).
 */
function defaultStatePath(
	file: CliStateFile,
	environment: CliStateEnvironment
): string {
	const root = cliDataDir(environment);
	return file === "nodes.json"
		? statePath(root, file)
		: statePath(root, "cli", file);
}

/**
 * Resolve a CLI state file. `RYU_CLI_CONFIG_DIR` is an explicit, flat override
 * root (tests and isolated sessions); otherwise the file lives in the data-dir
 * layout.
 */
export function cliStatePath(
	file: CliStateFile,
	environment: CliStateEnvironment = process.env
): string {
	const root = environment.RYU_CLI_CONFIG_DIR;
	if (root === undefined) {
		return defaultStatePath(file, environment);
	}
	if (!isAbsolute(root) || root.trim().length === 0 || root.includes("\0")) {
		throw new Error("RYU_CLI_CONFIG_DIR must be an absolute directory path.");
	}
	return join(root, file);
}
