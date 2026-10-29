import { z } from "zod";

// Prompt Hub — the shared wire contract for versioned, labelled prompts.
//
// The control plane (`packages/api/src/routers/prompts.ts`), the Core local
// registry (`apps/core/src/prompt_registry.rs`), the SDK prompt client
// (`packages/sdk/src/prompts/`), and the desktop prompt library all speak this
// shape. A prompt is a named, organization-scoped registry entry; each commit
// creates an immutable numbered version; labels (`production`, `staging`, or
// custom) are movable pointers to one version each.
//
// Templates use a logic-less mustache subset: `{{name}}`, `{{{name}}}`,
// `{{& name}}`, dotted paths, sections `{{#name}}…{{/name}}`, inverted
// sections `{{^name}}…{{/name}}`, and comments `{{! … }}`. Every implementation
// (this file, the SDK compiler, and the Rust registry) is pinned to the golden
// cases in `fixtures/prompt-templates.json`.

/** Prompt names: URL-safe, case-sensitive, no path separators. */
export const PROMPT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
/** Label names: lowercase identifiers without dots (they are stored as map keys). `latest` is computed, never stored. */
export const PROMPT_LABEL_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
/** The computed label that always resolves to the highest version. */
export const LATEST_LABEL = "latest";
/** The label `get()` resolves when the caller names neither label nor version. */
export const DEFAULT_PROMPT_LABEL = "production";
/** Labels the UI offers first; any label matching the pattern is allowed. */
export const WELL_KNOWN_PROMPT_LABELS = ["production", "staging"] as const;

export const MAX_PROMPT_TEMPLATE_CHARS = 100_000;
export const MAX_PROMPT_MESSAGES = 100;
export const MAX_PROMPT_LABELS = 32;
export const MAX_PROMPT_TAGS = 20;
export const MAX_COMMIT_MESSAGE_CHARS = 500;
export const MAX_PROMPT_DESCRIPTION_CHARS = 2000;

export const PROMPT_TYPES = ["text", "chat"] as const;
export type PromptType = (typeof PROMPT_TYPES)[number];

export const PROMPT_MESSAGE_ROLES = [
	"system",
	"user",
	"assistant",
	"developer",
] as const;
export type PromptMessageRole = (typeof PROMPT_MESSAGE_ROLES)[number];

export function isPromptName(value: string): boolean {
	return PROMPT_NAME_RE.test(value);
}

/** Whether `value` may be stored as a label (`latest` is reserved). */
export function isAssignablePromptLabel(value: string): boolean {
	return value !== LATEST_LABEL && PROMPT_LABEL_RE.test(value);
}

// ── Schemas ─────────────────────────────────────────────────────────────────

export const promptChatMessageSchema = z.strictObject({
	role: z.enum(PROMPT_MESSAGE_ROLES),
	content: z.string().max(MAX_PROMPT_TEMPLATE_CHARS),
});

/** A slot a caller fills with a list of messages at compile time (history). */
export const promptPlaceholderSchema = z.strictObject({
	type: z.literal("placeholder"),
	name: z
		.string()
		.regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u, "invalid placeholder name"),
});

export const promptChatEntrySchema = z.union([
	promptChatMessageSchema,
	promptPlaceholderSchema,
]);
export type PromptChatMessage = z.infer<typeof promptChatMessageSchema>;
export type PromptPlaceholder = z.infer<typeof promptPlaceholderSchema>;
export type PromptChatEntry = z.infer<typeof promptChatEntrySchema>;

/** Model settings stored beside a version; every key is optional. */
export const promptModelConfigSchema = z.strictObject({
	model: z.string().trim().min(1).max(256).optional(),
	provider: z.string().trim().min(1).max(128).optional(),
	temperature: z.number().min(0).max(2).optional(),
	topP: z.number().min(0).max(1).optional(),
	maxTokens: z.number().int().min(1).max(10_000_000).optional(),
	stop: z.array(z.string().max(256)).max(16).optional(),
	seed: z.number().int().optional(),
});
export type PromptModelConfig = z.infer<typeof promptModelConfigSchema>;

const labelListSchema = z
	.array(
		z
			.string()
			.refine(isAssignablePromptLabel, "invalid or reserved prompt label")
	)
	.max(MAX_PROMPT_LABELS)
	.transform((labels) => [...new Set(labels)]);

