import { z } from "zod";

// RNP v0: explicit, consent-scoped conversation continuity between configured
// Ryu nodes. This module is deliberately pure. It validates and serializes the
// wire contract, but it never performs a network request or changes node state.

export const RNP_CONTINUITY_PROTOCOL = "ryu-node-continuity" as const;
export const RNP_CONTINUITY_VERSION = 0 as const;

export const RNP_CONTINUITY_LIMITS = {
	maxWireBytes: 2 * 1024 * 1024,
	maxMessages: 200,
	maxMessageBytes: 64 * 1024,
	maxTranscriptBytes: 1536 * 1024,
	maxContextItems: 16,
	maxContextItemBytes: 32 * 1024,
	maxContextBytes: 256 * 1024,
	maxIdBytes: 128,
	maxLabelBytes: 256,
	maxNodeUrlBytes: 2048,
} as const;

export type RnpTranscriptScopeV0 =
	| { mode: "all" }
	| { mode: "recent"; maxMessages: number };

export type RnpContextSourceV0 =
	| "browser-selection"
	| "clip-transcript"
	| "composer"
	| "manual"
	| "recent-activity"
	| "other";

export interface RnpContextTextV0 {
	id: string;
	kind: "text";
	label: string;
	mediaType: "text/markdown" | "text/plain";
	source: {
		kind: RnpContextSourceV0;
		label?: string;
	};
	text: string;
}

export interface RnpContextBundleV0 {
	items: RnpContextTextV0[];
	version: 0;
}

export interface RnpMessageV0 {
	createdAt: number;
	role: "assistant" | "user";
	sourceId: string;
	text: string;
}

export interface RnpContinuityBundleV0 {
	bundleId: string;
	context: RnpContextBundleV0;
	createdAt: number;
	messages: RnpMessageV0[];
	protocol: "ryu-node-continuity";
	selection: {
		transcript: RnpTranscriptScopeV0;
		omittedEarlierMessages: boolean;
	};
	source: {
		conversationId: string;
		updatedAt: number;
		checkpointMessageId?: string;
		title?: string;
		agentHint?: string;
	};
	version: 0;
}

export interface RnpExportRequestV0 {
	context?: RnpContextBundleV0;
	ifUpdatedAt?: number;
	includeAgentHint?: boolean;
	transcript: RnpTranscriptScopeV0;
	version: 0;
}

export interface RnpResumeResultV0 {
	conversationId: string;
	imported: {
		messages: number;
		contextItems: number;
	};
	status: "created" | "merged" | "unchanged";
	version: 0;
	warnings: Array<"agent-unavailable" | "earlier-messages-omitted">;
}

export type RnpParseErrorCode =
	| "invalid-json"
	| "unsupported-version"
	| "invalid-shape"
	| "limit-exceeded";

export type RnpParseResult<T> =
	| { ok: true; value: T }
	| {
			ok: false;
			error: {
				code: RnpParseErrorCode;
				path?: string;
				message: string;
			};
	  };

export interface RnpNodeCandidate {
	name: string;
	url: string;
}

export type RnpNodeResolution<T extends RnpNodeCandidate> =
	| { kind: "ready"; node: T }
	| { kind: "blocked"; reason: "node-not-configured" | "invalid-node-url" };

