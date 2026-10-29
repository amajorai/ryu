import { EN_MESSAGES } from "./en-messages.ts";
import { placeholderNames } from "./icu-syntax.ts";

export { placeholderNames } from "./icu-syntax.ts";

export const DEFAULT_LOCALE = "en" as const;
export const LANGUAGE_PACK_SCHEMA_VERSION = 1 as const;
export const LANGUAGE_PACK_ARTIFACT = "language-pack.json" as const;
export const LANGUAGE_PACK_STORAGE_KEY = "ryu:language-pack" as const;
export const LANGUAGE_PACKS_CHANGED_EVENT =
	"ryu:language-packs-changed" as const;
/** Maximum UTF-8 size of the portable language-pack artifact. */
export const MAX_LANGUAGE_PACK_BYTES = 4 * 1024 * 1024;
/** Maximum compressed size accepted by browser/native local archive import. */
export const MAX_LANGUAGE_PACK_ARCHIVE_BYTES = 8 * 1024 * 1024;

export type LanguageDirection = "ltr" | "rtl";

export interface LanguagePack {
	baseLocale: string;
	direction: LanguageDirection;
	/** Runtime lifecycle state; omitted from portable artifacts and built-in source. */
	enabled?: boolean;
	id: string;
	locale: string;
	messages: Record<string, string>;
	name: string;
	schemaVersion: typeof LANGUAGE_PACK_SCHEMA_VERSION;
	version: string;
}

export interface LanguagePackSummary {
	baseLocale: string;
	direction: LanguageDirection;
	locale: string;
	messageCount: number;
}

export function languagePackSummary(pack: LanguagePack): LanguagePackSummary {
	return {
		baseLocale: pack.baseLocale,
		direction: pack.direction,
		locale: pack.locale,
		messageCount: Object.keys(pack.messages).length,
	};
}

export interface LanguagePackValidationIssue {
	message: string;
	path: string;
}

export class LanguagePackValidationError extends Error {
	readonly issues: LanguagePackValidationIssue[];

	constructor(issues: LanguagePackValidationIssue[]) {
		super(
			issues.length === 1
				? `Invalid language pack: ${issues[0]?.message ?? "unknown error"}`
				: `Invalid language pack (${issues.length} errors)`
		);
		this.name = "LanguagePackValidationError";
		this.issues = issues;
	}
}

const ID_RE = /^[A-Za-z0-9@._/-]+$/;
const VERSION_RE = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const MAX_ID_LENGTH = 160;
const MAX_NAME_LENGTH = 120;
const MAX_MESSAGE_ID_LENGTH = 200;
export const MAX_MESSAGE_LENGTH = 32_000;
const MAX_MESSAGES = 20_000;

/** English source messages by id, shared by validation and translation. */
export const SOURCE_MESSAGES: ReadonlyMap<string, string> = new Map(
	Object.entries(EN_MESSAGES)
);

/**
 * Copy a non-array object's enumerable keys (own and inherited, as `for...in`
 * reports them), or return null for anything else. This is the data boundary
 * every pack payload crosses; reading the copy means a getter runs only once.
 */
function looseObjectCopy(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const copy: Record<string, unknown> = {};
	// Inherited enumerable keys are part of the accepted payload shape (as zod's
	// loose object read them), so this deliberately has no own-property guard.
	for (const key in value) {
		// Assigning `__proto__` to a plain object would replace its prototype.
		if (key !== "__proto__") {
			copy[key] = Reflect.get(value, key);
		}
	}
	return copy;
}

function hasControlCharacters(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (
			code <= 8 ||
			code === 11 ||
			code === 12 ||
			(code >= 14 && code <= 31) ||
			code === 127
		) {
			return true;
		}
	}
	return false;
}

function nonEmptyString(
	value: unknown,
	path: string,
	issues: LanguagePackValidationIssue[],
	maxLength: number
): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		issues.push({ path, message: "must be a non-empty string" });
		return "";
	}
	const trimmed = value.trim();
	if (trimmed.length > maxLength) {
		issues.push({ path, message: `must be at most ${maxLength} characters` });
	}
	if (hasControlCharacters(trimmed)) {
		issues.push({ path, message: "contains unsupported control characters" });
	}
	return trimmed;
}

function validateLocale(
	value: unknown,
	path: string,
	issues: LanguagePackValidationIssue[]
): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		issues.push({ path, message: "must be a BCP-47 locale" });
		return DEFAULT_LOCALE;
	}
	try {
		return Intl.getCanonicalLocales(value.trim())[0] ?? DEFAULT_LOCALE;
	} catch {
		issues.push({ path, message: "must be a valid BCP-47 locale" });
		return DEFAULT_LOCALE;
	}
}

function validateMessagePlaceholders(
	messages: Record<string, string>,
	issues: LanguagePackValidationIssue[]
): void {
	for (const [id, value] of Object.entries(messages)) {
		const source = SOURCE_MESSAGES.get(id);
		if (source === undefined) {
			continue;
		}
		const expected = placeholderNames(source);
		const actual = placeholderNames(value);
		if (JSON.stringify(expected) !== JSON.stringify(actual)) {
			issues.push({
				path: `messages.${id}`,
				message: `placeholders must match the source (${expected.join(", ") || "none"})`,
			});
		}
	}
}

