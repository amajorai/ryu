/**
 * Pure slash-command registry for the terminal chat surface.
 *
 * The registry deliberately stops at data and intent. React surfaces decide how
 * to fulfil a local action or render an overlay; pass-through commands return
 * their original slash text so Core remains the owner of those turn hooks.
 */

import { tf } from "../i18n/translate.ts";
import { COMMAND_SPECS } from "./commands-specs.ts";
import type {
	CommandDispatch,
	CommandExecutionMode,
	CommandName,
	CommandSpec,
	ParsedCommand,
} from "./commands-types.ts";

export { COMMAND_REGISTRY, COMMAND_SPECS } from "./commands-specs.ts";
export type {
	CommandAction,
	CommandCompletionKind,
	CommandDispatch,
	CommandExecutionMode,
	CommandHandler,
	CommandHandlerContext,
	CommandHandlerResult,
	CommandName,
	CommandOverlay,
	CommandSpec,
	LocalCommandAction,
	OverlayCommandAction,
	ParsedCommand,
	PassthroughCommandAction,
} from "./commands-types.ts";

const WHITESPACE = /\s+/;
const COMMAND_INPUT = /^\s*\/([\w-]+)(?:\s+([\s\S]*?))?\s*$/;

function normalizeCommandToken(value: string): string {
	const token = value.trim().toLowerCase();
	return token.startsWith("/") ? token.slice(1) : token;
}

/** Resolve a canonical command or alias. Leading slash and case are optional. */
export function resolveCommand(name: string): CommandSpec | undefined {
	const normalized = normalizeCommandToken(name);
	if (normalized.length === 0) {
		return undefined;
	}
	return COMMAND_SPECS.find(
		(spec) =>
			spec.name === normalized ||
			spec.aliases.some((alias) => alias === normalized)
	);
}

/** True only for an exact command advertised by an enabled plugin. Built-ins
 *  keep their local handlers, while arbitrary unknown slash text stays guarded. */
export function isContributedPluginCommand(
	value: string,
	commands: readonly { name: string; plugin: string }[]
): boolean {
	const match = /^\s*\/([\w-]+)(?:\s+([\s\S]*?))?\s*$/.exec(value);
	const invokedAs = match?.[1]?.toLowerCase();
	if (!invokedAs || resolveCommand(invokedAs)) {
		return false;
	}
	return commands.some(
		(command) =>
			command.plugin.length > 0 && command.name.toLowerCase() === invokedAs
	);
}

/** True only for a whole command advertised by the active ACP agent. These
 * commands are sent as chat text; they do not have a local TUI handler. */
export function isAdvertisedAgentCommand(
	value: string,
	commands: readonly { name: string }[]
): boolean {
	const match = /^\s*\/([\w-]+)(?:\s+([\s\S]*?))?\s*$/.exec(value);
	const invokedAs = match?.[1]?.toLowerCase();
	if (!invokedAs || resolveCommand(invokedAs)) {
		return false;
	}
	return commands.some((command) => command.name.toLowerCase() === invokedAs);
}

/** Parse a complete slash command, preserving unknown commands for warnings. */
export function parseCommand(value: string): ParsedCommand | null {
	const match = COMMAND_INPUT.exec(value);
	if (!match) {
		return null;
	}
	const invokedAs = (match[1] ?? "").toLowerCase();
	const argument = (match[2] ?? "").trim();
	const spec = resolveCommand(invokedAs);
	return {
		args: argument.length > 0 ? argument.split(WHITESPACE) : [],
		argument,
		canonicalName: spec?.name,
		invokedAs,
		raw: value.trim(),
		spec,
	};
}

/** Convert a complete slash command into a pure local/overlay/pass-through intent. */
export function dispatchCommand(value: string): CommandDispatch | null {
	const parsed = parseCommand(value);
	if (!parsed) {
		return null;
	}
	if (!parsed.spec) {
		return {
			invokedAs: parsed.invokedAs,
			kind: "unknown",
			message: tf("Unknown command: /{invokedAs}", {
				invokedAs: parsed.invokedAs,
			}),
			raw: parsed.raw,
		};
	}

	const result = parsed.spec.handler({
		argument: parsed.argument,
		args: parsed.args,
		invokedAs: parsed.invokedAs,
		raw: parsed.raw,
		spec: parsed.spec,
	});
	if (result.kind === "usage") {
		return {
			args: parsed.args,
			canonicalName: parsed.spec.name,
			invokedAs: parsed.invokedAs,
			kind: "usage",
			message: result.message,
			spec: parsed.spec,
			usage: parsed.spec.usage,
		};
	}
	return {
		action: result.action,
		args: parsed.args,
		canonicalName: parsed.spec.name,
		invokedAs: parsed.invokedAs,
		kind: "handled",
		mode: result.action.kind,
		spec: parsed.spec,
	};
}