const HTTP_NODE_URL = /^(https?):\/\/([^/?#]+)(\/[^?#]*)?$/i;
const CONTEXT_SOURCES: RnpContextSourceV0[] = [
	"browser-selection",
	"clip-transcript",
	"composer",
	"manual",
	"recent-activity",
	"other",
];

function utf8Bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function hasControlCharacters(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (
			codePoint !== undefined &&
			(codePoint <= 31 || (codePoint >= 127 && codePoint <= 159))
		) {
			return true;
		}
	}
	return false;
}

function failure<T>(
	code: RnpParseErrorCode,
	message: string,
	path?: string
): RnpParseResult<T> {
	const error: Extract<RnpParseResult<T>, { ok: false }>["error"] = {
		code,
		message,
	};
	if (path) {
		error.path = path;
	}
	return { ok: false, error };
}

const containerSchema = z.custom<object>((value) => {
	const wrapped = new Object(value);
	return (
		wrapped === value &&
		!Array.isArray(value) &&
		!z.function().safeParse(value).success
	);
});
function rnpObject<T extends z.ZodRawShape>(fields: T, message: string) {
	return z.preprocess((value, context) => {
		const result = containerSchema.safeParse(value);
		if (!result.success) {
			context.addIssue({ code: "custom", message });
			return z.NEVER;
		}
		return Object.create(result.data);
	}, z.object(fields));
}
function boundedString(maxBytes: number, message: string, allowEmpty = false) {
	return z
		.string({ error: message })
		.refine(
			(value) =>
				(allowEmpty || value.trim().length > 0) &&
				!hasControlCharacters(value) &&
				utf8Bytes(value) <= maxBytes,
			{ error: message }
		);
}
function textBytes(maxBytes: number, message: string) {
	return z
		.string({ error: message })
		.refine((value) => utf8Bytes(value) <= maxBytes, { error: message });
}
function timestamp(message: string) {
	return z
		.number({ error: message })
		.int({ error: message })
		.min(0, { error: message });
}
const transcriptSchema = z.union(
	[
		rnpObject({ mode: z.literal("all") }, "Transcript selection is invalid"),
		rnpObject(
			{
				mode: z.literal("recent"),
				maxMessages: z
					.number()
					.int()
					.min(1)
					.max(RNP_CONTINUITY_LIMITS.maxMessages),
			},
			"Transcript selection is invalid"
		),
	],
	{ error: "Transcript selection is invalid" }
);
const contextSourceSchema = rnpObject(
	{
		kind: z.enum(CONTEXT_SOURCES, { error: "Unsupported context source" }),
		label: boundedString(
			RNP_CONTINUITY_LIMITS.maxLabelBytes,
			"Context source label is too long"
		).optional(),
	},
	"Unsupported context source"
).transform((value) => {
	const source: RnpContextTextV0["source"] = { kind: value.kind };
	if (value.label) {
		source.label = value.label;
	}
	return source;
});
const contextItemSchema = rnpObject(
	{
		kind: z.literal("text", { error: "Expected a text context item" }),
		id: boundedString(
			RNP_CONTINUITY_LIMITS.maxIdBytes,
			"Context id is missing or too long"
		),
		label: boundedString(
			RNP_CONTINUITY_LIMITS.maxLabelBytes,
			"Context label is missing or too long"
		),
		mediaType: z.enum(["text/plain", "text/markdown"], {
			error: "Unsupported context media type",
		}),
		text: textBytes(
			RNP_CONTINUITY_LIMITS.maxContextItemBytes,
			"Context text is too large"
		),
		source: contextSourceSchema,
	},
	"Expected a text context item"
).transform((value) => ({
	id: value.id,
	kind: value.kind,
	label: value.label,
	mediaType: value.mediaType,
	text: value.text,
	source: value.source,
}));
const messageSchema = rnpObject(
	{
		sourceId: boundedString(
			RNP_CONTINUITY_LIMITS.maxIdBytes,
			"Message id is missing or too long"
		).refine((value) => !value.startsWith("rnp-context-"), {
			error: "Message id uses the reserved context namespace",
		}),
		role: z.enum(["user", "assistant"], {
			error: "Only user and assistant text can move",
		}),
		text: textBytes(
			RNP_CONTINUITY_LIMITS.maxMessageBytes,
			"Message text is too large"
		),
		createdAt: timestamp("Message timestamp is invalid"),
	},
	"Expected a message object"
);
function orderedItems<S extends z.ZodType>(
	item: S,
	limits: {
		count: number;
		bytes: number;
		arrayMessage: string;
		countMessage: string;
		duplicateMessage: string;
		bytesMessage: string;
		idField: string;
	},
	identity: (value: z.output<S>) => string,
	bytes: (value: z.output<S>) => number
) {
	return z
		.custom<z.input<S>[]>((value) => Array.isArray(value), {
			error: limits.arrayMessage,
		})
		.superRefine((values, context) => {
			if (values.length > limits.count) {
				context.addIssue({ code: "custom", message: limits.countMessage });
			}
		})
		.transform((values, context) => {
			const items: z.output<S>[] = [];
			const ids = new Set<string>();
			let total = 0;
			for (const [index, value] of values.entries()) {
				const parsed = item.safeParse(value);
				if (!parsed.success) {
					for (const issue of parsed.error.issues) {
						context.addIssue({ ...issue, path: [index, ...issue.path] });
					}
					return z.NEVER;
				}
				const id = identity(parsed.data);
				if (ids.has(id)) {
					context.addIssue({
						code: "custom",
						message: limits.duplicateMessage,
						path: [index, limits.idField],
					});
					return z.NEVER;
				}
				ids.add(id);
				total += bytes(parsed.data);
				if (total > limits.bytes) {
					context.addIssue({ code: "custom", message: limits.bytesMessage });
					return z.NEVER;
				}
				items.push(parsed.data);
			}
			return items;
		});
}
const contextSchema = rnpObject(
	{
		version: z.literal(0, { error: "Invalid context bundle" }),
		items: orderedItems(
			contextItemSchema,
			{
				count: RNP_CONTINUITY_LIMITS.maxContextItems,
				bytes: RNP_CONTINUITY_LIMITS.maxContextBytes,
				arrayMessage: "Context items must be an array",
				countMessage: "Too many context items",
				duplicateMessage: "Context ids must be unique",
				bytesMessage: "Context bundle is too large",
				idField: "id",
			},
			(value) => value.id,
			(value) => utf8Bytes(value.text)
		),
	},
	"Invalid context bundle"
);
const sourceSchema = rnpObject(
	{
		conversationId: boundedString(
			RNP_CONTINUITY_LIMITS.maxIdBytes,
			"Conversation id is missing or too long"
		),
		updatedAt: timestamp("Source timestamp is invalid"),
		checkpointMessageId: boundedString(
			RNP_CONTINUITY_LIMITS.maxIdBytes,
			"Source checkpointMessageId is invalid"
		).optional(),
		agentHint: boundedString(
			RNP_CONTINUITY_LIMITS.maxIdBytes,
			"Source agentHint is invalid"
		).optional(),
		title: boundedString(
			RNP_CONTINUITY_LIMITS.maxLabelBytes,
			"Source title is too long"
		).optional(),
	},
	"Bundle source is missing"
).transform((value) => {
	const source: RnpContinuityBundleV0["source"] = {
		conversationId: value.conversationId,
		updatedAt: value.updatedAt,
	};
	if (value.checkpointMessageId !== undefined) {
		source.checkpointMessageId = value.checkpointMessageId;
	}
	if (value.title) {
		source.title = value.title;
	}
	if (value.agentHint !== undefined) {
		source.agentHint = value.agentHint;
	}
	return source;
});
const bundleSchema = rnpObject(
	{
		protocol: z.literal(RNP_CONTINUITY_PROTOCOL, {
			error: "Unsupported continuity protocol",
		}),
		version: z.literal(0, { error: "Unsupported continuity version" }),
		bundleId: boundedString(
			RNP_CONTINUITY_LIMITS.maxIdBytes,
			"Bundle id is missing or too long"
		),
		createdAt: timestamp("Bundle timestamp is invalid"),
		source: sourceSchema,
		selection: rnpObject(
			{
				transcript: transcriptSchema,
				omittedEarlierMessages: z.boolean({
					error: "Transcript selection is invalid",
				}),
			},
			"Selection is missing"
		),
		messages: orderedItems(
			messageSchema,
			{
				count: RNP_CONTINUITY_LIMITS.maxMessages,
				bytes: RNP_CONTINUITY_LIMITS.maxTranscriptBytes,
				arrayMessage: "Messages must be an array",
				countMessage: "Too many messages",
				duplicateMessage: "Message ids must be unique",
				bytesMessage: "Transcript is too large",
				idField: "sourceId",
			},
			(value) => value.sourceId,
			(value) => utf8Bytes(value.text)
		),
		context: contextSchema,
	},
	"Unsupported continuity protocol"
);
const limitMessages = new Set([
	"Context id is missing or too long",
	"Context label is missing or too long",
	"Context text is too large",
	"Context source label is too long",
	"Too many context items",
	"Context bundle is too large",
	"Message id is missing or too long",
	"Message text is too large",
	"Bundle id is missing or too long",
	"Conversation id is missing or too long",
	"Source checkpointMessageId is invalid",
	"Source agentHint is invalid",
	"Source title is too long",
	"Too many messages",
	"Transcript is too large",
]);
function issuePath(issue: z.core.$ZodIssue, prefix = "") {
	if (issue.message === "Unsupported continuity protocol") {
		return "protocol";
	}
	if (issue.message === "Unsupported continuity version") {
		return "version";
	}
	if (issue.message === "Invalid context bundle") {
		return "context";
	}
	if (issue.message === "Transcript selection is invalid") {
		return "selection";
	}
	let path = prefix;
	for (const part of issue.path) {
		path += Number.isInteger(part)
			? `[${String(part)}]`
			: `${path ? "." : ""}${String(part)}`;
	}
	if (
		issue.message === "Expected a text context item" &&
		path.endsWith(".kind")
	) {
		path = path.slice(0, -5);
	}
	if (
		issue.message === "Unsupported context source" &&
		!path.endsWith(".kind")
	) {
		path += ".kind";
	}
	return path;
}
function failedIssue<T>(
	issue: z.core.$ZodIssue,
	prefix = ""
): RnpParseResult<T> {
	const code =
		issue.message === "Unsupported continuity version"
			? "unsupported-version"
			: limitMessages.has(issue.message)
				? "limit-exceeded"
				: "invalid-shape";
	return failure(code, issue.message, issuePath(issue, prefix));
}
export function parseRnpContinuityBundle(
	input: Parameters<typeof bundleSchema.parse>[0]
): RnpParseResult<RnpContinuityBundleV0> {
	const text = z.string().safeParse(input);
	let decoded = input;
	if (text.success) {
		if (utf8Bytes(text.data) > RNP_CONTINUITY_LIMITS.maxWireBytes) {
			return failure(
				"limit-exceeded",
				"Continuity bundle exceeds the wire limit"
			);
		}
		try {
			decoded = JSON.parse(text.data);
		} catch {
			return failure("invalid-json", "Continuity bundle is not valid JSON");
		}
	}
	const parsed = bundleSchema.safeParse(decoded);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		if (!issue) {
			throw new Error("Missing continuity validation issue");
		}
		return failedIssue(issue);
	}
	const encoded = JSON.stringify(parsed.data);
	if (utf8Bytes(encoded) > RNP_CONTINUITY_LIMITS.maxWireBytes) {
		return failure(
			"limit-exceeded",
			"Continuity bundle exceeds the wire limit"
		);
	}
	return { ok: true, value: parsed.data };
}
export function createRnpContextBundle(input: {
	items: RnpContextTextV0[];
}): RnpContextBundleV0 {
	const parsed = contextSchema.safeParse({ version: 0, items: input.items });
	if (!parsed.success) {
		throw new Error(
			parsed.error.issues[0]?.message ?? "Invalid context bundle"
		);
	}
	return parsed.data;
}

