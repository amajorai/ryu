// What the in-chat permission card shows for a call. Pure: no React, no i18n.
//
// A person approves what the card shows, so the rule lives here where a test
// can read it. For one of Ryu's own API calls Core sends the endpoint
// (`toolCall.i18n.detail`, "<METHOD> <path>") and the whole arguments
// (`rawInput`, the request body under `body`). For such a call the summary has:
//
// - `call`: rows the card always shows, in a fixed order that the arguments
//   cannot change: the endpoint, each path parameter, and for a route listed
//   below the fields that decide what the call does.
// - `details`: every other field, one row per field, behind "View details".
//
// Any other prompt keeps its rows in the order it sent them and gets
// `command`, the shell command the card prints in full. A prompt that carries
// an endpoint never gets that block: a top-level `command`, `cmd` or `script`
// is then the last of the always visible rows, so it cannot stand above the
// route's own rows and is never behind a click either. (The endpoint text
// arrives with the prompt, and an agent process could send one of its own.)
//
// The values under a key named `headers` or `env` are never shown; their names
// are. Control and text-direction characters are printed as escapes, so a
// value cannot draw a second row or reverse its own text.

export interface PermissionCallRow {
	id: string;
	label: string;
	value: string;
}

export interface PermissionCallSummary {
	/** Always visible, in a fixed order. Empty unless the call is a Ryu API call. */
	call: PermissionCallRow[];
	/** The shell command printed in full. Always `null` for a Ryu API call. */
	command: string | null;
	/** Every other field, one row each. */
	details: PermissionCallRow[];
}

type Arguments = Record<string, unknown>;

/** What stands in for a header or environment value. */
export const SECRET_MASK = "•••";
/** What stands in for a deciding field the call did not send. Not translated. */
export const NOT_SENT = "null";
/** The row that names the method and path; the card translates its label. */
export const ENDPOINT_ROW_ID = "endpoint";
export const MAX_CALL_VALUE_LENGTH = 2000;
export const MAX_DETAIL_VALUE_LENGTH = 200;
export const MAX_NAMES = 40;
export const MAX_DETAIL_ROWS = 40;

const ENDPOINT = /^(GET|POST|PUT|PATCH|DELETE) (\/\S*)$/u;
const PATH_PARAMETER = /\{([^{}/]+)\}/gu;
const PLAIN_ARGUMENT = /^[\w@%+=:,./-]+$/u;
const MCP_SERVER_ROUTE = "POST /api/mcp/servers";
const MCP_SERVER_FIELDS = [
	"name",
	"type",
	"command",
	"args",
	"url",
	"headers",
	"env",
];
const MCP_INSTALL_ROUTE = "POST /api/mcp/catalog/install";
const MCP_INSTALL_FIELDS = ["id", "force", "source"];
/** The routes with fixed rows, and the body fields those rows stand for. */
const ROUTE_FIELDS: Record<string, string[]> = {
	[MCP_SERVER_ROUTE]: MCP_SERVER_FIELDS,
	[MCP_INSTALL_ROUTE]: MCP_INSTALL_FIELDS,
};
const BODY_KEY = "body";
const COMMAND_KEYS = ["command", "cmd", "script"];
const SECRET_MAP_KEYS = new Set(["headers", "env"]);

function isRecord(value: unknown): value is Arguments {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSecretMapKey(key: string): boolean {
	return SECRET_MAP_KEYS.has(key.toLowerCase());
}

function isUnsafeCodePoint(code: number): boolean {
	return (
		code <= 0x1f ||
		(code >= 0x7f && code <= 0x9f) ||
		code === 0x06_1c ||
		(code >= 0x20_0b && code <= 0x20_0f) ||
		(code >= 0x20_28 && code <= 0x20_2e) ||
		(code >= 0x20_60 && code <= 0x20_69) ||
		code === 0xfe_ff
	);
}

/** `text` with control and text-direction characters as `\uXXXX` escapes. */
function printable(text: string): string {
	let out = "";
	for (const character of text) {
		const code = character.codePointAt(0) ?? 0;
		out += isUnsafeCodePoint(code)
			? `\\u${code.toString(16).padStart(4, "0")}`
			: character;
	}
	return out;
}

/** `text` made printable and capped, with the count of what was left out. */
function shown(text: string, max: number): string {
	const safe = printable(text);
	return safe.length > max
		? `${safe.slice(0, max)}… +${safe.length - max}`
		: safe;
}

function keysOf(value: Arguments, sorted: boolean): string[] {
	const keys = Object.keys(value);
	return sorted ? keys.sort() : keys;
}

/** A `headers` or `env` value with every value masked and the names kept. */
function maskedMap(value: unknown, sorted: boolean): unknown {
	if (value === null || value === undefined) {
		return value;
	}
	if (!isRecord(value)) {
		return SECRET_MASK;
	}
	return Object.fromEntries(
		keysOf(value, sorted).map((key) => [key, SECRET_MASK])
	);
}

/** `value` with header and env values masked at any depth. */
function masked(value: unknown, sorted: boolean): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => masked(item, sorted));
	}
	if (!isRecord(value)) {
		return value;
	}
	// `fromEntries` defines own properties, so a key such as `__proto__` is
	// printed like any other instead of vanishing from the card.
	return Object.fromEntries(
		keysOf(value, sorted).map((key) => [
			key,
			isSecretMapKey(key)
				? maskedMap(value[key], sorted)
				: masked(value[key], sorted),
		])
	);
}