/** The body of a commit: the content of one new immutable version. */
export const promptVersionInputSchema = z
	.strictObject({
		type: z.enum(PROMPT_TYPES),
		template: z.string().max(MAX_PROMPT_TEMPLATE_CHARS).optional(),
		messages: z
			.array(promptChatEntrySchema)
			.min(1)
			.max(MAX_PROMPT_MESSAGES)
			.optional(),
		modelConfig: promptModelConfigSchema.optional(),
		commitMessage: z.string().trim().max(MAX_COMMIT_MESSAGE_CHARS).optional(),
		labels: labelListSchema.optional(),
		/** Compare-and-set: refuse the commit unless this is the latest version. */
		expectedLatestVersion: z.number().int().min(0).optional(),
	})
	.superRefine((value, context) => {
		if (value.type === "text" && value.template === undefined) {
			context.addIssue({
				code: "custom",
				message: "a text prompt needs a template",
				path: ["template"],
			});
		}
		if (value.type === "text" && value.messages !== undefined) {
			context.addIssue({
				code: "custom",
				message: "a text prompt cannot carry messages",
				path: ["messages"],
			});
		}
		if (value.type === "chat" && value.messages === undefined) {
			context.addIssue({
				code: "custom",
				message: "a chat prompt needs messages",
				path: ["messages"],
			});
		}
		if (value.type === "chat" && value.template !== undefined) {
			context.addIssue({
				code: "custom",
				message: "a chat prompt cannot carry a template",
				path: ["template"],
			});
		}
		const templates =
			value.type === "text"
				? [value.template ?? ""]
				: (value.messages ?? []).flatMap((entry) =>
						"content" in entry ? [entry.content] : []
					);
		for (const [index, template] of templates.entries()) {
			const problem = templateSyntaxError(template);
			if (problem) {
				context.addIssue({
					code: "custom",
					message: problem,
					path:
						value.type === "text"
							? ["template"]
							: ["messages", index, "content"],
				});
			}
		}
	});
export type PromptVersionInput = z.infer<typeof promptVersionInputSchema>;

/** Creating a prompt commits its first version in the same request. */
export const promptCreateInputSchema = z
	.strictObject({
		name: z.string().regex(PROMPT_NAME_RE, "invalid prompt name"),
		description: z.string().trim().max(MAX_PROMPT_DESCRIPTION_CHARS).optional(),
		tags: z
			.array(z.string().trim().min(1).max(64))
			.max(MAX_PROMPT_TAGS)
			.optional(),
		version: promptVersionInputSchema,
	})
	.transform((value) => ({
		...value,
		tags: value.tags ? [...new Set(value.tags)] : [],
	}));
export type PromptCreateInput = z.infer<typeof promptCreateInputSchema>;

export const promptMetadataPatchSchema = z.strictObject({
	description: z
		.string()
		.trim()
		.max(MAX_PROMPT_DESCRIPTION_CHARS)
		.nullable()
		.optional(),
	tags: z
		.array(z.string().trim().min(1).max(64))
		.max(MAX_PROMPT_TAGS)
		.transform((tags) => [...new Set(tags)])
		.optional(),
});
export type PromptMetadataPatch = z.infer<typeof promptMetadataPatchSchema>;

export const promptLabelMoveSchema = z.strictObject({
	version: z.number().int().min(1),
});

/** One immutable version as every registry serves it. */
export interface PromptVersionWire {
	commitMessage: string | null;
	createdAt: string;
	createdBy: string | null;
	/** Labels that currently point at this version (including `latest`). */
	labels: string[];
	messages: PromptChatEntry[] | null;
	modelConfig: PromptModelConfig;
	name: string;
	/** Placeholder slots a chat prompt declares, in order. */
	placeholders: string[];
	template: string | null;
	type: PromptType;
	variables: string[];
	version: number;
}

/** One registry entry: metadata plus where each label points. */
export interface PromptSummaryWire {
	createdAt: string;
	description: string | null;
	labels: Record<string, number>;
	latestVersion: number;
	name: string;
	/** Where the entry came from: authored here or mirrored from the org. */
	source?: "local" | "cloud";
	tags: string[];
	type: PromptType;
	updatedAt: string;
}

/** Response-side parser for a served version (tolerates absent extras). */
export const promptVersionWireSchema = z.object({
	name: z.string(),
	version: z.number().int(),
	type: z.enum(PROMPT_TYPES),
	template: z.string().nullable(),
	messages: z.array(promptChatEntrySchema).nullable(),
	variables: z.array(z.string()),
	placeholders: z.array(z.string()).catch(() => []),
	modelConfig: promptModelConfigSchema.catch(() => ({})),
	commitMessage: z.string().nullable().catch(null),
	createdAt: z.string().catch(""),
	createdBy: z.string().nullable().catch(null),
	labels: z.array(z.string()).catch(() => []),
}) satisfies z.ZodType<PromptVersionWire>;

/** Response-side parser for a served registry entry. */
export const promptSummaryWireSchema = z.object({
	name: z.string(),
	description: z.string().nullable().catch(null),
	tags: z.array(z.string()).catch(() => []),
	type: z.enum(PROMPT_TYPES),
	latestVersion: z.number().int(),
	labels: z.record(z.string(), z.number().int()).catch(() => ({})),
	source: z.enum(["local", "cloud"]).optional(),
	createdAt: z.string().catch(""),
	updatedAt: z.string().catch(""),
}) satisfies z.ZodType<PromptSummaryWire>;

