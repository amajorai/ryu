import { z } from "zod";
import { wireObject } from "./wire-object.ts";

export const PUBLIC_AGENT_STATUSES = [
	"draft",
	"published",
	"paused",
	"suspended",
] as const;

/** Ryu-defined sponsored lanes. Each resolves server-side to the hosted Gateway model. */
export const PUBLIC_AGENT_SPONSORED_MODELS = ["ryu-sponsored"] as const;

export const PUBLIC_AGENT_REPORT_CATEGORIES = [
	"spam",
	"scam",
	"impersonation",
	"unsafe-content",
	"malware",
	"other",
] as const;

export const PUBLIC_AGENT_LIMITS = {
	descriptionLength: 240,
	instructionsLength: 8000,
	monthlyRunCap: 20_000,
	nameLength: 60,
	publicationsPerOwner: 20,
	requestBytes: 24 * 1024,
	toolAllowlist: 32,
} as const;

export const PUBLIC_AGENT_TURN_LIMITS = {
	historyEntries: 8,
	historyEntryLength: 2000,
	questionLength: 4000,
} as const;

const SENSITIVE_SECRET_REQUEST_RE =
	/\b(?:send|share|provide|paste|enter|give|submit|type)\b.{0,40}\b(?:password|passphrase|one[- ]time code|otp|seed phrase|recovery phrase|recovery code|private key|wallet key|bank login|login credential|credit card number|security code)s?\b/iu;

export const PUBLIC_AGENT_SECRET_SAFE_REPLY =
	"I can't help collect passwords, verification codes, payment details, wallet keys, or recovery phrases.";

export function publicAgentAnswerSolicitsSensitiveSecrets(
	text: string
): boolean {
	return SENSITIVE_SECRET_REQUEST_RE.test(text);
}

export type PublicAgentStatus = (typeof PUBLIC_AGENT_STATUSES)[number];
export type PublicAgentSponsoredModel =
	(typeof PUBLIC_AGENT_SPONSORED_MODELS)[number];
export type PublicAgentReportCategory =
	(typeof PUBLIC_AGENT_REPORT_CATEGORIES)[number];
export type PublicAgentCredentialInput =
	| { bearerToken: string; mode: "replace" }
	| { mode: "keep" };

export type PublicAgentRuntimeInput =
	| {
			access: "visitor";
			instructions: string;
			kind: "persona";
			publicPrompt: string;
			publishPublicPrompt: true;
	  }
	| {
			access: "sponsored";
			instructions: string;
			kind: "persona";
			modelId: PublicAgentSponsoredModel;
			monthlyRunCap: number;
	  }
	| {
			credential: PublicAgentCredentialInput;
			kind: "core-agent";
			monthlyRunCap: number;
			principalId: string;
			sourceAgentId: string;
			sourceRevision: string;
			a2aEndpoint: string;
			toolAllowlist: string[];
	  };

export type PublicAgentOwnerRuntime =
	| {
			access: "visitor";
			instructions: string;
			kind: "persona";
			publicPrompt: string;
			publishPublicPrompt: true;
	  }
	| {
			access: "sponsored";
			instructions: string;
			kind: "persona";
			modelId: PublicAgentSponsoredModel;
			monthlyRunCap: number;
	  }
	| {
			credentialConfigured: boolean;
			kind: "core-agent";
			monthlyRunCap: number;
			principalId: string;
			sourceAgentId: string;
			sourceRevision: string;
			a2aEndpoint: string;
			toolAllowlist: string[];
	  };

export type PublicAgentRuntimeSummary =
	| { access: "visitor"; kind: "persona" }
	| {
			access: "sponsored";
			kind: "persona";
			modelId: PublicAgentSponsoredModel;
	  }
	| { kind: "core-agent" };

export interface PublicAgentOwnerRecord {
	createdAt: string;
	description: string;
	id: string;
	name: string;
	runtime: PublicAgentOwnerRuntime;
	slug: string;
	status: PublicAgentStatus;
	updatedAt: string;
}

export interface PublicAgentCard {
	description: string;
	id: string;
	name: string;
	runtime: PublicAgentRuntimeSummary;
	slug: string;
}

export type PublicAgentDetail =
	| (PublicAgentCard & {
			runtime: { access: "visitor"; kind: "persona" };
			publicPrompt: string;
	  })
	| (PublicAgentCard & {
			runtime:
				| {
						access: "sponsored";
						kind: "persona";
						modelId: PublicAgentSponsoredModel;
				  }
				| { kind: "core-agent" };
			publicPrompt?: never;
	  });

export interface PublicAgentWriteInput {
	description: string;
	name: string;
	runtime: PublicAgentRuntimeInput;
	status: PublicAgentStatus;
}

