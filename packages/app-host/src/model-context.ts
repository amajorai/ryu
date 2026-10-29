import { z } from "zod";
import { create } from "zustand";

export type ModelContextContent = (
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: "resource_link"; uri: string; name: string }
	| {
			type: "resource";
			resource: (
				| { uri: string; text: string }
				| { uri: string; blob: string }
			) & { mimeType?: string };
	  }
) & {
	annotations?: { audience: ("assistant" | "user")[] };
	_meta?: { "openai/title"?: string; "openai/thumbnail"?: { src: string } };
};

export interface ModelContextInput {
	content?: ModelContextContent[];
	structuredContent?: z.infer<typeof structuredContentSchema>;
}

export interface ModelContextState extends ModelContextInput {
	updateId: string;
}

const structuredContentSchema = z.record(z.string(), z.json());
const audienceSchema = z.enum(["assistant", "user"]);
const annotationsSchema = z
	.object({
		audience: z.array(z.unknown()).transform((values) =>
			values.flatMap((value) => {
				const parsed = audienceSchema.safeParse(value);
				return parsed.success ? [parsed.data] : [];
			})
		),
	})
	.optional()
	.catch(undefined);
const presentationSchema = z
	.object({
		"openai/title": z
			.string()
			.transform((title) => title.slice(0, 256))
			.optional()
			.catch(undefined),
		"openai/thumbnail": z
			.object({ src: z.string().startsWith("https://") })
			.optional()
			.catch(undefined),
	})
	.transform((meta) => {
		const presentation: NonNullable<ModelContextContent["_meta"]> = {};
		if (meta["openai/title"] !== undefined) {
			presentation["openai/title"] = meta["openai/title"];
		}
		if (meta["openai/thumbnail"] !== undefined) {
			presentation["openai/thumbnail"] = meta["openai/thumbnail"];
		}
		return presentation;
	})
	.optional()
	.catch(undefined);
const resourceSchema = z.union([
	z.object({ uri: z.string(), text: z.string() }),
	z
		.object({
			uri: z.string(),
			blob: z
				.string()
				.regex(
					/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
				),
			mimeType: z
				.string()
				.regex(
					/^[A-Za-z0-9][A-Za-z0-9.+-]*\/[A-Za-z0-9][A-Za-z0-9.+-]*$/,
					"Invalid embedded resource MIME type"
				)
				.optional(),
		})
		.superRefine((resource, context) => {
			if ("mimeType" in resource && resource.mimeType === undefined) {
				context.addIssue({
					code: "custom",
					message: "Invalid embedded resource MIME type",
					path: ["mimeType"],
				});
			}
		})
		.transform((resource) => ({
			...resource,
			mimeType: resource.mimeType ?? "application/octet-stream",
		})),
]);
const presentationFields = {
	annotations: annotationsSchema,
	_meta: presentationSchema,
};
const contentSchema = z
	.discriminatedUnion("type", [
		z.object({
			type: z.literal("text"),
			text: z.string(),
			...presentationFields,
		}),
		z.object({
			type: z.literal("image"),
			data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
			mimeType: z.string().regex(/^image\/(png|jpeg|webp|gif)$/),
			...presentationFields,
		}),
		z.object({
			type: z.literal("resource_link"),
			uri: z.string(),
			name: z.string(),
			...presentationFields,
		}),
		z.object({
			type: z.literal("resource"),
			resource: resourceSchema,
			...presentationFields,
		}),
	])
	.transform(({ annotations, _meta, ...content }): ModelContextContent => {
		const item: ModelContextContent = content;
		if (annotations !== undefined) {
			item.annotations = annotations;
		}
		if (_meta !== undefined) {
			item._meta = _meta;
		}
		return item;
	});