function fieldText(key: string, value: unknown, sorted: boolean): string {
	const safe = isSecretMapKey(key)
		? maskedMap(value, sorted)
		: masked(value, sorted);
	if (typeof safe === "string") {
		return safe;
	}
	return safe === undefined ? "" : (JSON.stringify(safe) ?? "");
}

/** One argument as it would be typed: bare when plain, quoted otherwise. */
function quoted(value: unknown): string {
	const text = typeof value === "string" ? value : fieldText("", value, true);
	return PLAIN_ARGUMENT.test(text) ? text : JSON.stringify(text);
}

/** The command and its arguments as one line. */
function commandLine(command: unknown, args: unknown): string {
	const parts: string[] = [];
	if (command !== undefined && command !== null && command !== "") {
		parts.push(quoted(command));
	}
	if (Array.isArray(args)) {
		parts.push(...args.map(quoted));
	} else if (args !== undefined && args !== null) {
		parts.push(quoted(args));
	}
	return parts.join(" ");
}

/** The names in a `headers` or `env` map, sorted, never the values. */
function namesText(value: unknown): string {
	if (value === null || value === undefined) {
		return "";
	}
	if (!isRecord(value)) {
		return SECRET_MASK;
	}
	const names = Object.keys(value).sort();
	const listed = names.slice(0, MAX_NAMES).map(quoted);
	if (names.length > MAX_NAMES) {
		listed.push(`… +${names.length - MAX_NAMES}`);
	}
	return listed.join(", ");
}

function callRow(id: string, label: string, text: string): PermissionCallRow[] {
	return text === ""
		? []
		: [{ id, label, value: shown(text, MAX_CALL_VALUE_LENGTH) }];
}

/** The fields of `POST /api/mcp/servers` that decide what gets run or called. */
function mcpServerRows(body: unknown): PermissionCallRow[] {
	if (!isRecord(body)) {
		// Not the object the route expects: show it whole, not behind a click.
		return callRow(BODY_KEY, BODY_KEY, fieldText(BODY_KEY, body, true));
	}
	const hasCommand =
		body.command !== undefined && body.command !== null && body.command !== "";
	return [
		...callRow("body.name", "name", fieldText("name", body.name, true)),
		...callRow("body.type", "type", fieldText("type", body.type, true)),
		...callRow(
			"body.command",
			hasCommand ? "command" : "args",
			commandLine(body.command, body.args)
		),
		...callRow("body.url", "url", fieldText("url", body.url, true)),
		...callRow("body.headers", "headers", namesText(body.headers)),
		...callRow("body.env", "env", namesText(body.env)),
	];
}

/** `value`, or the marker when the call sent nothing a route could use. */
function sentOr(value: unknown, fallback: unknown): unknown {
	const blank = typeof value === "string" && value.trim() === "";
	return value === undefined || value === null || blank ? fallback : value;
}

/**
 * The fields of `POST /api/mcp/catalog/install` that decide what is installed.
 * All three rows are always there: the endpoint is the same for every install,
 * `force` replaces a server that exists, and without a `source` Core takes the
 * active one, which the card says by showing the row with the marker.
 */
function mcpInstallRows(body: unknown): PermissionCallRow[] {
	if (!isRecord(body)) {
		return callRow(BODY_KEY, BODY_KEY, fieldText(BODY_KEY, body, true));
	}
	return [
		...callRow(
			"body.id",
			"id",
			fieldText("id", sentOr(body.id, NOT_SENT), true)
		),
		...callRow(
			"body.force",
			"force",
			fieldText("force", sentOr(body.force, false), true)
		),
		...callRow(
			"body.source",
			"source",
			fieldText("source", sentOr(body.source, NOT_SENT), true)
		),
	];
}

