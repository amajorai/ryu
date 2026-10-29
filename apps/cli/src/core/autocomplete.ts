import type { AgentSummary } from "@ryuhq/core-client/agents";
import type { MentionTargetUser } from "@ryuhq/core-client/notifications";
import type { AppInfo } from "@ryuhq/core-client/plugins";
import type { Workflow } from "@ryuhq/core-client/workflows";
import {
	COMMAND_PREFIX_RANK,
	commandCompletions,
	rankCommand,
	rankedCommandSpecs,
	resolveCommand,
} from "./commands.ts";
import type {
	AgentSlashCommand,
	ContributedSlashCommand,
	SlashCommandArgument,
} from "./contributions.ts";

export interface SlashCommandSuggestion {
	readonly body?: string;
	readonly description: string;
	readonly hint?: string;
	readonly kind: "command";
	readonly name: string;
	readonly source?: "agent";
}

export interface SlashArgumentContext {
	readonly argument: SlashCommandArgument;
	readonly argumentIndex: number;
	readonly commandName: string;
	readonly hasNextArgument: boolean;
	readonly kind: "slash-argument";
	readonly query: string;
	readonly start: number;
}

export interface SlashArgumentOptionSuggestion {
	readonly description?: string;
	readonly kind: "slash-argument-option";
	readonly label: string;
	readonly value: string;
}

export interface RetrySlashCommandsSuggestion {
	readonly kind: "retry-slash-commands";
}

export interface AgentSuggestion {
	readonly id: string;
	readonly kind: "agent";
	readonly name: string;
}

export interface WorkflowSuggestion {
	readonly id: string;
	readonly kind: "workflow";
	readonly name: string;
}

export interface HumanSuggestion {
	readonly id: string;
	readonly kind: "human";
	readonly name: string;
}

export interface AppPluginSuggestion {
	readonly id: string;
	readonly kind: "app" | "plugin";
	readonly name: string;
}

/** A path under the working directory; directories end with `/`. */
export interface FileSuggestion {
	readonly kind: "file";
	readonly path: string;
}

export type AutocompleteSuggestion =
	| SlashCommandSuggestion
	| FileSuggestion
	| SlashArgumentOptionSuggestion
	| RetrySlashCommandsSuggestion
	| AgentSuggestion
	| AppPluginSuggestion
	| HumanSuggestion
	| WorkflowSuggestion;

export interface AutocompleteContext {
	readonly kind: "slash" | "mention" | "file";
	readonly query: string;
	readonly start: number;
}

export type ComposerAutocompleteContext =
	| AutocompleteContext
	| SlashArgumentContext;

export interface AutocompleteState {
	readonly context: ComposerAutocompleteContext;
	readonly index: number;
	/** True while an async candidate load (mentions, files) is in flight. */
	readonly loading?: boolean;
	/** Replaces the empty state when completion is unavailable here. */
	readonly notice?: string;
	readonly suggestions: AutocompleteSuggestion[];
}

/** Rows the floating completion list shows before it scrolls. */
export const AUTOCOMPLETE_VISIBLE_ROWS = 10;

export { rankCommand } from "./commands.ts";

type MutableCommandSuggestion = {
	-readonly [Key in keyof SlashCommandSuggestion]: SlashCommandSuggestion[Key];
};
type MutableArgumentSuggestion = {
	-readonly [Key in keyof SlashArgumentOptionSuggestion]: SlashArgumentOptionSuggestion[Key];
};

/**
 * Compatibility view for existing chat surfaces. The registry owns command
 * metadata; aliases influence matching but do not create duplicate rows.
 */
export const LOCAL_SLASH_COMMANDS: SlashCommandSuggestion[] =
	commandCompletions("").map(({ description, name }) => ({
		description,
		kind: "command" as const,
		name,
	}));

export type SlashCommandCandidate = Pick<
	ContributedSlashCommand,
	"args" | "body" | "name"
>;

