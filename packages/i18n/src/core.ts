import { strToU8, unzipSync, zipSync } from "fflate";
import { BUILT_IN_LANGUAGE_PACKS, EN_MESSAGES } from "./messages.ts";

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

/** Stable fallback id used by shared UI primitives for literal labels that have
 * not yet been assigned a product-specific message id. The readable fallback is
 * still carried to `translate`, while the hash keeps translations independent of
 * component/file paths and safe to use as a language-pack key. */
export function literalMessageId(value: string): string {
	let hash = 2_166_136_261;
	for (const character of value) {
		hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 16_777_619);
	}
	const slug =
		value
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/gu, "-")
			.replace(/^-+|-+$/gu, "")
			.slice(0, 48) || "text";
	return `literal.${slug}.${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

const CORE_LITERAL_MESSAGE_IDS = new Map<string, string>();

/** Prefer a canonical catalog id for common labels, then fall back to a stable
 * literal id so shared primitives can localize legacy copy incrementally. */
export function messageIdForLiteral(value: string): string {
	const normalized = value.trim();
	const existing = CORE_LITERAL_MESSAGE_IDS.get(normalized);
	if (existing) {
		return existing;
	}
	const entry = Object.entries(EN_MESSAGES).find(
		([, message]) => message === normalized
	);
	const id = entry?.[0] ?? literalMessageId(normalized);
	CORE_LITERAL_MESSAGE_IDS.set(normalized, id);
	return id;
}

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
const MAX_MESSAGE_LENGTH = 32_000;
const MAX_MESSAGES = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

function placeholderNames(value: string): string[] {
	const names = new Set<string>();
	for (const match of value.matchAll(/\{([A-Za-z][A-Za-z0-9_.-]*)(?:[,}])/gu)) {
		const name = match[1];
		if (name) {
			names.add(name);
		}
	}
	return [...names].sort();
}

function validateMessagePlaceholders(
	messages: Record<string, string>,
	issues: LanguagePackValidationIssue[]
): void {
	for (const [id, value] of Object.entries(messages)) {
		const source = EN_MESSAGES[id as keyof typeof EN_MESSAGES];
		if (typeof source !== "string") {
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

/** Validate a portable/community language-pack JSON payload at the data boundary. */
export function validateLanguagePack(input: unknown): LanguagePack {
	const issues: LanguagePackValidationIssue[] = [];
	if (!isRecord(input)) {
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
	const rawMessages = input.messages;
	const messages: Record<string, string> = {};
	if (isRecord(rawMessages)) {
		const entries = Object.entries(rawMessages);
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
	} else {
		issues.push({ path: "messages", message: "must be an object of strings" });
	}
	if (issues.length > 0) {
		throw new LanguagePackValidationError(issues);
	}
	return {
		baseLocale,
		direction: direction as LanguageDirection,
		id,
		locale,
		messages,
		name,
		schemaVersion: LANGUAGE_PACK_SCHEMA_VERSION,
		version,
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
		return validateLanguagePack(JSON.parse(value) as unknown);
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

/** Build the portable-package envelope for a language pack without executable artifacts. */
export function languagePackPortableManifest(
	pack: LanguagePack,
	options: { metadata?: Record<string, unknown> } = {}
): Record<string, unknown> {
	const validated = validateLanguagePack(pack);
	return {
		artifacts: [LANGUAGE_PACK_ARTIFACT],
		capabilities: [],
		id: validated.id,
		kind: "language_pack",
		metadata: {
			...options.metadata,
			category: options.metadata?.category ?? "Language Packs",
			languagePack: languagePackSummary(validated),
		},
		name: validated.name,
		requires: {},
		schemaVersion: LANGUAGE_PACK_SCHEMA_VERSION,
		security: {
			containsSecrets: false,
			permissions: [],
			privateContent: false,
			redacted: false,
		},
		scopes: ["desktop"],
		targets: ["desktop", "web", "mobile", "extension", "island"],
		version: validated.version,
	};
}

/** Create a browser-safe deterministic `.ryupack` for download or local sharing. */
export function languagePackArchive(pack: LanguagePack): Uint8Array {
	const validated = validateLanguagePack(pack);
	const manifest = languagePackPortableManifest(validated);
	return zipSync(
		{
			"ryu.package.json": [
				strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
				{ mtime: new Date("1980-01-01T00:00:00.000Z") },
			],
			[LANGUAGE_PACK_ARTIFACT]: [
				strToU8(languagePackJson(validated)),
				{ mtime: new Date("1980-01-01T00:00:00.000Z") },
			],
		},
		{ level: 6, mtime: 0 }
	);
}

/** Parse the standard data-only `.ryupack` emitted by `languagePackArchive`. */
export function parseLanguagePackArchive(data: Uint8Array): LanguagePack {
	if (data.byteLength > MAX_LANGUAGE_PACK_ARCHIVE_BYTES) {
		throw new LanguagePackValidationError([
			{
				path: "archive",
				message: `must be at most ${MAX_LANGUAGE_PACK_ARCHIVE_BYTES} bytes`,
			},
		]);
	}
	let entryCount = 0;
	let uncompressedBytes = 0;
	const entries = unzipSync(data, {
		filter: (entry) => {
			entryCount += 1;
			uncompressedBytes += entry.originalSize;
			if (entryCount > 2) {
				throw new LanguagePackValidationError([
					{ path: "archive", message: "must contain only two files" },
				]);
			}
			if (entry.originalSize > MAX_LANGUAGE_PACK_BYTES) {
				throw new LanguagePackValidationError([
					{
						path: entry.name,
						message: `must be at most ${MAX_LANGUAGE_PACK_BYTES} bytes`,
					},
				]);
			}
			if (uncompressedBytes > MAX_LANGUAGE_PACK_ARCHIVE_BYTES) {
				throw new LanguagePackValidationError([
					{ path: "archive", message: "expands beyond the archive limit" },
				]);
			}
			if (
				entry.name !== "ryu.package.json" &&
				entry.name !== LANGUAGE_PACK_ARTIFACT
			) {
				throw new LanguagePackValidationError([
					{
						path: entry.name,
						message: "must not contain executable or unrelated files",
					},
				]);
			}
			return true;
		},
	});
	const artifact = entries[LANGUAGE_PACK_ARTIFACT];
	const manifest = entries["ryu.package.json"];
	if (!(artifact && manifest) || entryCount !== 2) {
		throw new LanguagePackValidationError([
			{
				path: "archive",
				message: "must contain ryu.package.json and language-pack.json",
			},
		]);
	}
	let manifestValue: unknown;
	try {
		manifestValue = JSON.parse(new TextDecoder().decode(manifest)) as unknown;
	} catch {
		throw new LanguagePackValidationError([
			{ path: "ryu.package.json", message: "must contain valid JSON" },
		]);
	}
	if (
		!isRecord(manifestValue) ||
		manifestValue.kind !== "language_pack" ||
		manifestValue.schemaVersion !== LANGUAGE_PACK_SCHEMA_VERSION ||
		!Array.isArray(manifestValue.artifacts) ||
		manifestValue.artifacts.length !== 1 ||
		manifestValue.artifacts[0] !== LANGUAGE_PACK_ARTIFACT ||
		!Array.isArray(manifestValue.capabilities) ||
		manifestValue.capabilities.length !== 0 ||
		!isRecord(manifestValue.security) ||
		!Array.isArray(manifestValue.security.permissions) ||
		manifestValue.security.permissions.length !== 0 ||
		manifestValue.security.containsSecrets === true ||
		manifestValue.security.privateContent === true
	) {
		throw new LanguagePackValidationError([
			{
				path: "ryu.package.json",
				message: "must describe a language_pack with language-pack.json only",
			},
		]);
	}
	const pack = parseLanguagePackJson(new TextDecoder().decode(artifact));
	if (manifestValue.id !== pack.id || manifestValue.version !== pack.version) {
		throw new LanguagePackValidationError([
			{
				path: "ryu.package.json",
				message: "id and version must match language-pack.json",
			},
		]);
	}
	return pack;
}

function findClosingBrace(value: string, start: number): number {
	let depth = 0;
	for (let index = start; index < value.length; index += 1) {
		if (value[index] === "{") {
			depth += 1;
		} else if (value[index] === "}") {
			depth -= 1;
			if (depth === 0) {
				return index;
			}
		}
	}
	return -1;
}

function splitTopLevel(value: string, separator: string): string[] {
	const parts: string[] = [];
	let start = 0;
	let depth = 0;
	for (let index = 0; index < value.length; index += 1) {
		if (value[index] === "{") {
			depth += 1;
		} else if (value[index] === "}") {
			depth = Math.max(0, depth - 1);
		} else if (value[index] === separator && depth === 0) {
			parts.push(value.slice(start, index));
			start = index + 1;
		}
	}
	parts.push(value.slice(start));
	return parts;
}

function parseOptions(value: string): Map<string, string> {
	const options = new Map<string, string>();
	let cursor = 0;
	while (cursor < value.length) {
		while (/\s/u.test(value[cursor] ?? "")) {
			cursor += 1;
		}
		const keyStart = cursor;
		while (cursor < value.length && !/[\s{]/u.test(value[cursor] ?? "")) {
			cursor += 1;
		}
		const key = value.slice(keyStart, cursor);
		while (/\s/u.test(value[cursor] ?? "")) {
			cursor += 1;
		}
		if (!key || value[cursor] !== "{") {
			break;
		}
		const close = findClosingBrace(value, cursor);
		if (close < 0) {
			break;
		}
		options.set(key, value.slice(cursor + 1, close));
		cursor = close + 1;
	}
	return options;
}

function formatValue(value: unknown): string {
	return value === null || value === undefined ? "" : String(value);
}

function formatMessageValue(
	message: string,
	values: Record<string, unknown>,
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
			output += new Intl.NumberFormat(locale).format(hashValue ?? 0);
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
			const category = new Intl.PluralRules(locale, {
				type: kind === "selectordinal" ? "ordinal" : "cardinal",
			}).select(count);
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

/** Format a source/translated message using ICU-style interpolation and plurals. */
export function formatMessage(
	message: string,
	values: Record<string, unknown> = {},
	locale: string = DEFAULT_LOCALE
): string {
	return formatMessageValue(message, values, locale);
}

function directionForLocale(locale: string): LanguageDirection {
	return /^(ar|fa|he|ur|ps|dv)(?:-|$)/iu.test(locale) ? "rtl" : "ltr";
}

function readStoredPackId(): string | null {
	try {
		return localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY);
	} catch {
		return null;
	}
}

function writeStoredPackId(value: string | null): void {
	try {
		if (value) {
			localStorage.setItem(LANGUAGE_PACK_STORAGE_KEY, value);
		} else {
			localStorage.removeItem(LANGUAGE_PACK_STORAGE_KEY);
		}
	} catch {
		// Private browsing and restricted webviews can deny storage. The in-memory
		// selection still works for the current session.
	}
}

export interface I18nRuntimeOptions {
	initialLocale?: string | null;
	initialPackId?: string | null;
	/** Optional persistence adapter for native hosts without localStorage. */
	persistPackId?: (id: string | null) => void | Promise<void>;
}

/** The small, serializable snapshot exposed to sandboxed apps and plugins. */
export interface I18nHostSnapshot {
	direction: LanguageDirection;
	locale: string;
	packId: string | null;
	packName: string | null;
	packVersion: string | null;
}

/** A translation request crossing an app/plugin host boundary. */
export interface I18nHostTranslateInput {
	defaultMessage: string;
	id: string;
	values?: Record<string, string | number | boolean | null>;
}

/** Shared runtime used by the website, desktop, and the browser-hosted webapp. */
export class I18nRuntime {
	private readonly listeners = new Set<() => void>();
	private packId: string | null;
	private packs: LanguagePack[];
	private readonly persistPackId?: I18nRuntimeOptions["persistPackId"];
	private readonly restoreStoredPackId: boolean;
	private localeOverride: string | null;
	private version = 0;

	constructor(
		packs: readonly LanguagePack[] = [],
		options: I18nRuntimeOptions = {}
	) {
		this.restoreStoredPackId = options.initialPackId === undefined;
		this.packId =
			options.initialPackId === undefined
				? readStoredPackId()
				: options.initialPackId;
		this.persistPackId = options.persistPackId;
		this.localeOverride = options.initialLocale
			? canonicalLocale(options.initialLocale, DEFAULT_LOCALE)
			: null;
		this.packs = [];
		this.setPacks(packs, false);
	}

	getVersion = (): number => this.version;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	private emit(): void {
		this.version += 1;
		for (const listener of this.listeners) {
			listener();
		}
	}

	setPacks(packs: readonly LanguagePack[], notify = true): void {
		const next = new Map<string, LanguagePack>();
		for (const pack of BUILT_IN_LANGUAGE_PACKS) {
			try {
				const validated = validateLanguagePack(pack);
				next.set(validated.id, {
					...validated,
					enabled: pack.enabled !== false,
				});
			} catch {
				// An invalid remote pack is isolated; the canonical catalog remains
				// usable and another installed pack can still load.
			}
		}
		for (const pack of packs) {
			// Built-in ids are reserved. A remote pack must not be able to shadow a
			// first-party voice and silently change the default fallback surface.
			if (next.has(pack.id)) {
				continue;
			}
			try {
				const validated = validateLanguagePack(pack);
				next.set(validated.id, {
					...validated,
					enabled: pack.enabled !== false,
				});
			} catch {
				// An invalid remote pack is isolated; the canonical catalog remains
				// usable and another installed pack can still load.
			}
		}
		this.packs = [...next.values()];
		if (this.packId === null && this.restoreStoredPackId) {
			this.packId = readStoredPackId();
		}
		if (notify) {
			this.emit();
		}
	}

	get availablePacks(): readonly LanguagePack[] {
		return this.packs;
	}

	get selectedPackId(): string | null {
		return this.packId;
	}

	get selectedPack(): LanguagePack | null {
		const pack = this.packs.find((candidate) => candidate.id === this.packId);
		return pack?.enabled === false ? null : (pack ?? null);
	}

	getSnapshot = (): I18nHostSnapshot => {
		const selected = this.selectedPack;
		return {
			direction: this.direction,
			locale: this.locale,
			packId: selected?.id ?? null,
			packName: selected?.name ?? null,
			packVersion: selected?.version ?? null,
		};
	};

	get locale(): string {
		return this.selectedPack?.locale ?? this.localeOverride ?? DEFAULT_LOCALE;
	}

	get direction(): LanguageDirection {
		return this.selectedPack?.direction ?? directionForLocale(this.locale);
	}

	selectPack(id: string | null): void {
		if (id !== null && !this.packs.some((pack) => pack.id === id)) {
			return;
		}
		this.packId = id;
		this.localeOverride = null;
		if (this.persistPackId) {
			void this.persistPackId(id);
		} else {
			writeStoredPackId(id);
		}
		this.emit();
	}

	setLocale(locale: string): void {
		const canonical = canonicalLocale(locale, DEFAULT_LOCALE);
		const pack = this.packs.find(
			(candidate) =>
				candidate.locale === canonical && candidate.enabled !== false
		);
		if (pack) {
			this.selectPack(pack.id);
			return;
		}
		this.packId = null;
		this.localeOverride = canonical;
		if (this.persistPackId) {
			void this.persistPackId(null);
		} else {
			writeStoredPackId(null);
		}
		this.emit();
	}

	translate(
		id: string,
		values: Record<string, unknown> = {},
		fallback?: string
	): string {
		const selected = this.selectedPack;
		const base =
			selected && selected.baseLocale !== DEFAULT_LOCALE
				? this.packs.find(
						(pack) =>
							pack.enabled !== false &&
							pack.locale === selected.baseLocale &&
							pack.id !== selected.id
					)
				: null;
		const source = EN_MESSAGES[id as keyof typeof EN_MESSAGES] ?? fallback;
		const candidateMessages = [
			selected?.messages[id],
			base?.messages[id],
			EN_MESSAGES[id as keyof typeof EN_MESSAGES],
			fallback,
		];
		const message =
			candidateMessages.find(
				(candidate) =>
					typeof candidate === "string" &&
					(!source ||
						JSON.stringify(placeholderNames(candidate)) ===
							JSON.stringify(placeholderNames(source)))
			) ?? id;
		return formatMessage(message, values, this.locale);
	}

	formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
		return new Intl.NumberFormat(this.locale, options).format(value);
	}

	formatDate(
		value: Date | number | string,
		options?: Intl.DateTimeFormatOptions
	): string {
		return new Intl.DateTimeFormat(this.locale, options).format(
			new Date(value)
		);
	}
}

function canonicalLocale(value: string, fallback: string): string {
	try {
		return Intl.getCanonicalLocales(value)[0] ?? fallback;
	} catch {
		return fallback;
	}
}