export interface PublicAgentReportInput {
	category: PublicAgentReportCategory;
	publicationId: string;
}

export interface PublicAgentTurnHistoryEntry {
	content: string;
	role: "visitor" | "agent";
}

export interface PublicAgentTurnInput {
	history?: PublicAgentTurnHistoryEntry[];
	question: string;
}

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const TOOL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/u;
const PUBLICATION_ID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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

function isPublicAgentEndpoint(value: string): boolean {
	if (
		value.length > 2048 ||
		value.trim() !== value ||
		hasControlCharacters(value)
	) {
		return false;
	}
	try {
		const url = new URL(value);
		const host = url.hostname.toLowerCase();
		const privateIpv4 =
			host.startsWith("127.") ||
			host.startsWith("10.") ||
			host.startsWith("192.168.") ||
			host.startsWith("169.254.") ||
			/^172\.(1[6-9]|2\d|3[01])\./u.test(host);
		return (
			url.protocol === "https:" &&
			url.username.length === 0 &&
			url.password.length === 0 &&
			url.search.length === 0 &&
			url.hash.length === 0 &&
			!privateIpv4 &&
			host !== "localhost" &&
			!host.endsWith(".localhost") &&
			!host.endsWith(".local") &&
			!host.endsWith(".internal") &&
			!host.startsWith("[") &&
			host.includes(".")
		);
	} catch {
		return false;
	}
}

function boundedText(maxLength: number, allowEmpty: boolean) {
	return z
		.string()
		.max(maxLength)
		.refine((value) => !hasControlCharacters(value))
		.transform((value) => value.trim())
		.refine((value) => allowEmpty || value.length > 0);
}
const instructionsSchema = boundedText(
	PUBLIC_AGENT_LIMITS.instructionsLength,
	false
);
const monthlyRunCapSchema = z
	.number()
	.int()
	.min(1)
	.max(PUBLIC_AGENT_LIMITS.monthlyRunCap);
const identifierSchema = z.string().regex(IDENTIFIER_RE);
const credentialSchema = z.union([
	wireObject({ mode: z.literal("keep") }, true),
	wireObject(
		{
			bearerToken: z
				.string()
				.min(16)
				.max(8192)
				.refine(
					(value) =>
						value.trim() === value &&
						!/\s/u.test(value) &&
						!hasControlCharacters(value)
				),
			mode: z.literal("replace"),
		},
		true
	),
]);
const visitorRuntimeSchema = wireObject(
	{
		access: z.literal("visitor"),
		instructions: instructionsSchema,
		kind: z.literal("persona"),
		publicPrompt: instructionsSchema,
		publishPublicPrompt: z.literal(true),
	},
	true
);
const sponsoredRuntimeSchema = wireObject(
	{
		access: z.literal("sponsored"),
		instructions: instructionsSchema,
		kind: z.literal("persona"),
		modelId: z.enum(PUBLIC_AGENT_SPONSORED_MODELS),
		monthlyRunCap: monthlyRunCapSchema,
	},
	true
);
const coreRuntimeSchema = wireObject(
	{
		credential: credentialSchema,
		kind: z.literal("core-agent"),
		monthlyRunCap: monthlyRunCapSchema,
		principalId: identifierSchema,
		sourceAgentId: identifierSchema,
		sourceRevision: identifierSchema,
		a2aEndpoint: z.string().refine(isPublicAgentEndpoint),
		toolAllowlist: z
			.array(
				z
					.string()
					.transform((value) =>
						value.startsWith("tool:") ? value.slice(5) : value
					)
					.pipe(z.string().regex(TOOL_ID_RE))
					.transform((value) => `tool:${value}`)
			)
			.min(1)
			.max(PUBLIC_AGENT_LIMITS.toolAllowlist)
			.refine((value) => new Set(value).size === value.length),
	},
	true
);
const writeSchema = wireObject(
	{
		description: boundedText(PUBLIC_AGENT_LIMITS.descriptionLength, true)
			.nullish()
			.transform((value) => value ?? ""),
		name: boundedText(PUBLIC_AGENT_LIMITS.nameLength, false),
		runtime: z.union([
			visitorRuntimeSchema,
			sponsoredRuntimeSchema,
			coreRuntimeSchema,
		]),
		status: z.enum(PUBLIC_AGENT_STATUSES),
	},
	true
);
/** Parse owner writes once at the HTTP boundary; unknown fields fail closed. */
export const parsePublicAgentWriteInput = writeSchema
	.or(z.undefined())
	.catch(undefined).parse;