function findSlashArgumentContext(
	value: string,
	commands: readonly SlashCommandCandidate[]
): SlashArgumentContext | null {
	const match = /^\/(\S+)(?:\s+([\s\S]*))$/.exec(value);
	if (!match) {
		return null;
	}
	const commandName = match[1] ?? "";
	if (resolveCommand(commandName)) {
		return null;
	}
	const command = commands.find(
		(candidate) => candidate.name.toLowerCase() === commandName.toLowerCase()
	);
	if (!command || command.body) {
		return null;
	}
	const argumentText = match[2] ?? "";
	const hasTrailingWhitespace = /\s$/.test(argumentText);
	const tokens = argumentText.trim() ? argumentText.trim().split(/\s+/) : [];
	const argumentIndex = hasTrailingWhitespace
		? tokens.length
		: Math.max(tokens.length - 1, 0);
	const argument = command.args[argumentIndex];
	if (!argument || (argument.options.length === 0 && !argument.custom)) {
		return null;
	}
	const query = hasTrailingWhitespace ? "" : (tokens.at(-1) ?? "");
	const hasNextArgument = argumentIndex < command.args.length - 1;
	if (
		!(hasTrailingWhitespace || hasNextArgument) &&
		argument.options.some((option) => option.value === query)
	) {
		return null;
	}
	return {
		argument,
		argumentIndex,
		commandName: command.name,
		hasNextArgument,
		kind: "slash-argument",
		query,
		start: value.length - query.length,
	};
}

/**
 * `@path` tokens contain a `/` (`@src/`, `@./`, `@../lib/x`), which keeps
 * them apart from `@agent`, `@workflow` and `@person` mentions.
 */
const FILE_MENTION = /(?:^|\s)@((?:\.{0,2}\/)?[\w.-]*\/[\w./-]*)$/;

/** Return a completion context only when the command or current argument token is completeable. */
export function getAutocompleteContext(
	value: string,
	commands: readonly SlashCommandCandidate[] = []
): ComposerAutocompleteContext | null {
	const slashArgument = findSlashArgumentContext(value, commands);
	if (slashArgument) {
		return slashArgument;
	}
	const slash = value.match(/^\s*\/([\w-]*)$/);
	if (slash) {
		return {
			kind: "slash",
			query: slash[1] ?? "",
			start: value.length - slash[0].length + slash[0].indexOf("/"),
		};
	}
	const file = value.match(FILE_MENTION);
	if (file) {
		const query = file[1] ?? "";
		return { kind: "file", query, start: value.length - query.length - 1 };
	}
	const mention = value.match(/(?:^|\s)@([\w.-]*)$/);
	if (mention) {
		return {
			kind: "mention",
			query: mention[1] ?? "",
			start: value.length - (mention[1]?.length ?? 0) - 1,
		};
	}
	return null;
}

interface RankedSuggestion<T> {
	readonly item: T;
	readonly rank: number;
}

/**
 * Sort ranked candidates by tier. Fuzzy and description tiers only appear for
 * queries of two or more characters with no prefix hit, so a typed prefix
 * never gains noise rows. Ties keep the caller's canonical order (ACP
 * commands, then the curated built-in registry order, then plugins).
 */
function sortRanked<T>(query: string, ranked: RankedSuggestion<T>[]): T[] {
	const prefixHit = ranked.some(({ rank }) => rank <= COMMAND_PREFIX_RANK);
	const allowLoose = query.trim().length >= 2 && !prefixHit;
	return ranked
		.map((entry, order) => ({ ...entry, order }))
		.filter(({ rank }) => allowLoose || rank <= COMMAND_PREFIX_RANK)
		.sort((left, right) => left.rank - right.rank || left.order - right.order)
		.map(({ item }) => item);
}

/**
 * Rank built-in, ACP-advertised and plugin commands together. Built-ins
 * always win a name collision; the full ranked list is returned and the view
 * windows it.
 */
