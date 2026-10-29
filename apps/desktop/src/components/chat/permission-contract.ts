import { z } from "zod";

const toolFieldsSchema = z.object({
	title: z.string().optional().catch(undefined),
	kind: z.string().optional().catch(undefined),
	rawInput: z.record(z.string(), z.json()).optional().catch(undefined),
});
const toolCallSchema = toolFieldsSchema.extend({
	fields: toolFieldsSchema.optional().catch(undefined),
});
export const activePermissionSchema = z.object({
	requestId: z.string().min(1),
	options: z.array(
		z.object({ optionId: z.string(), name: z.string(), kind: z.string() })
	),
	toolCall: z.unknown(),
});
type ToolCallObservation = z.infer<typeof toolFieldsSchema>;

export function readPermissionToolFields(
	toolCall: Parameters<typeof toolCallSchema.safeParse>[0]
): ToolCallObservation {
	const parsed = toolCallSchema.safeParse(toolCall);
	if (!parsed.success) {
		return {};
	}
	const { fields, ...inline } = parsed.data;
	const merged: ToolCallObservation = {};
	const title = inline.title ?? fields?.title;
	const kind = inline.kind ?? fields?.kind;
	const rawInput = inline.rawInput ?? fields?.rawInput;
	if (title !== undefined) {
		merged.title = title;
	}
	if (kind !== undefined) {
		merged.kind = kind;
	}
	if (rawInput !== undefined) {
		merged.rawInput = rawInput;
	}
	return merged;
}
