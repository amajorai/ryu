import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";
import type { WidgetAvailablePart } from "../types.ts";
import type { NativeSdkValue } from "./native-sdk-observation.ts";

const widgetDataSchema = z
	.object({
		approvedGrants: z.array(z.string()),
		conversationId: z.string().nullable().optional(),
		displayMode: z.enum(["inline", "fullscreen", "pip"]).optional(),
		initialWidgetState: z.unknown().optional(),
		instanceId: z.string(),
		invoked: z.string().nullable().optional(),
		invoking: z.string().nullable().optional(),
		maxHeight: z.custom<number>(isNativeNumber).nullable().optional(),
		serverId: z.string(),
		templateUri: z.string(),
		toolCallId: z.string(),
		toolInput: z.unknown(),
		toolName: z.string(),
		toolOutput: z.unknown(),
		toolResponseMetadata: z.unknown(),
		widget: z.object({
			csp: z
				.object({
					connect_domains: z.array(z.string()).optional(),
					resource_domains: z.array(z.string()).optional(),
				})
				.optional(),
			html: z.string(),
			mimeType: z.string(),
		}),
		widgetAccessible: z.boolean(),
	})
	.refine(
		(data) =>
			Object.hasOwn(data, "toolInput") &&
			Object.hasOwn(data, "toolOutput") &&
			Object.hasOwn(data, "toolResponseMetadata")
	);
const widgetPartSchema = z.object({
	data: widgetDataSchema,
	type: z.literal("data-tool-widget-available"),
}) satisfies z.ZodType<WidgetAvailablePart>;

/** Complete Core stream/open-app payload admission before a host renderer.
 * Opaque tool cells are not decoded or constrained to JSON. Retain the original
 * publisher reference, including future fields, rather than the schema clone.
 * The supported publisher emits stable serialized fields; this does not promise
 * stability of synthetic accessors between validation and rendering. Malformed
 * payloads and throwing validation/property operations use the unavailable row.
 */
export function isWidgetAvailablePart(
	value: NativeSdkValue
): value is WidgetAvailablePart {
	try {
		return widgetPartSchema.safeParse(value).success;
	} catch {
		return false;
	}
}