export function commandSuggestions(
	query: string,
	contributedCommands: readonly ContributedSlashCommand[] = [],
	agentCommands: readonly AgentSlashCommand[] = []
): SlashCommandSuggestion[] {
	const ranked: RankedSuggestion<SlashCommandSuggestion>[] = [];
	const seen = new Set<string>();
	const local = rankedCommandSpecs(query).map(
		({ rank, spec: { description, name } }) => {
			seen.add(name);
			return { item: { description, kind: "command" as const, name }, rank };
		}
	);
	for (const command of agentCommands) {
		const name = command.name.trim();
		const key = name.toLowerCase();
		const description = command.description || command.hint || "";
		const rank = rankCommand(query, name, [], description);
		if (!name || rank === null || seen.has(key) || resolveCommand(name)) {
			continue;
		}
		seen.add(key);
		ranked.push({
			item: { description, kind: "command", name, source: "agent" },
			rank,
		});
	}
	ranked.push(...local);
	for (const command of contributedCommands) {
		const name = command.name.trim();
		const key = name.toLowerCase();
		const rank = rankCommand(query, name, [], command.description);
		if (!name || rank === null || seen.has(key) || resolveCommand(name)) {
			continue;
		}
		seen.add(key);
		const suggestion: MutableCommandSuggestion = {
			description: command.description,
			kind: "command",
			name,
		};
		if (command.body) {
			suggestion.body = command.body;
		}
		if (command.hint) {
			suggestion.hint = command.hint;
		}
		ranked.push({ item: suggestion, rank });
	}
	return sortRanked(query, ranked);
}

/**
 * True when Enter should run a bare built-in command instead of completing
 * it: the selection is the exact local command typed, takes no arguments, and
 * is not an ACP, plugin or prompt-template command (those keep fill-on-Enter
 * so their arguments can be typed).
 */
export function runsOnEnter(
	value: string,
	suggestion: AutocompleteSuggestion | undefined
): boolean {
	if (
		suggestion?.kind !== "command" ||
		suggestion.source !== undefined ||
		suggestion.body !== undefined
	) {
		return false;
	}
	const spec = resolveCommand(suggestion.name);
	return (
		spec?.name === suggestion.name &&
		!spec.takesArguments &&
		value.trim().toLowerCase() === `/${spec.name}`
	);
}

/** Mention rank: exact, then prefix, then substring on any field; `null` = no match. */
function rankMention(query: string, fields: readonly string[]): number | null {
	const normalized = query.toLowerCase();
	const keys = fields.map((field) => field.toLowerCase());
	if (normalized.length > 0 && keys.includes(normalized)) {
		return 0;
	}
	if (keys.some((key) => key.startsWith(normalized))) {
		return 1;
	}
	return keys.some((key) => key.includes(normalized)) ? 2 : null;
}

/** Keep substring matches, ordered prefix-first; ties keep source order. */
function rankMentions<T>(
	items: readonly T[],
	query: string,
	fields: (item: T) => readonly string[]
): T[] {
	return items
		.flatMap((item, order) => {
			const rank = rankMention(query, fields(item));
			return rank === null ? [] : [{ item, order, rank }];
		})
		.sort((left, right) => left.rank - right.rank || left.order - right.order)
		.map(({ item }) => item);
}

/** Visible slice of a completion list that keeps `index` in view. */
export interface AutocompleteWindow {
	/** Rows hidden above the window. */
	readonly above: number;
	/** Rows hidden below the window. */
	readonly below: number;
	readonly end: number;
	readonly start: number;
}

/** How the floating list fits a height budget: list rows and whether the header line shows. */
export interface AutocompleteLayout {
	readonly header: boolean;
	readonly rows: number;
}

/** Border rows of the floating completion card. */
const AUTOCOMPLETE_BORDER_ROWS = 2;
/** Fewest list rows worth keeping the "Complete" header line for. */
const AUTOCOMPLETE_HEADER_MIN_ROWS = 3;

/**
 * Fit the completion list into `maxHeight` terminal rows (the space above the
 * composer). The card spends two rows on its border, one on the header and,
 * when the list scrolls, two on the "N more" indicators. Short terminals drop
 * the header before list rows; at least one list row always remains.
 */