export function serializeRnpContinuityBundle(
	bundle: RnpContinuityBundleV0
): string {
	const parsed = parseRnpContinuityBundle(bundle);
	if (!parsed.ok) {
		throw new Error(parsed.error.message);
	}
	return JSON.stringify(parsed.value);
}

/** Normalize a node URL carried as routing metadata. It is never a credential. */
export function normalizeRnpNodeUrl(raw: string): string | null {
	const value = raw.trim();
	if (
		!boundedString(
			RNP_CONTINUITY_LIMITS.maxNodeUrlBytes,
			"Invalid node URL"
		).safeParse(value).success ||
		value.includes("?") ||
		value.includes("#")
	) {
		return null;
	}
	const match = HTTP_NODE_URL.exec(value);
	if (!match) {
		return null;
	}
	const authority = match[2];
	if (!authority || authority.includes("@")) {
		return null;
	}
	const closingBracket = authority.indexOf("]");
	if (authority.startsWith("[") && closingBracket <= 1) {
		return null;
	}
	const hostname = authority.startsWith("[")
		? authority.slice(1, closingBracket)
		: authority.split(":")[0];
	const loopback =
		hostname === "localhost" ||
		hostname?.endsWith(".localhost") ||
		hostname === "::1" ||
		hostname?.startsWith("127.");
	if (match[1]?.toLowerCase() === "http" && !loopback) {
		return null;
	}
	return value.replace(/\/+$/, "");
}