// ── Template analysis ───────────────────────────────────────────────────────

const PATH_RE =
	/^(?:\.|[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*)$/u;

export type TemplateToken =
	| { kind: "text"; value: string }
	| { kind: "var"; path: string }
	| { kind: "open"; path: string; inverted: boolean }
	| { kind: "close"; path: string };

/**
 * Tokenize a template. Throws `TemplateSyntaxError` on an unterminated tag, a
 * malformed name, or unbalanced sections.
 */
export function tokenizeTemplate(template: string): TemplateToken[] {
	const tokens: TemplateToken[] = [];
	const stack: string[] = [];
	let cursor = 0;
	while (cursor < template.length) {
		const open = template.indexOf("{{", cursor);
		if (open === -1) {
			tokens.push({ kind: "text", value: template.slice(cursor) });
			break;
		}
		if (open > cursor) {
			tokens.push({ kind: "text", value: template.slice(cursor, open) });
		}
		const triple = template.startsWith("{{{", open);
		const closer = triple ? "}}}" : "}}";
		const close = template.indexOf(closer, open + (triple ? 3 : 2));
		if (close === -1) {
			throw new TemplateSyntaxError(`unterminated tag at offset ${open}`);
		}
		const raw = template.slice(open + (triple ? 3 : 2), close).trim();
		cursor = close + closer.length;
		const sigil = triple ? "" : raw.charAt(0);
		if (sigil === "!") {
			continue;
		}
		const body = ["#", "^", "/", "&"].includes(sigil)
			? raw.slice(1).trim()
			: raw;
		if (!PATH_RE.test(body)) {
			throw new TemplateSyntaxError(
				`invalid tag name "${body}" at offset ${open}`
			);
		}
		if (sigil === "#" || sigil === "^") {
			stack.push(body);
			tokens.push({ kind: "open", path: body, inverted: sigil === "^" });
		} else if (sigil === "/") {
			const expected = stack.pop();
			if (expected !== body) {
				throw new TemplateSyntaxError(
					expected
						? `section "${expected}" closed by "${body}"`
						: `unopened section "${body}" closed`
				);
			}
			tokens.push({ kind: "close", path: body });
		} else {
			tokens.push({ kind: "var", path: body });
		}
	}
	const unclosed = stack.pop();
	if (unclosed !== undefined) {
		throw new TemplateSyntaxError(`section "${unclosed}" is never closed`);
	}
	return tokens;
}

export class TemplateSyntaxError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TemplateSyntaxError";
	}
}

/** The syntax error message for `template`, or null when it parses. */
export function templateSyntaxError(template: string): string | null {
	try {
		tokenizeTemplate(template);
		return null;
	} catch (error) {
		return error instanceof TemplateSyntaxError ? error.message : String(error);
	}
}

/**
 * Every name a template may read, in first-use order: the first path segment
 * of each variable and section tag (`.` excluded). A name inside a section may
 * resolve against the section's item rather than the root, so the list is the
 * set a caller can supply, not a set it must supply.
 */
export function templateVariables(template: string): string[] {
	const seen = new Set<string>();
	for (const token of tokenizeTemplate(template)) {
		if ((token.kind === "var" || token.kind === "open") && token.path !== ".") {
			seen.add(token.path.split(".")[0] ?? token.path);
		}
	}
	return [...seen];
}

/** Variables and placeholders of a whole version body. */
export function promptVersionVariables(input: {
	messages?: readonly PromptChatEntry[] | null;
	template?: string | null;
	type: PromptType;
}): { placeholders: string[]; variables: string[] } {
	if (input.type === "text") {
		return {
			placeholders: [],
			variables: templateVariables(input.template ?? ""),
		};
	}
	const variables = new Set<string>();
	const placeholders: string[] = [];
	for (const entry of input.messages ?? []) {
		if ("content" in entry) {
			for (const name of templateVariables(entry.content)) {
				variables.add(name);
			}
		} else if (!placeholders.includes(entry.name)) {
			placeholders.push(entry.name);
		}
	}
	return { placeholders, variables: [...variables] };
}

// ── Diff ────────────────────────────────────────────────────────────────────

export interface PromptDiffLine {
	op: "equal" | "add" | "remove";
	text: string;
}

export interface PromptVersionDiff {
	from: number;
	lines: PromptDiffLine[];
	modelConfig: Record<string, { from: unknown; to: unknown }>;
	to: number;
	typeChanged: boolean;
	variables: { added: string[]; removed: string[] };
}

