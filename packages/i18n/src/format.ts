import { findClosingBrace, parseOptions, splitTopLevel } from "./icu-syntax.ts";
import { DEFAULT_LOCALE, MAX_MESSAGE_LENGTH } from "./pack.ts";

// Structural ICU argument names; kept on this path for existing callers.
export { placeholderNames } from "./icu-syntax.ts";

/** Interpolation values as callers pass them; checked by {@link formatMessage}. */
export type MessageValuesInput = unknown;

type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };
type MessageValue = JsonValue | Date | bigint | undefined;
type MessageValues = Record<string, MessageValue>;

const INVALID = Symbol("invalid message value");
type Checked<T> = T | typeof INVALID;

/** A record of plain data: object literals and null-prototype objects only. */
function isPlainObject(value: unknown): value is object {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const ownerConstructor: unknown = Reflect.get(value, "constructor");
	if (typeof ownerConstructor !== "function") {
		return true;
	}
	const prototype: unknown = Reflect.get(ownerConstructor, "prototype");
	return (
		typeof prototype === "object" &&
		prototype !== null &&
		!Array.isArray(prototype) &&
		Object.hasOwn(prototype, "isPrototypeOf")
	);
}

/**
 * Copy a record's enumerable own string keys through `item`. A symbol key or
 * an invalid entry rejects the record; `__proto__` is skipped so it can never
 * replace the copy's prototype.
 */
function checkRecord<T>(
	value: object,
	item: (entry: unknown) => Checked<T>
): Checked<Record<string, T>> {
	const copy: Record<string, T> = {};
	for (const key of Reflect.ownKeys(value)) {
		if (
			key === "__proto__" ||
			!Object.prototype.propertyIsEnumerable.call(value, key)
		) {
			continue;
		}
		if (typeof key !== "string") {
			return INVALID;
		}
		const checked = item(Reflect.get(value, key));
		if (checked === INVALID) {
			return INVALID;
		}
		copy[key] = checked;
	}
	return copy;
}

function checkJson(value: unknown): Checked<JsonValue> {
	if (
		typeof value === "string" ||
		typeof value === "boolean" ||
		value === null ||
		(typeof value === "number" && Number.isFinite(value))
	) {
		return value;
	}
	if (Array.isArray(value)) {
		const copy: JsonValue[] = new Array(value.length);
		for (let index = 0; index < value.length; index += 1) {
			const checked = checkJson(value[index]);
			if (checked === INVALID) {
				return INVALID;
			}
			copy[index] = checked;
		}
		return copy;
	}
	return isPlainObject(value) ? checkRecord(value, checkJson) : INVALID;
}

function checkMessageValue(value: unknown): Checked<MessageValue> {
	const json = checkJson(value);
	if (json !== INVALID) {
		return json;
	}
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? INVALID : value;
	}
	return typeof value === "bigint" || value === undefined ? value : INVALID;
}

/**
 * Accept a plain record of JSON data, dates, bigints and `undefined`, copied so
 * formatting reads a stable snapshot. Any other shape is a caller bug and
 * throws, as it always has, rather than being stringified.
 */
function parseMessageValues(values: MessageValuesInput): MessageValues {
	const checked = isPlainObject(values)
		? checkRecord(values, checkMessageValue)
		: INVALID;
	if (checked === INVALID) {
		throw new TypeError(
			"Message values must be a plain record of JSON data, dates, bigints or undefined"
		);
	}
	return checked;
}

function formatValue(value: MessageValue): string {
	return value === null || value === undefined ? "" : String(value);
}

interface MessageFormatters {
	cardinal?: Intl.PluralRules;
	number?: Intl.NumberFormat;
	ordinal?: Intl.PluralRules;
}

// These objects depend only on locale and fixed formatting options. Keep user
// values/messages out of the cache and bound it for arbitrary locale inputs.
const MESSAGE_FORMATTER_LIMIT = 32;
const MESSAGE_FORMATTERS = new Map<string, MessageFormatters>();