/** Resolve routing metadata only against nodes the user already configured. */
export function resolveRnpNode<T extends RnpNodeCandidate>(
	rawUrl: string,
	configuredNodes: readonly T[]
): RnpNodeResolution<T> {
	const normalized = normalizeRnpNodeUrl(rawUrl);
	if (!normalized) {
		return { kind: "blocked", reason: "invalid-node-url" };
	}
	const node = configuredNodes.find(
		(candidate) => normalizeRnpNodeUrl(candidate.url) === normalized
	);
	return node
		? { kind: "ready", node }
		: { kind: "blocked", reason: "node-not-configured" };
}

// ── RNP v0 working-tree handoff ──────────────────────────────────────────────
// A separate, capability-probed contract. The v0 transcript bundle above is not
// extended: neither side rejects unknown fields, so an old destination would
// drop a `workspace` field silently and still answer `created`.

export const RNP_WORKSPACE_FEATURE = "workspace" as const;

export const RNP_WORKSPACE_LIMITS = {
	bundleBytes: 32 * 1024 * 1024,
	diffBytes: 8 * 1024 * 1024,
	untrackedCount: 256,
	untrackedFileBytes: 1024 * 1024,
	untrackedTotalBytes: 4 * 1024 * 1024,
	manifestPaths: 2000,
	pathBytes: 4096,
	manifestJsonBytes: 256 * 1024,
	maxCommitCount: 100_000,
} as const;

export type RnpBlobMediaTypeV0 = "application/x-git-bundle" | "text/x-diff";

export interface RnpBlobRefV0 {
	bytes: number;
	mediaType: RnpBlobMediaTypeV0;
	sha256: string;
}

export interface RnpWorkspaceFileV0 {
	binary: boolean;
	bytes?: number;
	path: string;
	sensitive: boolean;
	status: "added" | "deleted" | "modified" | "renamed";
}

export type RnpWorkspaceOmissionReasonV0 =
	| "ignored"
	| "not-a-git-repository"
	| "not-selected"
	| "submodule"
	| "symlink"
	| "too-large"
	| "unsafe-path";

export interface RnpWorkspaceOmissionV0 {
	path: string;
	reason: RnpWorkspaceOmissionReasonV0;
}

export interface RnpWorkspaceRepoV0 {
	/** The source HEAD; the destination worktree starts here. */
	baseCommit: string;
	branch?: string;
	name: string;
	/** Credential-free HTTPS or `git@` SSH URL; absent for local-only repos. */
	remoteUrl?: string;
	upstreamRef?: string;
}