export function autocompleteLayout(
	total: number,
	maxHeight: number,
	visibleRows: number = AUTOCOMPLETE_VISIBLE_ROWS
): AutocompleteLayout {
	const items = Math.max(1, total);
	const rowsWithin = (chrome: number): number => {
		const room = maxHeight - chrome;
		if (items <= Math.min(visibleRows, room)) {
			return items;
		}
		// Scrolling: reserve the ↑/↓ indicator rows.
		return Math.max(1, Math.min(visibleRows, room - 2));
	};
	const headerChrome = AUTOCOMPLETE_BORDER_ROWS + 1;
	const withHeader = rowsWithin(headerChrome);
	const indicators = withHeader < items ? 2 : 0;
	if (
		withHeader >= Math.min(items, AUTOCOMPLETE_HEADER_MIN_ROWS) &&
		headerChrome + withHeader + indicators <= maxHeight
	) {
		return { header: true, rows: withHeader };
	}
	return { header: false, rows: rowsWithin(AUTOCOMPLETE_BORDER_ROWS) };
}

export function autocompleteWindow(
	index: number,
	total: number,
	rows: number = AUTOCOMPLETE_VISIBLE_ROWS
): AutocompleteWindow {
	const size = Math.max(1, rows);
	const maxStart = Math.max(0, total - size);
	const start = Math.min(Math.max(0, index - size + 1), maxStart);
	const end = Math.min(total, start + size);
	return { above: start, below: total - end, end, start };
}

export function slashArgumentSuggestions(
	context: SlashArgumentContext
): SlashArgumentOptionSuggestion[] {
	const normalized = context.query.trim().toLowerCase();
	const options = context.argument.options.flatMap((option) => {
		if (
			!(
				option.value.toLowerCase().includes(normalized) ||
				option.label.toLowerCase().includes(normalized)
			)
		) {
			return [];
		}
		const suggestion: MutableArgumentSuggestion = {
			kind: "slash-argument-option",
			label: option.label,
			value: option.value,
		};
		const description = option.description ?? context.argument.description;
		if (description) {
			suggestion.description = description;
		}
		return [suggestion];
	});
	const customValue = context.query.trim();
	if (context.argument.custom && customValue) {
		options.push({
			description: context.argument.custom.description,
			kind: "slash-argument-option",
			label: `Use "${customValue}"`,
			value: customValue,
		});
	}
	return options;
}

export function agentSuggestions(
	agents: AgentSummary[],
	query: string
): AgentSuggestion[] {
	return rankMentions(agents, query, (agent) => [agent.id, agent.name]).map(
		(agent) => ({
			kind: "agent" as const,
			id: agent.id,
			name: agent.name,
		})
	);
}

/**
 * Match the Desktop chat directory's chat-input workflow subset. Core accepts
 * workflow chat turns only when an Input node is at the root of the graph.
 */
export function workflowSuggestions(
	workflows: Workflow[],
	query: string
): WorkflowSuggestion[] {
	const runnable = workflows.filter((workflow) => {
		const incoming = new Set(workflow.edges.map((edge) => edge.to));
		return workflow.nodes.some(
			(node) => node.type === "input" && !incoming.has(node.id)
		);
	});
	return rankMentions(runnable, query, (workflow) => [workflow.name]).map(
		({ id, name }) => ({ kind: "workflow" as const, id, name })
	);
}

/** Match the Inbox-gated human directory used by Desktop chat. */
export function humanSuggestions(
	users: MentionTargetUser[],
	query: string,
	currentUserId: string | null = null
): HumanSuggestion[] {
	return rankMentions(
		users.filter((user) => user.id !== currentUserId),
		query,
		(user) => (user.email ? [user.name, user.email] : [user.name])
	).map((user) => ({ kind: "human" as const, id: user.id, name: user.name }));
}

/** Match Desktop's enabled Apps and Plugins groups in the chat mention menu. */
export function appPluginSuggestions(
	apps: AppInfo[],
	query: string
): AppPluginSuggestion[] {
	return rankMentions(
		apps.filter((app) => app.enabled),
		query,
		(app) => [app.id, app.name]
	).map((app) => ({
		kind: app.companion ? ("app" as const) : ("plugin" as const),
		id: app.id,
		name: app.name,
	}));
}

