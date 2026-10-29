import { z } from "zod";
import type { AppJsonValue, AppRequestValue } from "./app-request-json.ts";

// Core owns this snake_case v1 contract: crates/core/activity/src/lib.rs and
// apps/core/src/server/activity_api.rs. Native JSON.parse can overflow a numeric
// exponent; retain that existing transport value without rewriting metadata.
const activityNumberSchema = z.union([
	z.number(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);
export const activityJsonValueSchema: z.ZodType<AppJsonValue> = z.lazy(() =>
	z.custom<AppJsonValue>((value) => {
		try {
			if (
				z
					.union([z.string(), activityNumberSchema, z.boolean(), z.null()])
					.safeParse(value).success
			) {
				return true;
			}
			const container = z
				.union([z.array(z.unknown()), z.record(z.string(), z.unknown())])
				.safeParse(value);
			if (!container.success) {
				return false;
			}
			const entries = Array.isArray(container.data)
				? Array.from(container.data)
				: Object.values(new Object(value));
			return entries.every(
				(entry) => activityJsonValueSchema.safeParse(entry).success
			);
		} catch {
			return false;
		}
	})
);
function preserveActivityReply<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			activityJsonValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
export const activityLevelSchema = z.enum(["info", "success", "warning"]);
export type ActivityLevel = z.output<typeof activityLevelSchema>;
export const activityItemSchema = preserveActivityReply(
	z.object({
		agent_id: z.string().nullable(),
		body: z.string().nullable(),
		created_at: activityNumberSchema,
		id: z.string(),
		kind: z.string(),
		level: activityLevelSchema,
		metadata: activityJsonValueSchema,
		session_id: z.string().nullable(),
		source: z.string(),
		title: z.string(),
	})
);
export type ActivityItem = z.output<typeof activityItemSchema>;
export const activityItemsSchema = preserveActivityReply(
	z.array(activityItemSchema)
);
export const activityListReplySchema = preserveActivityReply(
	z.object({
		items: activityItemsSchema.nullish(),
		error: z.string().optional(),
	})
);
export const activityCreateReplySchema = preserveActivityReply(
	z.object({
		item: activityItemSchema.nullish(),
		error: z.string().optional(),
	})
);
export const activityStreamFrameSchema = preserveActivityReply(
	z.discriminatedUnion("type", [
		z.object({ type: z.literal("snapshot"), items: activityItemsSchema }),
		z.object({ type: z.literal("item"), item: activityItemSchema }),
	])
);
export type ActivityStreamFrame = z.output<typeof activityStreamFrameSchema>;

/** Core applies manual/source/level/metadata defaults and business validation. */
export interface ActivityInput {
	agent_id?: string | null;
	body?: string | null;
	kind: string;
	level?: ActivityLevel;
	metadata?: AppRequestValue;
	session_id?: string | null;
	source?: string;
	title: string;
}