export interface RnpWorkspaceManifestV0 {
	commits?: {
		blob: RnpBlobRefV0;
		count: number;
		prerequisites: string[];
		tip: string;
	};
	conversationId: string;
	createdAt: number;
	diff?: {
		blob: RnpBlobRefV0;
		files: RnpWorkspaceFileV0[];
	};
	omitted: RnpWorkspaceOmissionV0[];
	repo: RnpWorkspaceRepoV0;
	/** Selected untracked files; each also appears in `diff.files`. */
	untracked: RnpWorkspaceFileV0[];
	version: 0;
	workspaceId: string;
}

export interface RnpWorkspaceUntrackedCandidateV0 {
	bytes: number;
	path: string;
	reason?: RnpWorkspaceOmissionReasonV0;
	selectable: boolean;
	sensitive: boolean;
}

export interface RnpWorkspaceInspectionV0 {
	changed: RnpWorkspaceFileV0[];
	conversationId: string;
	diffStat: { files: number; insertions: number; deletions: number };
	repo: RnpWorkspaceRepoV0;
	unpushedCommits: number;
	untrackedCandidates: RnpWorkspaceUntrackedCandidateV0[];
	version: 0;
}

export interface RnpWorkspaceExportRequestV0 {
	ifHead: string;
	ifUpdatedAt?: number;
	includeUntracked: string[];
	version: 0;
}

export type RnpWorkspaceDestinationV0 =
	| { mode: "new-clone"; folderName?: string }
	| { mode: "existing-checkout"; checkoutPath: string };

export interface RnpWorkspaceResumeRequestV0 {
	destination: RnpWorkspaceDestinationV0;
	manifest: RnpWorkspaceManifestV0;
	version: 0;
}

export interface RnpWorkspaceResumeResultV0 {
	branch: string;
	conversationId: string;
	folderPath: string;
	status: "created" | "unchanged";
	version: 0;
	warnings: "workspace-untrusted"[];
	workspaceId: string;
	worktreePath: string;
}

export interface RnpCapabilitiesV0 {
	features: string[];
	version: 0;
}

export interface RnpContinuedOnV0 {
	at: number;
	bundleId?: string;
	nodeLabel: string;
	workspaceId?: string;
}

const WINDOWS_DRIVE = /^[A-Za-z]:/;
const HEX_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const LIMIT_MESSAGE = /too large|Too many|too long|exceeds/;

/**
 * A path from another machine is accepted only as a plain, `/`-separated,
 * repo-relative path that cannot reach outside the worktree or into `.git`
 * on any platform. Mirrored by `is_safe_repo_relative_path` in Rust.
 */
export function isSafeRepoRelativePath(path: string): boolean {
	if (
		path.length === 0 ||
		utf8Bytes(path) > RNP_WORKSPACE_LIMITS.pathBytes ||
		path.startsWith("/") ||
		path.includes("\\") ||
		WINDOWS_DRIVE.test(path) ||
		hasControlCharacters(path)
	) {
		return false;
	}
	return path.split("/").every((segment) => {
		const lower = segment.toLowerCase();
		return (
			segment.length > 0 &&
			segment !== "." &&
			segment !== ".." &&
			lower !== ".git" &&
			lower !== "git~1" &&
			!segment.endsWith(".") &&
			!segment.endsWith(" ")
		);
	});
}

/** HTTPS without userinfo, `ssh://git@…`, or `git@host:path`. */
export function isCredentialFreeRemoteUrl(url: string): boolean {
	if (
		utf8Bytes(url) > RNP_CONTINUITY_LIMITS.maxNodeUrlBytes ||
		hasControlCharacters(url) ||
		url.includes("?") ||
		url.includes("#")
	) {
		return false;
	}
	if (url.startsWith("https://")) {
		const authority = url.slice("https://".length).split("/")[0] ?? "";
		return authority.length > 0 && !authority.includes("@");
	}
	if (url.startsWith("ssh://")) {
		const authority = url.slice("ssh://".length).split("/")[0] ?? "";
		const [user, host, ...rest] = authority.split("@");
		return (
			user === "git" &&
			Boolean(host) &&
			rest.length === 0 &&
			!host?.includes(":")
		);
	}
	if (url.startsWith("git@")) {
		const rest = url.slice("git@".length);
		return rest.includes(":") && !rest.includes("@") && !rest.includes("://");
	}
	return false;
}

function collisionKey(path: string): string {
	return path.normalize("NFC").toLowerCase();
}

const safePathSchema = z
	.string({ error: "Workspace path is invalid" })
	.refine(isSafeRepoRelativePath, { error: "Workspace path is unsafe" });
const commitSchema = z
	.string({ error: "Commit id is invalid" })
	.regex(HEX_COMMIT, { error: "Commit id is invalid" });
