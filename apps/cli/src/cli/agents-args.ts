import { UsageError } from "./types.ts";

export const USAGE = [
	"ryu-cli agents [list]",
	"ryu-cli agents show <id>",
	"ryu-cli agents create <name> [--identity managed|individual|mixed] [--engine <id>] [--model <id>]",
	"ryu-cli agents identity <id> [managed|individual|mixed|dismiss] [--engine <id>]",
	"ryu-cli agents access <id> [list | available | pick | add <key>… | remove <key>… | clear | none] [--engine <id>]",
].join("\n       ");
export const MODES_HINT =
	"managed (Acts as you), individual (Its own identity), mixed (Both)";

// ── Arguments ────────────────────────────────────────────────────────────────

/** Global flags the dispatcher already applied; skipped here (with their value). */
const GLOBAL_VALUE_FLAGS = new Set([
	"--agent",
	"--file",
	"-f",
	"--kind",
	"--node",
	"--template",
]);
const GLOBAL_BOOLEAN_FLAGS = new Set([
	"--json",
	"--force",
	"--cascade",
	"--dry-run",
	"--fix",
	"--include-secrets",
	"-h",
	"--help",
	"--version",
]);
type AgentsValueFlag = "engine" | "identity" | "model";
const AGENTS_VALUE_FLAGS = new Map<string, AgentsValueFlag>([
	["--engine", "engine"],
	["--identity", "identity"],
	["--model", "model"],
]);

export interface AgentsArgs {
	engine: string | null;
	identity: string | null;
	model: string | null;
	positional: string[];
}

/**
 * Parse the raw tokens after `agents`. The command's own value flags are read
 * here because the dispatcher would otherwise leave their values among the
 * positional args. An unknown flag is a usage error rather than ignored, so a
 * typo such as `--mode individual` can never be taken for something else.
 */
export function parseAgentsArgs(raw: readonly string[]): AgentsArgs {
	const parsed: AgentsArgs = {
		engine: null,
		identity: null,
		model: null,
		positional: [],
	};
	for (let i = 0; i < raw.length; i += 1) {
		const token = raw[i] ?? "";
		if (token === "--") {
			parsed.positional.push(...raw.slice(i + 1));
			break;
		}
		if (!token.startsWith("-") || token === "-") {
			parsed.positional.push(token);
			continue;
		}
		const eq = token.indexOf("=");
		const name = eq === -1 ? token : token.slice(0, eq);
		if (GLOBAL_BOOLEAN_FLAGS.has(name)) {
			continue;
		}
		if (GLOBAL_VALUE_FLAGS.has(name)) {
			if (eq === -1) {
				i += 1;
			}
			continue;
		}
		const key = AGENTS_VALUE_FLAGS.get(name);
		if (!key) {
			throw new UsageError(`Unknown option '${name}'.\nUsage: ${USAGE}`);
		}
		const value = eq === -1 ? raw[i + 1] : token.slice(eq + 1);
		if (eq === -1) {
			i += 1;
		}
		if (value === undefined || value.trim() === "") {
			throw new UsageError(`${name} needs a value.\nUsage: ${USAGE}`);
		}
		parsed[key] = value.trim();
	}
	return parsed;
}