function validateMessages(
	rawMessages: unknown,
	issues: LanguagePackValidationIssue[]
): Record<string, string> {
	const messages: Record<string, string> = {};
	const input = looseObjectCopy(rawMessages);
	if (!input) {
		issues.push({ path: "messages", message: "must be an object of strings" });
		return messages;
	}
	const entries = Object.entries(input);
	if (entries.length > MAX_MESSAGES) {
		issues.push({
			path: "messages",
			message: `must contain at most ${MAX_MESSAGES} entries`,
		});
	}
	for (const [messageId, rawMessage] of entries.slice(0, MAX_MESSAGES)) {
		if (
			messageId.length === 0 ||
			messageId.length > MAX_MESSAGE_ID_LENGTH ||
			messageId.startsWith("__")
		) {
			issues.push({
				path: `messages.${messageId}`,
				message: "has an invalid message id",
			});
			continue;
		}
		if (
			typeof rawMessage !== "string" ||
			rawMessage.length > MAX_MESSAGE_LENGTH
		) {
			issues.push({
				path: `messages.${messageId}`,
				message: `must be a string of at most ${MAX_MESSAGE_LENGTH} characters`,
			});
			continue;
		}
		if (hasControlCharacters(rawMessage)) {
			issues.push({
				path: `messages.${messageId}`,
				message: "contains unsupported control characters",
			});
			continue;
		}
		messages[messageId] = rawMessage;
	}
	validateMessagePlaceholders(messages, issues);
	return messages;
}

/** Validate a portable/community language-pack JSON payload at the data boundary. */
export function validateLanguagePack(value: unknown): LanguagePack {
	const issues: LanguagePackValidationIssue[] = [];
	const input = looseObjectCopy(value);
	if (!input) {
		throw new LanguagePackValidationError([
			{ path: "language-pack.json", message: "must contain a JSON object" },
		]);
	}
	if (input.schemaVersion !== LANGUAGE_PACK_SCHEMA_VERSION) {
		issues.push({
			path: "schemaVersion",
			message: `must be ${LANGUAGE_PACK_SCHEMA_VERSION}`,
		});
	}
	const id = nonEmptyString(input.id, "id", issues, MAX_ID_LENGTH);
	if (
		id &&
		(!ID_RE.test(id) ||
			id.includes("//") ||
			id.split("/").some((part) => part === "." || part === ".."))
	) {
		issues.push({ path: "id", message: "contains unsupported characters" });
	}
	const name = nonEmptyString(input.name, "name", issues, MAX_NAME_LENGTH);
	const locale = validateLocale(input.locale, "locale", issues);
	const baseLocale = validateLocale(input.baseLocale, "baseLocale", issues);
	const direction = input.direction;
	if (direction !== "ltr" && direction !== "rtl") {
		issues.push({ path: "direction", message: "must be ltr or rtl" });
	}
	const version = nonEmptyString(input.version, "version", issues, 128);
	if (version && !VERSION_RE.test(version)) {
		issues.push({ path: "version", message: "must be a semver-like version" });
	}
	const messages = validateMessages(input.messages, issues);
	if (issues.length > 0 || (direction !== "ltr" && direction !== "rtl")) {
		throw new LanguagePackValidationError(issues);
	}
	return {
		baseLocale,
		direction,
		id,
		locale,
		messages,
		name,
		schemaVersion: LANGUAGE_PACK_SCHEMA_VERSION,
		version,
	};
}

/**
 * The runtime entry for a first-party pack, in the exact shape (and key order)
 * `{ ...validateLanguagePack(pack), enabled }` produces. Built-in packs are
 * typed source checked once by `built-in-packs.test.ts`, so a runtime does not
 * re-validate every catalog message whenever its pack list changes.
 */
export function trustedBuiltInPack(pack: LanguagePack): LanguagePack {
	return {
		baseLocale: pack.baseLocale,
		direction: pack.direction,
		id: pack.id,
		locale: pack.locale,
		messages: { ...pack.messages },
		name: pack.name,
		schemaVersion: LANGUAGE_PACK_SCHEMA_VERSION,
		version: pack.version,
		enabled: pack.enabled !== false,
	};
}

/** Parse and validate the JSON artifact inside a portable package. */
export function parseLanguagePackJson(value: string): LanguagePack {
	if (new TextEncoder().encode(value).byteLength > MAX_LANGUAGE_PACK_BYTES) {
		throw new LanguagePackValidationError([
			{
				path: LANGUAGE_PACK_ARTIFACT,
				message: `must be at most ${MAX_LANGUAGE_PACK_BYTES} bytes`,
			},
		]);
	}
	try {
		return validateLanguagePack(JSON.parse(value));
	} catch (error) {
		if (error instanceof LanguagePackValidationError) {
			throw error;
		}
		throw new LanguagePackValidationError([
			{ path: LANGUAGE_PACK_ARTIFACT, message: "must contain valid JSON" },
		]);
	}
}

/** Serialize only the portable fields; runtime `enabled` state never travels. */
export function languagePackJson(pack: LanguagePack): string {
	const validated = validateLanguagePack(pack);
	const value = `${JSON.stringify(validated, null, 2)}\n`;
	if (new TextEncoder().encode(value).byteLength > MAX_LANGUAGE_PACK_BYTES) {
		throw new LanguagePackValidationError([
			{
				path: LANGUAGE_PACK_ARTIFACT,
				message: `must be at most ${MAX_LANGUAGE_PACK_BYTES} bytes`,
			},
		]);
	}
	return value;
}