function byteCount(max: number, message: string) {
	return z
		.number({ error: message })
		.int({ error: message })
		.min(0, { error: message })
		.max(max, { error: message });
}
const blobRefSchema = rnpObject(
	{
		sha256: z
			.string({ error: "Blob digest is invalid" })
			.regex(SHA256_HEX, { error: "Blob digest is invalid" }),
		bytes: byteCount(
			RNP_WORKSPACE_LIMITS.bundleBytes,
			"Workspace blob is too large"
		),
		mediaType: z.enum(["application/x-git-bundle", "text/x-diff"], {
			error: "Unsupported blob media type",
		}),
	},
	"Expected a blob reference"
).transform(
	(value): RnpBlobRefV0 => ({
		sha256: value.sha256,
		bytes: value.bytes,
		mediaType: value.mediaType,
	})
);
const workspaceFileSchema = rnpObject(
	{
		path: safePathSchema,
		status: z.enum(["added", "modified", "deleted", "renamed"], {
			error: "Unsupported file status",
		}),
		bytes: byteCount(
			Number.MAX_SAFE_INTEGER,
			"File size is invalid"
		).optional(),
		binary: z.boolean({ error: "File binary flag is invalid" }),
		sensitive: z.boolean({ error: "File sensitive flag is invalid" }),
	},
	"Expected a workspace file"
).transform((value) => {
	const file: RnpWorkspaceFileV0 = {
		path: value.path,
		status: value.status,
		binary: value.binary,
		sensitive: value.sensitive,
	};
	if (value.bytes !== undefined) {
		file.bytes = value.bytes;
	}
	return file;
});
const omissionReasonSchema = z.enum(
	[
		"ignored",
		"too-large",
		"not-selected",
		"symlink",
		"submodule",
		"unsafe-path",
		"not-a-git-repository",
	],
	{ error: "Unsupported omission reason" }
);
const omissionSchema = rnpObject(
	{
		// Omitted paths are reported, never written, so an unsafe one is listed
		// with `unsafe-path` rather than rejected.
		path: boundedString(
			RNP_WORKSPACE_LIMITS.pathBytes,
			"Workspace path is invalid"
		),
		reason: omissionReasonSchema,
	},
	"Expected an omitted path"
).transform(
	(value): RnpWorkspaceOmissionV0 => ({
		path: value.path,
		reason: value.reason,
	})
);
function pathList<S extends z.ZodType<{ path: string }>>(
	item: S,
	count: number,
	label: string
) {
	return orderedItems(
		item,
		{
			count,
			bytes: Number.POSITIVE_INFINITY,
			arrayMessage: `${label} must be an array`,
			countMessage: `Too many ${label.toLowerCase()}`,
			duplicateMessage: `${label} paths must be unique`,
			bytesMessage: `${label} are too large`,
			idField: "path",
		},
		(value) => value.path,
		() => 0
	);
}
const repoSchema = rnpObject(
	{
		name: boundedString(
			RNP_CONTINUITY_LIMITS.maxLabelBytes,
			"Repository name is invalid"
		),
		remoteUrl: z
			.string({ error: "Remote URL is invalid" })
			.refine(isCredentialFreeRemoteUrl, {
				error: "Remote URL must be credential-free HTTPS or SSH",
			})
			.optional(),
		baseCommit: commitSchema,
		branch: boundedString(
			RNP_CONTINUITY_LIMITS.maxLabelBytes,
			"Branch name is invalid"
		).optional(),
		upstreamRef: boundedString(
			RNP_CONTINUITY_LIMITS.maxLabelBytes,
			"Upstream ref is invalid"
		).optional(),
	},
	"Expected repository details"
).transform((value) => {
	const repo: RnpWorkspaceRepoV0 = {
		name: value.name,
		baseCommit: value.baseCommit,
	};
	if (value.remoteUrl !== undefined) {
		repo.remoteUrl = value.remoteUrl;
	}
	if (value.branch !== undefined) {
		repo.branch = value.branch;
	}
	if (value.upstreamRef !== undefined) {
		repo.upstreamRef = value.upstreamRef;
	}
	return repo;
});
const idSchema = (message: string) =>
	boundedString(RNP_CONTINUITY_LIMITS.maxIdBytes, message);