function messageFormatters(locale: string): MessageFormatters {
	const existing = MESSAGE_FORMATTERS.get(locale);
	if (existing) {
		return existing;
	}
	if (MESSAGE_FORMATTERS.size >= MESSAGE_FORMATTER_LIMIT) {
		const oldest = MESSAGE_FORMATTERS.keys().next().value;
		if (oldest !== undefined) {
			MESSAGE_FORMATTERS.delete(oldest);
		}
	}
	const formatters: MessageFormatters = {};
	MESSAGE_FORMATTERS.set(locale, formatters);
	return formatters;
}

function formatMessageValue(
	message: string,
	values: MessageValues,
	locale: string,
	hashValue?: number
): string {
	let output = "";
	let cursor = 0;
	while (cursor < message.length) {
		const open = message.indexOf("{", cursor);
		const hash = hashValue === undefined ? -1 : message.indexOf("#", cursor);
		if (open < 0 && hash < 0) {
			output += message.slice(cursor);
			break;
		}
		const next = open < 0 ? hash : hash < 0 ? open : Math.min(open, hash);
		output += message.slice(cursor, next);
		if (next === hash) {
			const formatters = messageFormatters(locale);
			formatters.number ??= new Intl.NumberFormat(locale);
			output += formatters.number.format(hashValue ?? 0);
			cursor = next + 1;
			continue;
		}
		const close = findClosingBrace(message, open);
		if (close < 0) {
			output += message.slice(open);
			break;
		}
		const expression = message.slice(open + 1, close);
		const parts = splitTopLevel(expression, ",").map((part) => part.trim());
		const name = parts[0] ?? "";
		if (parts.length === 1) {
			output += formatValue(values[name]);
			cursor = close + 1;
			continue;
		}
		const kind = parts[1];
		const options = parseOptions(parts.slice(2).join(","));
		if (kind === "plural" || kind === "selectordinal") {
			const count = Number(values[name]);
			if (!Number.isFinite(count)) {
				output += message.slice(open, close + 1);
				cursor = close + 1;
				continue;
			}
			const exact = options.get(`=${count}`);
			const type = kind === "selectordinal" ? "ordinal" : "cardinal";
			const formatters = messageFormatters(locale);
			formatters[type] ??= new Intl.PluralRules(locale, { type });
			const category = formatters[type].select(count);
			const selected = exact ?? options.get(category) ?? options.get("other");
			output +=
				selected === undefined
					? message.slice(open, close + 1)
					: formatMessageValue(selected, values, locale, count);
		} else if (kind === "select") {
			const selected =
				options.get(formatValue(values[name])) ?? options.get("other");
			output +=
				selected === undefined
					? message.slice(open, close + 1)
					: formatMessageValue(selected, values, locale);
		} else {
			output += message.slice(open, close + 1);
		}
		cursor = close + 1;
	}
	return output;
}

// Preflight every branch, including unselected options, before the recursive
// formatter scans nested contents. These bounds cap both stack and parser work.
const MAX_MESSAGE_DEPTH = 32;
const MAX_MESSAGE_NODES = 1024;

function isBoundedMessage(message: string): boolean {
	if (message.length > MAX_MESSAGE_LENGTH) {
		return false;
	}
	let depth = 0;
	let nodes = 0;
	for (const character of message) {
		if (character === "{") {
			depth += 1;
			nodes += 1;
			if (depth > MAX_MESSAGE_DEPTH || nodes > MAX_MESSAGE_NODES) {
				return false;
			}
		} else if (character === "}") {
			depth = Math.max(0, depth - 1);
		}
	}
	return true;
}

/** Format a source/translated message using ICU-style interpolation and plurals. */
export function formatMessage(
	message: string,
	values: MessageValuesInput = {},
	locale: string = DEFAULT_LOCALE
): string {
	return isBoundedMessage(message)
		? formatMessageValue(message, parseMessageValues(values), locale)
		: message;
}