/** Specs eligible for slash completion, matching canonical names and aliases. */
export function commandCompletions(query: string): CommandSpec[] {
	const normalized = query.trim().toLowerCase();
	return COMMAND_SPECS.filter(
		(spec) =>
			spec.completion === "command" &&
			(spec.name.startsWith(normalized) ||
				spec.aliases.some((alias) => alias.startsWith(normalized)))
	);
}

/** Rank tiers for {@link rankCommand}; lower is better. */
export const COMMAND_RANK = {
	exact: 0,
	namePrefix: 1,
	aliasPrefix: 2,
	fuzzy: 3,
	description: 4,
} as const;

/** The best tier that still counts as a typed-prefix hit. */
export const COMMAND_PREFIX_RANK = COMMAND_RANK.aliasPrefix;

/**
 * Greedy subsequence match cost: candidate characters skipped before the last
 * hit (a leading offset counts, so earlier matches win). `null` = no match.
 */
function subsequenceGaps(query: string, candidate: string): number | null {
	let position = -1;
	for (const character of query) {
		const next = candidate.indexOf(character, position + 1);
		if (next === -1) {
			return null;
		}
		position = next;
	}
	return position + 1 - query.length;
}

/**
 * Score one slash command against a query: exact name or alias, name prefix,
 * alias prefix, subsequence fuzzy on the name (plus a fractional gap penalty
 * that stays inside the tier), then a description substring. `null` means no
 * match. Matching is case-insensitive; an empty query is a prefix of everything.
 */
export function rankCommand(
	query: string,
	name: string,
	aliases: readonly string[],
	description: string
): number | null {
	const normalized = query.trim().toLowerCase();
	const key = name.toLowerCase();
	const aliasKeys = aliases.map((alias) => alias.toLowerCase());
	if (
		normalized.length > 0 &&
		(key === normalized || aliasKeys.includes(normalized))
	) {
		return COMMAND_RANK.exact;
	}
	if (key.startsWith(normalized)) {
		return COMMAND_RANK.namePrefix;
	}
	if (aliasKeys.some((alias) => alias.startsWith(normalized))) {
		return COMMAND_RANK.aliasPrefix;
	}
	const gaps = subsequenceGaps(normalized, key);
	if (gaps !== null) {
		return COMMAND_RANK.fuzzy + Math.min(gaps, 999) / 1000;
	}
	if (description.toLowerCase().includes(normalized)) {
		return COMMAND_RANK.description;
	}
	return null;
}

export interface RankedCommandSpec {
	readonly rank: number;
	readonly spec: CommandSpec;
}

/**
 * Completion-eligible specs scored with {@link rankCommand}, in registry order.
 * Callers combine these with agent and plugin commands before sorting, so the
 * fuzzy gate can see every candidate; {@link commandCompletions} stays the
 * plain prefix view used by help and other callers.
 */
export function rankedCommandSpecs(query: string): RankedCommandSpec[] {
	return COMMAND_SPECS.flatMap((spec) => {
		if (spec.completion !== "command") {
			return [];
		}
		const rank = rankCommand(query, spec.name, spec.aliases, spec.description);
		return rank === null ? [] : [{ rank, spec }];
	});
}

export interface CommandHelpRow {
	readonly aliases: readonly string[];
	readonly description: string;
	readonly mode: CommandExecutionMode;
	readonly name: CommandName;
	readonly usage: string;
}

/** Stable help rows derived from the registry. */
export function commandHelpRows(): CommandHelpRow[] {
	return COMMAND_SPECS.map(({ aliases, description, mode, name, usage }) => ({
		aliases,
		description,
		mode,
		name,
		usage,
	}));
}

/** Render the terminal slash-command help without depending on a UI component. */
export function renderCommandHelp(): string {
	const rows = commandHelpRows();
	const labels = rows.map((row) =>
		row.aliases.length > 0
			? `${row.usage} (${row.aliases.map((alias) => `/${alias}`).join(", ")})`
			: row.usage
	);
	const width = Math.max(...labels.map((label) => label.length));
	return [
		"Slash commands:",
		...rows.map(
			(row, index) =>
				`  ${labels[index]?.padEnd(width) ?? row.usage}  ${row.description}`
		),
	].join("\n");
}