const manifestSchema = rnpObject(
	{
		version: z.literal(0, { error: "Unsupported continuity version" }),
		workspaceId: idSchema("Workspace id is missing or too long"),
		conversationId: idSchema("Conversation id is missing or too long"),
		createdAt: timestamp("Workspace timestamp is invalid"),
		repo: repoSchema,
		commits: rnpObject(
			{
				blob: blobRefSchema,
				tip: commitSchema,
				prerequisites: z
					.array(commitSchema, { error: "Prerequisites must be an array" })
					.max(64, { error: "Too many prerequisites" }),
				count: byteCount(
					RNP_WORKSPACE_LIMITS.maxCommitCount,
					"Commit count is invalid"
				),
			},
			"Expected a commit bundle"
		).optional(),
		diff: rnpObject(
			{
				blob: blobRefSchema,
				files: pathList(
					workspaceFileSchema,
					RNP_WORKSPACE_LIMITS.manifestPaths,
					"Changed files"
				),
			},
			"Expected a working-tree diff"
		).optional(),
		untracked: pathList(
			workspaceFileSchema,
			RNP_WORKSPACE_LIMITS.untrackedCount,
			"Untracked files"
		),
		omitted: pathList(
			omissionSchema,
			RNP_WORKSPACE_LIMITS.manifestPaths,
			"Omitted paths"
		),
	},
	"Expected a workspace manifest"
)
	.superRefine((manifest, context) => {
		const issue = (message: string, path: (string | number)[]) =>
			context.addIssue({ code: "custom", message, path });
		if (manifest.commits) {
			if (manifest.commits.blob.mediaType !== "application/x-git-bundle") {
				issue("Commit blob must be a git bundle", ["commits", "blob"]);
			}
			if (manifest.commits.tip !== manifest.repo.baseCommit) {
				issue("Bundle tip must be the base commit", ["commits", "tip"]);
			}
		}
		const diffFiles = manifest.diff?.files ?? [];
		if (manifest.diff) {
			if (manifest.diff.blob.mediaType !== "text/x-diff") {
				issue("Diff blob must be a patch", ["diff", "blob"]);
			}
			if (manifest.diff.blob.bytes > RNP_WORKSPACE_LIMITS.diffBytes) {
				issue("Workspace blob is too large", ["diff", "blob", "bytes"]);
			}
		}
		const keys = new Set<string>();
		for (const [index, file] of diffFiles.entries()) {
			const key = collisionKey(file.path);
			if (keys.has(key)) {
				issue("Changed paths collide by case or normalization", [
					"diff",
					"files",
					index,
					"path",
				]);
				return;
			}
			keys.add(key);
		}
		const diffPaths = new Set(diffFiles.map((file) => file.path));
		let untrackedBytes = 0;
		for (const [index, file] of manifest.untracked.entries()) {
			if (!diffPaths.has(file.path)) {
				issue("Untracked file is missing from the diff", [
					"untracked",
					index,
					"path",
				]);
				return;
			}
			const bytes = file.bytes ?? 0;
			if (bytes > RNP_WORKSPACE_LIMITS.untrackedFileBytes) {
				issue("Untracked file is too large", ["untracked", index, "bytes"]);
				return;
			}
			untrackedBytes += bytes;
		}
		if (untrackedBytes > RNP_WORKSPACE_LIMITS.untrackedTotalBytes) {
			issue("Untracked files are too large", ["untracked"]);
		}
		if (
			diffFiles.length + manifest.omitted.length >
			RNP_WORKSPACE_LIMITS.manifestPaths
		) {
			issue("Too many workspace paths", ["omitted"]);
		}
	})
	.transform((value) => {
		const manifest: RnpWorkspaceManifestV0 = {
			version: value.version,
			workspaceId: value.workspaceId,
			conversationId: value.conversationId,
			createdAt: value.createdAt,
			repo: value.repo,
			untracked: value.untracked,
			omitted: value.omitted,
		};
		if (value.commits) {
			manifest.commits = {
				blob: value.commits.blob,
				tip: value.commits.tip,
				prerequisites: value.commits.prerequisites,
				count: value.commits.count,
			};
		}
		if (value.diff) {
			manifest.diff = { blob: value.diff.blob, files: value.diff.files };
		}
		return manifest;
	});

const candidateSchema = rnpObject(
	{
		path: boundedString(
			RNP_WORKSPACE_LIMITS.pathBytes,
			"Workspace path is invalid"
		),
		bytes: byteCount(Number.MAX_SAFE_INTEGER, "File size is invalid"),
		sensitive: z.boolean({ error: "File sensitive flag is invalid" }),
		selectable: z.boolean({ error: "File selectable flag is invalid" }),
		reason: omissionReasonSchema.optional(),
	},
	"Expected an untracked candidate"
)
	.refine((value) => !value.selectable || isSafeRepoRelativePath(value.path), {
		error: "Workspace path is unsafe",
	})
	.transform((value) => {
		const candidate: RnpWorkspaceUntrackedCandidateV0 = {
			path: value.path,
			bytes: value.bytes,
			sensitive: value.sensitive,
			selectable: value.selectable,
		};
		if (value.reason !== undefined) {
			candidate.reason = value.reason;
		}
		return candidate;
	});