const modelContextSchema = z.object({
	structuredContent: structuredContentSchema.optional(),
	content: z
		.array(contentSchema)
		.max(32, "content must contain at most 32 items")
		.optional(),
});
/** Parse a bounded model-facing projection. Private result metadata never enters it. */
const modelContextBoundarySchema = z
	.unknown()
	.transform((value): ModelContextInput => {
		const envelope = z.object({}).safeParse(value);
		if (!envelope.success) {
			throw new Error("Model context must be an object");
		}
		if (new TextEncoder().encode(JSON.stringify(value)).length > 2_000_000) {
			throw new Error("Model context exceeds 2 MB");
		}
		const parsed = modelContextSchema.parse(value);
		if ("content" in parsed && parsed.content === undefined) {
			throw new Error("content must contain at most 32 items");
		}
		if (
			"structuredContent" in parsed &&
			parsed.structuredContent === undefined
		) {
			throw new Error("structuredContent must be an object");
		}
		return parsed;
	});
export const parseModelContext = modelContextBoundarySchema.parse;

interface ModelContextStore {
	clear(owner: string): void;
	entries: Record<string, { scope: string; state: ModelContextState }>;
	get(scope: string, owner: string): ModelContextState | null;
	remove(owner: string, index: number | "structured"): void;
	update(
		scope: string,
		owner: string,
		input: ModelContextInput
	): ModelContextState;
}

export const useModelContextStore = create<ModelContextStore>((set, get) => ({
	entries: {},
	update: (scope, owner, input) => {
		const previous = get().entries[owner];
		const same =
			previous?.scope === scope &&
			JSON.stringify({
				content: previous.state.content,
				structuredContent: previous.state.structuredContent,
			}) ===
				JSON.stringify({
					content: input.content,
					structuredContent: input.structuredContent,
				});
		const state = same
			? previous.state
			: { ...input, updateId: crypto.randomUUID() };
		set((current) => ({
			entries: { ...current.entries, [owner]: { scope, state } },
		}));
		return state;
	},
	clear: (owner) =>
		set((current) => ({
			entries: Object.fromEntries(
				Object.entries(current.entries).filter(([key]) => key !== owner)
			),
		})),
	remove: (owner, index) => {
		const entry = get().entries[owner];
		if (!entry) {
			return;
		}
		const next =
			index === "structured"
				? { content: entry.state.content }
				: {
						content: entry.state.content?.filter(
							(_, itemIndex) => itemIndex !== index
						),
						structuredContent: entry.state.structuredContent,
					};
		if (
			!(
				next.content?.length ||
				("structuredContent" in next && next.structuredContent)
			)
		) {
			get().clear(owner);
			return;
		}
		get().update(entry.scope, owner, next);
	},
	get: (scope, owner) => {
		const entry = get().entries[owner];
		return entry?.scope === scope ? entry.state : null;
	},
}));

export function modelContextParts(
	scope: string,
	owner?: string
): (
	| { type: "text"; text: string }
	| { type: "file"; mediaType: string; url: string }
)[] {
	const parts: ReturnType<typeof modelContextParts> = [];
	for (const [key, entry] of Object.entries(
		useModelContextStore.getState().entries
	)) {
		if (owner && key !== owner) {
			continue;
		}
		if (entry.scope !== scope) {
			continue;
		}
		for (const item of entry.state.content ?? []) {
			if (item.type === "image") {
				parts.push({
					type: "file",
					mediaType: item.mimeType,
					url: `data:${item.mimeType};base64,${item.data}`,
				});
			} else if (item.type === "resource" && "blob" in item.resource) {
				const mediaType = item.resource.mimeType ?? "application/octet-stream";
				parts.push({
					type: "file",
					mediaType,
					url: `data:${mediaType};base64,${item.resource.blob}`,
				});
			} else {
				const text =
					item.type === "text"
						? item.text
						: item.type === "resource_link"
							? `${item.name}: ${item.uri}`
							: `${item.resource.uri}\n${"text" in item.resource ? item.resource.text : ""}`;
				parts.push({
					type: "text",
					text: `<app-context>\n${text}\n</app-context>`,
				});
			}
		}
		if (entry.state.structuredContent) {
			parts.push({
				type: "text",
				text: `<app-context>\n${JSON.stringify(entry.state.structuredContent)}\n</app-context>`,
			});
		}
	}
	return parts;
}