const reportSchema = wireObject(
	{
		category: z.enum(PUBLIC_AGENT_REPORT_CATEGORIES),
		publicationId: z
			.string()
			.regex(PUBLICATION_ID_RE)
			.transform((value) => value.toLowerCase()),
	},
	true
);
/** Parse a fixed-category report without free-form details. */
export const parsePublicAgentReportInput = reportSchema
	.or(z.undefined())
	.catch(undefined).parse;
const historyEntrySchema = wireObject(
	{
		role: z.enum(["visitor", "agent"]),
		content: boundedText(PUBLIC_AGENT_TURN_LIMITS.historyEntryLength, false),
	},
	true
);
const turnSchema = wireObject(
	{
		history: z
			.array(historyEntrySchema)
			.max(PUBLIC_AGENT_TURN_LIMITS.historyEntries)
			.optional(),
		question: boundedText(PUBLIC_AGENT_TURN_LIMITS.questionLength, false),
	},
	true
).transform((value) =>
	value.history === undefined
		? { question: value.question }
		: { history: value.history, question: value.question }
);
/** Parse a bounded turn and ordered visitor/agent history. */
export const parsePublicAgentTurnInput = turnSchema
	.or(z.undefined())
	.catch(undefined).parse;

/** Validate a route slug independently of its owner's display name. */
export function isPublicAgentSlug(value: string): boolean {
	return value.length <= 48 && SLUG_RE.test(value);
}

/** Build a public card by copying only fields allowed on anonymous reads. */
export function toPublicAgentCard(
	record: PublicAgentOwnerRecord
): PublicAgentCard {
	const runtime = record.runtime;
	let summary: PublicAgentRuntimeSummary;
	switch (runtime.kind) {
		case "persona":
			summary =
				runtime.access === "visitor"
					? { access: "visitor", kind: "persona" }
					: {
							access: "sponsored",
							kind: "persona",
							modelId: runtime.modelId,
						};
			break;
		case "core-agent":
			summary = { kind: "core-agent" };
			break;
		default: {
			const exhaustive: never = runtime;
			return exhaustive;
		}
	}
	return {
		description: record.description,
		id: record.id,
		name: record.name,
		runtime: summary,
		slug: record.slug,
	};
}

/** Add only the separately consented public prompt to visitor persona detail. */
export function toPublicAgentDetail(
	record: PublicAgentOwnerRecord
): PublicAgentDetail {
	const common = {
		description: record.description,
		id: record.id,
		name: record.name,
		slug: record.slug,
	};
	switch (record.runtime.kind) {
		case "persona":
			if (record.runtime.access === "visitor") {
				return {
					...common,
					runtime: { access: "visitor", kind: "persona" },
					publicPrompt: record.runtime.publicPrompt,
				};
			}
			return {
				...common,
				runtime: {
					access: "sponsored",
					kind: "persona",
					modelId: record.runtime.modelId,
				},
			};
		case "core-agent":
			return { ...common, runtime: { kind: "core-agent" } };
		default: {
			const exhaustive: never = record.runtime;
			return exhaustive;
		}
	}
}

const visitorSummarySchema = wireObject({
	access: z.literal("visitor"),
	kind: z.literal("persona"),
});
const sponsoredSummarySchema = wireObject({
	access: z.literal("sponsored"),
	kind: z.literal("persona"),
	modelId: z.enum(PUBLIC_AGENT_SPONSORED_MODELS),
});
const coreSummarySchema = wireObject({ kind: z.literal("core-agent") });
const cardFields = {
	description: z
		.string()
		.max(PUBLIC_AGENT_LIMITS.descriptionLength)
		.refine((value) => !hasControlCharacters(value)),
	id: z
		.string()
		.regex(PUBLICATION_ID_RE)
		.transform((value) => value.toLowerCase()),
	name: z
		.string()
		.min(1)
		.max(PUBLIC_AGENT_LIMITS.nameLength)
		.refine((value) => !hasControlCharacters(value)),
	runtime: z.union([
		visitorSummarySchema,
		sponsoredSummarySchema,
		coreSummarySchema,
	]),
	slug: z.string().refine(isPublicAgentSlug),
};
/** Decode only the explicitly public card fields. */
export const parsePublicAgentCard = wireObject(cardFields)
	.or(z.undefined())
	.catch(undefined).parse;
const detailSchema = z.union([
	wireObject({
		description: cardFields.description,
		id: cardFields.id,
		name: cardFields.name,
		runtime: visitorSummarySchema,
		publicPrompt: instructionsSchema,
		slug: cardFields.slug,
	}),
	wireObject({
		...cardFields,
		runtime: z.union([sponsoredSummarySchema, coreSummarySchema]),
	}),
]);
/** Public prompt is accepted only for the consented visitor detail. */
export const parsePublicAgentDetail = detailSchema
	.or(z.undefined())
	.catch(undefined).parse;