const diffStatSchema = rnpObject(
	{
		files: byteCount(Number.MAX_SAFE_INTEGER, "Diff stat is invalid"),
		insertions: byteCount(Number.MAX_SAFE_INTEGER, "Diff stat is invalid"),
		deletions: byteCount(Number.MAX_SAFE_INTEGER, "Diff stat is invalid"),
	},
	"Diff stat is invalid"
).transform((value) => ({
	files: value.files,
	insertions: value.insertions,
	deletions: value.deletions,
}));
const inspectionSchema = rnpObject(
	{
		version: z.literal(0, { error: "Unsupported continuity version" }),
		conversationId: idSchema("Conversation id is missing or too long"),
		repo: repoSchema,
		unpushedCommits: byteCount(
			RNP_WORKSPACE_LIMITS.maxCommitCount,
			"Commit count is invalid"
		),
		changed: pathList(
			workspaceFileSchema,
			RNP_WORKSPACE_LIMITS.manifestPaths,
			"Changed files"
		),
		untrackedCandidates: pathList(
			candidateSchema,
			RNP_WORKSPACE_LIMITS.manifestPaths,
			"Untracked candidates"
		),
		diffStat: diffStatSchema,
	},
	"Expected a workspace inspection"
).transform(
	(value): RnpWorkspaceInspectionV0 => ({
		version: value.version,
		conversationId: value.conversationId,
		repo: value.repo,
		unpushedCommits: value.unpushedCommits,
		changed: value.changed,
		untrackedCandidates: value.untrackedCandidates,
		diffStat: value.diffStat,
	})
);
const workspaceResumeResultSchema = rnpObject(
	{
		version: z.literal(0, { error: "Unsupported continuity version" }),
		workspaceId: idSchema("Workspace id is missing or too long"),
		conversationId: idSchema("Conversation id is missing or too long"),
		status: z.enum(["created", "unchanged"], {
			error: "Unsupported resume status",
		}),
		folderPath: boundedString(
			RNP_WORKSPACE_LIMITS.pathBytes,
			"Folder path is invalid"
		),
		worktreePath: boundedString(
			RNP_WORKSPACE_LIMITS.pathBytes,
			"Worktree path is invalid"
		),
		branch: boundedString(
			RNP_CONTINUITY_LIMITS.maxLabelBytes,
			"Branch name is invalid"
		),
		// Unknown warnings from a newer node are dropped rather than failing.
		warnings: z
			.array(z.string(), { error: "Warnings must be an array" })
			.transform((values) =>
				values.filter(
					(value): value is "workspace-untrusted" =>
						value === "workspace-untrusted"
				)
			),
	},
	"Expected a workspace resume result"
).transform(
	(value): RnpWorkspaceResumeResultV0 => ({
		version: value.version,
		workspaceId: value.workspaceId,
		conversationId: value.conversationId,
		status: value.status,
		folderPath: value.folderPath,
		worktreePath: value.worktreePath,
		branch: value.branch,
		warnings: value.warnings,
	})
);
const capabilitiesSchema = rnpObject(
	{
		version: z.literal(0, { error: "Unsupported continuity version" }),
		features: z
			.array(boundedString(64, "Feature name is invalid"), {
				error: "Features must be an array",
			})
			.max(64, { error: "Too many features" }),
	},
	"Expected node capabilities"
).transform(
	(value): RnpCapabilitiesV0 => ({
		version: value.version,
		features: value.features,
	})
);

function parseWorkspaceValue<T>(
	schema: z.ZodType<T>,
	input: unknown,
	maxBytes: number
): RnpParseResult<T> {
	let decoded = input;
	if (typeof input === "string") {
		if (utf8Bytes(input) > maxBytes) {
			return failure("limit-exceeded", "Workspace payload exceeds its limit");
		}
		try {
			decoded = JSON.parse(input);
		} catch {
			return failure("invalid-json", "Workspace payload is not valid JSON");
		}
	}
	const parsed = schema.safeParse(decoded);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		if (!issue) {
			throw new Error("Missing workspace validation issue");
		}
		let code: RnpParseErrorCode = "invalid-shape";
		if (issue.message === "Unsupported continuity version") {
			code = "unsupported-version";
		} else if (LIMIT_MESSAGE.test(issue.message)) {
			code = "limit-exceeded";
		}
		return failure(code, issue.message, issuePath(issue));
	}
	if (utf8Bytes(JSON.stringify(parsed.data)) > maxBytes) {
		return failure("limit-exceeded", "Workspace payload exceeds its limit");
	}
	return { ok: true, value: parsed.data };
}

export function parseRnpWorkspaceManifest(
	input: unknown
): RnpParseResult<RnpWorkspaceManifestV0> {
	return parseWorkspaceValue(
		manifestSchema,
		input,
		RNP_WORKSPACE_LIMITS.manifestJsonBytes
	);
}

export function parseRnpWorkspaceInspection(
	input: unknown
): RnpParseResult<RnpWorkspaceInspectionV0> {
	return parseWorkspaceValue(
		inspectionSchema,
		input,
		RNP_CONTINUITY_LIMITS.maxWireBytes
	);
}

export function parseRnpWorkspaceResumeResult(
	input: unknown
): RnpParseResult<RnpWorkspaceResumeResultV0> {
	return parseWorkspaceValue(
		workspaceResumeResultSchema,
		input,
		RNP_CONTINUITY_LIMITS.maxWireBytes
	);
}

export function parseRnpCapabilities(
	input: unknown
): RnpParseResult<RnpCapabilitiesV0> {
	return parseWorkspaceValue(capabilitiesSchema, input, 64 * 1024);
}