/** The text a version diff compares: the template, or one block per message. */
export function promptVersionText(input: {
	messages?: readonly PromptChatEntry[] | null;
	template?: string | null;
	type: PromptType;
}): string {
	if (input.type === "text") {
		return input.template ?? "";
	}
	return (input.messages ?? [])
		.map((entry) =>
			"content" in entry
				? `[${entry.role}]\n${entry.content}`
				: `[placeholder: ${entry.name}]`
		)
		.join("\n\n");
}

/**
 * Largest LCS table (cells) `diffLines` builds. Templates may hold up to
 * `MAX_PROMPT_TEMPLATE_CHARS` characters, so two versions of one-character
 * lines would otherwise need a 10^10-cell table; past this bound the changed
 * middle is reported as a block replacement instead.
 */
export const MAX_DIFF_TABLE_CELLS = 4_000_000;

/**
 * Line diff by longest common subsequence. The common prefix and suffix are
 * matched first, and the LCS runs only on the changed middle while its table
 * stays under `MAX_DIFF_TABLE_CELLS`.
 */
export function diffLines(before: string, after: string): PromptDiffLine[] {
	const left = before.split("\n");
	const right = after.split("\n");
	let prefix = 0;
	while (
		prefix < left.length &&
		prefix < right.length &&
		left[prefix] === right[prefix]
	) {
		prefix += 1;
	}
	let suffix = 0;
	while (
		suffix < left.length - prefix &&
		suffix < right.length - prefix &&
		left.at(-1 - suffix) === right.at(-1 - suffix)
	) {
		suffix += 1;
	}
	const equal = (text: string): PromptDiffLine => ({ op: "equal", text });
	const out: PromptDiffLine[] = left.slice(0, prefix).map(equal);
	const middleLeft = left.slice(prefix, left.length - suffix);
	const middleRight = right.slice(prefix, right.length - suffix);
	if (
		(middleLeft.length + 1) * (middleRight.length + 1) >
		MAX_DIFF_TABLE_CELLS
	) {
		out.push(
			...middleLeft.map((text): PromptDiffLine => ({ op: "remove", text })),
			...middleRight.map((text): PromptDiffLine => ({ op: "add", text }))
		);
	} else {
		out.push(...lcsDiff(middleLeft, middleRight));
	}
	out.push(...left.slice(left.length - suffix).map(equal));
	return out;
}

function lcsDiff(left: string[], right: string[]): PromptDiffLine[] {
	const cols = right.length + 1;
	const table = new Uint32Array((left.length + 1) * cols);
	for (let i = left.length - 1; i >= 0; i -= 1) {
		for (let j = right.length - 1; j >= 0; j -= 1) {
			table[i * cols + j] =
				left[i] === right[j]
					? (table[(i + 1) * cols + j + 1] ?? 0) + 1
					: Math.max(
							table[(i + 1) * cols + j] ?? 0,
							table[i * cols + j + 1] ?? 0
						);
		}
	}
	const out: PromptDiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < left.length && j < right.length) {
		if (left[i] === right[j]) {
			out.push({ op: "equal", text: left[i] ?? "" });
			i += 1;
			j += 1;
		} else if (
			(table[(i + 1) * cols + j] ?? 0) >= (table[i * cols + j + 1] ?? 0)
		) {
			out.push({ op: "remove", text: left[i] ?? "" });
			i += 1;
		} else {
			out.push({ op: "add", text: right[j] ?? "" });
			j += 1;
		}
	}
	for (; i < left.length; i += 1) {
		out.push({ op: "remove", text: left[i] ?? "" });
	}
	for (; j < right.length; j += 1) {
		out.push({ op: "add", text: right[j] ?? "" });
	}
	return out;
}

/** Diff two versions of one prompt: body lines, variables, and model config. */
export function diffPromptVersions(
	from: Pick<
		PromptVersionWire,
		"messages" | "modelConfig" | "template" | "type" | "variables" | "version"
	>,
	to: Pick<
		PromptVersionWire,
		"messages" | "modelConfig" | "template" | "type" | "variables" | "version"
	>
): PromptVersionDiff {
	const modelConfig: PromptVersionDiff["modelConfig"] = {};
	const keys = new Set([
		...Object.keys(from.modelConfig),
		...Object.keys(to.modelConfig),
	]);
	for (const key of [...keys].sort()) {
		const before = (from.modelConfig as Record<string, unknown>)[key];
		const after = (to.modelConfig as Record<string, unknown>)[key];
		if (JSON.stringify(before) !== JSON.stringify(after)) {
			modelConfig[key] = { from: before ?? null, to: after ?? null };
		}
	}
	return {
		from: from.version,
		to: to.version,
		typeChanged: from.type !== to.type,
		lines: diffLines(promptVersionText(from), promptVersionText(to)),
		variables: {
			added: to.variables.filter((name) => !from.variables.includes(name)),
			removed: from.variables.filter((name) => !to.variables.includes(name)),
		},
		modelConfig,
	};
}