function routeRows(endpoint: string, body: unknown): PermissionCallRow[] {
	if (endpoint === MCP_SERVER_ROUTE) {
		return mcpServerRows(body);
	}
	return endpoint === MCP_INSTALL_ROUTE ? mcpInstallRows(body) : [];
}

function pathParameters(path: string): string[] {
	return [
		...new Set(Array.from(path.matchAll(PATH_PARAMETER), (match) => match[1])),
	].filter((name): name is string => name !== undefined);
}

function compareLabels(a: PermissionCallRow, b: PermissionCallRow): number {
	if (a.label < b.label) {
		return -1;
	}
	return a.label > b.label ? 1 : 0;
}

interface DetailField {
	id: string;
	key: string;
	label: string;
	value: unknown;
}

/** A top-level argument as a field. Row ids carry a prefix, so no two collide. */
function argumentField([key, value]: [string, unknown]): DetailField {
	return { id: `arg.${key}`, key, label: key, value };
}

function detailRows(
	fields: DetailField[],
	sorted: boolean
): PermissionCallRow[] {
	const rows = fields
		.map(({ id, key, label, value }) => ({
			id,
			label,
			value: shown(fieldText(key, value, sorted), MAX_DETAIL_VALUE_LENGTH),
		}))
		.filter((row) => row.value !== "");
	if (sorted) {
		rows.sort(compareLabels);
	}
	if (rows.length <= MAX_DETAIL_ROWS) {
		return rows;
	}
	return [
		...rows.slice(0, MAX_DETAIL_ROWS),
		{ id: "more", label: "…", value: `+${rows.length - MAX_DETAIL_ROWS}` },
	];
}

/**
 * The command the card shows in full above everything else: the first
 * top-level `command`, `cmd` or `script` that is text.
 */
export function permissionCommand(
	rawInput: Arguments | undefined
): { key: string; value: string } | null {
	for (const key of COMMAND_KEYS) {
		const value = rawInput?.[key];
		if (typeof value === "string" && value.trim()) {
			return { key, value };
		}
	}
	return null;
}

function ryuCallSummary(
	endpoint: string,
	path: string,
	args: Arguments
): PermissionCallSummary {
	const parameters = pathParameters(path);
	const body = args[BODY_KEY];
	const fixed = ROUTE_FIELDS[endpoint];
	const known = fixed !== undefined;
	const flat = isRecord(body);
	// A top-level command, cmd or script is always visible, after the route's
	// own rows (a path parameter of that name has its row already).
	const commands = COMMAND_KEYS.filter((key) => !parameters.includes(key));
	const rest: DetailField[] = Object.entries(args)
		.filter(
			([key]) =>
				!(
					parameters.includes(key) ||
					commands.includes(key) ||
					(key === BODY_KEY && (flat || known))
				)
		)
		.map(argumentField);
	if (flat) {
		for (const [key, value] of Object.entries(body)) {
			if (!fixed?.includes(key)) {
				const label = `${BODY_KEY}.${key}`;
				rest.push({ id: label, key, label, value });
			}
		}
	}
	return {
		call: [
			...callRow(ENDPOINT_ROW_ID, ENDPOINT_ROW_ID, endpoint),
			...parameters.flatMap((name) =>
				callRow(`path.${name}`, name, fieldText(name, args[name], true))
			),
			...routeRows(endpoint, body),
			...commands.flatMap((key) =>
				callRow(`arg.${key}`, key, fieldText(key, args[key], true))
			),
		],
		command: null,
		details: detailRows(rest, true),
	};
}

/**
 * What the card shows for a call. `endpoint` is Core's "<METHOD> <path>" for
 * one of Ryu's own API calls and `null` for any other prompt, which keeps its
 * rows in the order it sent them and gets the same masking.
 */
export function summarizePermissionCall(
	endpoint: string | null,
	rawInput: Arguments | undefined
): PermissionCallSummary {
	const args = rawInput ?? {};
	const route = endpoint ? ENDPOINT.exec(endpoint.trim()) : null;
	if (route) {
		return ryuCallSummary(route[0], route[2] ?? "", args);
	}
	const command = permissionCommand(args);
	return {
		call: [],
		command: command?.value ?? null,
		details: detailRows(
			Object.entries(args)
				.filter(([key]) => key !== command?.key)
				.map(argumentField),
			false
		),
	};
}

/**
 * The choice that also covers later calls, when a Ryu API prompt offers one.
 * Such a grant is for the endpoint, whatever the arguments, so the card says
 * so beside the buttons.
 */
export function standingChoice<TOption extends { kind: string }>(
	summary: PermissionCallSummary,
	options: readonly TOption[]
): TOption | null {
	if (summary.call.length === 0) {
		return null;
	}
	return options.find((option) => option.kind === "allow_always") ?? null;
}