/** Resolve a named workflow target using the same visible token as Desktop. */
export function resolveWorkflowMention(
	value: string,
	workflows: Workflow[]
): string | null {
	const normalized = value.toLowerCase();
	return (
		workflows.find((workflow) =>
			normalized.includes(`@${workflow.name.toLowerCase()}`)
		)?.id ?? null
	);
}

export function moveAutocompleteIndex(
	index: number,
	delta: -1 | 1,
	length: number
): number {
	if (length === 0) {
		return 0;
	}
	return Math.max(0, Math.min(length - 1, index + delta));
}

/** Replace only the active token, preserving any text before it. */
export function applyAutocomplete(
	value: string,
	context: ComposerAutocompleteContext,
	suggestion: AutocompleteSuggestion
): string {
	if (suggestion.kind === "retry-slash-commands") {
		return value;
	}
	if (suggestion.kind === "slash-argument-option") {
		if (context.kind !== "slash-argument") {
			return value;
		}
		const next = `${value.slice(0, context.start)}${suggestion.value}`;
		return context.hasNextArgument ? `${next} ` : next;
	}
	if (suggestion.kind === "file") {
		// Directories stay open so the next segment can be completed.
		const trailing = suggestion.path.endsWith("/") ? "" : " ";
		return `${value.slice(0, context.start)}@${suggestion.path}${trailing}`;
	}
	const replacement =
		suggestion.kind === "command"
			? (suggestion.body ?? `/${suggestion.name} `)
			: suggestion.kind === "human" ||
					suggestion.kind === "workflow" ||
					suggestion.kind === "app" ||
					suggestion.kind === "plugin"
				? `@${suggestion.name} `
				: `@${suggestion.id} `;
	return `${value.slice(0, context.start)}${replacement}`;
}

/** The three cells of one completion row: label, muted description, kind tag. */
export interface AutocompleteRow {
	readonly description: string;
	readonly key: string;
	readonly label: string;
	readonly tag: string;
}

function commandTag(suggestion: SlashCommandSuggestion): string {
	if (suggestion.source === "agent") {
		return "ACP";
	}
	if (suggestion.body !== undefined) {
		return "prompt";
	}
	return resolveCommand(suggestion.name)?.name === suggestion.name
		? "local"
		: "plugin";
}

/** Describe a suggestion as the cells the completion list renders. */
export function autocompleteRow(
	suggestion: AutocompleteSuggestion
): AutocompleteRow {
	switch (suggestion.kind) {
		case "command": {
			const tag = commandTag(suggestion);
			return {
				description: suggestion.description,
				key: `command:${tag}:${suggestion.name}`,
				label: `/${suggestion.name}`,
				tag,
			};
		}
		case "slash-argument-option":
			return {
				description:
					suggestion.label === suggestion.value
						? (suggestion.description ?? "")
						: suggestion.value,
				key: `argument:${suggestion.label}:${suggestion.value}`,
				label: suggestion.label,
				tag: "",
			};
		case "retry-slash-commands":
			return {
				description: "",
				key: suggestion.kind,
				label: "Retry contributed commands",
				tag: "",
			};
		case "file":
			return {
				description: "",
				key: `file:${suggestion.path}`,
				label: `@${suggestion.path}`,
				tag: suggestion.path.endsWith("/") ? "folder" : "file",
			};
		case "agent":
			return {
				description: suggestion.name,
				key: `agent:${suggestion.id}`,
				label: `@${suggestion.id}`,
				tag: "agent",
			};
		case "human":
			return {
				description: "",
				key: `human:${suggestion.id}`,
				label: `@${suggestion.name}`,
				tag: "person",
			};
		default:
			return {
				description: "",
				key: `${suggestion.kind}:${suggestion.id}`,
				label: `@${suggestion.name}`,
				tag: suggestion.kind,
			};
	}
}
