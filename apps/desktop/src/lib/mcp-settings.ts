import { z } from "zod";
import { type McpJsonPayload, mcpJsonPayloadSchema } from "./api/mcp.ts";

export type McpSettingValue = string | number | boolean;
export interface McpSettingField {
	description?: string;
	enum?: string[];
	key: string;
	maximum?: number;
	maxLength?: number;
	minimum?: number;
	minLength?: number;
	multipleOf?: number;
	pattern?: string;
	title: string;
	type: "string" | "boolean" | "number" | "integer";
}
export interface McpSettingsData {
	fields: McpSettingField[];
	groups: {
		title: string;
		generated?: "settings" | "other";
		items: (
			| { kind: "property"; property: string }
			| { kind: "tool"; tool: string; title: string; description?: string }
		)[];
	}[];
	values: Record<string, McpSettingValue>;
}
const settingsObjectSchema = z.record(z.string(), mcpJsonPayloadSchema);
const settingsEnvelopeSchema = z.object({
	schema: z.object({ properties: settingsObjectSchema }),
	values: settingsObjectSchema,
	layout: z.array(mcpJsonPayloadSchema).optional().catch(undefined),
});
const settingTypeSchema = z.enum(["string", "boolean", "number", "integer"]);
const settingValueSchema = z.union([z.string(), z.number(), z.boolean()]);
const settingMetadataSchema = z.object({
	title: z.string().optional().catch(undefined),
	description: z.string().optional().catch(undefined),
	enum: z.array(z.string()).optional().catch(undefined),
	minimum: z.number().optional().catch(undefined),
	maximum: z.number().optional().catch(undefined),
	minLength: z.number().optional().catch(undefined),
	maxLength: z.number().optional().catch(undefined),
	pattern: z.string().optional().catch(undefined),
	multipleOf: z.number().optional().catch(undefined),
});
const settingValueByType = {
	string: z.string(),
	boolean: z.boolean(),
	number: z.number(),
	integer: z.number().refine(Number.isInteger),
};
const settingGroupSchema = z.object({
	kind: z.literal("group"),
	title: z.string(),
	items: z.array(mcpJsonPayloadSchema),
});
const settingLayoutItemSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("property"), property: z.string() }),
	z.object({
		kind: z.literal("tool"),
		tool: z.string(),
		title: z.string(),
		description: z.string().optional().catch(undefined),
	}),
]);
export function parseMcpSettings(
	output: McpJsonPayload | undefined
): McpSettingsData {
	const object = settingsObjectSchema.safeParse(output);
	const structured = object.success
		? settingsObjectSchema.safeParse(object.data.structuredContent)
		: undefined;
	const payload = settingsEnvelopeSchema.safeParse(
		structured?.success ? structured.data : output
	);
	if (!payload.success) {
		throw new Error(
			"The settings tool did not return a settings schema and values"
		);
	}
	const fields: McpSettingField[] = [];
	const values: Record<string, McpSettingValue> = {};
	for (const [key, entry] of Object.entries(payload.data.schema.properties)) {
		const raw = settingsObjectSchema.safeParse(entry);
		if (
			key === "__proto__" ||
			key === "constructor" ||
			key === "prototype" ||
			!raw.success
		) {
			continue;
		}
		const type = settingTypeSchema.safeParse(raw.data.type);
		if (!type.success) {
			throw new Error(`Unsupported settings type for ${key}`);
		}
		const value = settingValueSchema.safeParse(payload.data.values[key]);
		if (!value.success) {
			throw new Error(`The settings tool did not supply a value for ${key}`);
		}
		if (!settingValueByType[type.data].safeParse(value.data).success) {
			throw new Error(
				`The settings value for ${key} does not match its schema`
			);
		}
		const metadata = settingMetadataSchema.parse(raw.data);
		fields.push({
			key,
			type: type.data,
			...metadata,
			title: metadata.title ?? key,
		});
		values[key] = value.data;
	}
	const groups: McpSettingsData["groups"] = [];
	const grouped = new Set<string>();
	for (const entry of payload.data.layout ?? []) {
		const group = settingGroupSchema.safeParse(entry);
		if (!group.success) {
			throw new Error("Invalid settings layout");
		}
		const items: McpSettingsData["groups"][number]["items"] = [];
		for (const entryItem of group.data.items) {
			if (!settingsObjectSchema.safeParse(entryItem).success) {
				throw new Error("Invalid settings layout item");
			}
			const parsed = settingLayoutItemSchema.safeParse(entryItem);
			if (!parsed.success) {
				continue;
			}
			const item = parsed.data;
			if (item.kind === "tool") {
				items.push(item);
			} else if (
				fields.some((field) => field.key === item.property) &&
				!grouped.has(item.property)
			) {
				items.push(item);
				grouped.add(item.property);
			}
		}
		groups.push({ title: group.data.title, items });
	}
	const ungrouped = fields.filter((field) => !grouped.has(field.key));
	if (ungrouped.length) {
		groups.push({
			title: groups.length ? "Other settings" : "Settings",
			generated: groups.length ? "other" : "settings",
			items: ungrouped.map((field) => ({
				kind: "property",
				property: field.key,
			})),
		});
	}
	return { fields, values, groups };
}

export function changedMcpSettings(
	previous: McpSettingsData,
	values: Record<string, McpSettingValue>
): McpSettingsData["values"] {
	const changes: Record<string, McpSettingValue> = {};
	for (const field of previous.fields) {
		const value = values[field.key];
		if (value !== previous.values[field.key]) {
			changes[field.key] = value;
		}
	}
	return changes;
}

const settingTextContentSchema = z.object({
	content: z.array(mcpJsonPayloadSchema),
});
const settingTextPartSchema = z.object({
	type: z.literal("text"),
	text: z.string(),
});
export function mcpSettingsActionText(
	output: McpJsonPayload | undefined
): string | undefined {
	const direct = z.string().safeParse(output);
	if (direct.success) {
		return direct.data;
	}
	const content = settingTextContentSchema.safeParse(output);
	if (!content.success) {
		return;
	}
	const text = content.data.content.flatMap((item) => {
		const part = settingTextPartSchema.safeParse(item);
		return part.success ? [part.data.text] : [];
	});
	return text.length ? text.join("\n") : undefined;
}
export function mcpSettingsResultStatus(
	output: McpJsonPayload | undefined
): "completed" | "failed" | "pending" {
	if (output === undefined || output === null) {
		return "failed";
	}
	const object = settingsObjectSchema.safeParse(output);
	if (object.success) {
		if (Object.hasOwn(object.data, "__ryu_elicitation__")) {
			return "pending";
		}
		if (object.data.isError === true) {
			return "failed";
		}
	}
	return "completed";
}

export function confirmedMcpSettingsChanges(
	data: McpSettingsData,
	changes: Record<string, McpSettingValue>
): boolean {
	return Object.entries(changes).every(
		([key, value]) =>
			Object.hasOwn(data.values, key) && data.values[key] === value
	);
}
