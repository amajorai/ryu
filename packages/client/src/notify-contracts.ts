import { z } from "zod";
import type {
	NotificationEvent,
	NotifyActivity,
	NotifyAnalytics,
	NotifyDelivery,
	NotifyDestination,
	NotifyPreferences,
	NotifySilence,
	NotifyUsageReport,
} from "./notify.ts";
import { wireJsonRecordSchema, wireNumberSchema } from "./wire-json.ts";

const nullableText = z.string().nullable();
const actionSchema = z.object({ label: z.string(), url: z.string() });
const responseSchema = z.object({
	callbackUrl: nullableText,
	// Older Notify servers do not send the preview.
	callbackUrlPreview: nullableText.optional(),
	expiresAt: nullableText,
	prompt: nullableText,
	respondedAt: nullableText,
	status: z.enum([
		"pending",
		"approved",
		"denied",
		"yes",
		"no",
		"replied",
		"expired",
		"canceled",
	]),
	type: z.enum(["approval", "yes_no", "text"]),
	value: nullableText,
});
const eventValidation: z.ZodType<NotificationEvent> = z.object({
	acknowledgedAt: nullableText,
	actions: z.array(actionSchema),
	archivedAt: nullableText,
	attachment: z
		.object({ contentType: nullableText, name: nullableText, url: z.string() })
		.nullable(),
	body: z.string(),
	createdAt: z.string(),
	data: wireJsonRecordSchema,
	externalId: nullableText,
	fingerprint: nullableText,
	icon: nullableText,
	id: z.string(),
	level: z.enum(["info", "success", "warning", "error", "critical"]),
	occurredAt: z.string(),
	priority: z.union([
		z.literal(1),
		z.literal(2),
		z.literal(3),
		z.literal(4),
		z.literal(5),
	]),
	project: nullableText,
	recipient: nullableText,
	response: responseSchema.nullable(),
	source: z.string(),
	tags: z.array(z.string()),
	title: z.string(),
	topic: nullableText,
	type: z.string(),
	url: nullableText,
});
export const notificationEventSchema = z.custom<NotificationEvent>(
	(value) => eventValidation.safeParse(value).success
);
const activityValidation: z.ZodType<NotifyActivity> = z.object({
	accent: nullableText,
	createdAt: z.string(),
	data: wireJsonRecordSchema,
	endedAt: nullableText,
	expiresAt: nullableText,
	id: z.string(),
	progress: wireNumberSchema.nullable(),
	recipient: nullableText,
	sequence: wireNumberSchema,
	status: z.string(),
	symbol: nullableText,
	title: z.string(),
	topic: nullableText,
	updatedAt: z.string(),
});
export const notifyActivitySchema = z.custom<NotifyActivity>(
	(value) => activityValidation.safeParse(value).success
);
const destinationValidation: z.ZodType<NotifyDestination> = z.object({
	createdAt: z.string(),
	enabled: z.boolean(),
	eventTypes: z.array(z.string()),
	hasSecret: z.boolean(),
	headerNames: z.array(z.string()),
	id: z.string(),
	kind: z.enum(["webhook", "ntfy", "buzzkit"]),
	lastDeliveryAt: nullableText,
	lastError: nullableText,
	name: z.string(),
	updatedAt: z.string(),
	urlPreview: z.string(),
});
export const destinationSchema = z.custom<NotifyDestination>(
	(value) => destinationValidation.safeParse(value).success
);
const deliveryValidation: z.ZodType<NotifyDelivery> = z.object({
	attempts: wireNumberSchema,
	createdAt: z.string(),
	deliveredAt: nullableText,
	destinationId: z.string(),
	eventId: z.string(),
	id: z.string(),
	lastError: nullableText,
	nextAttemptAt: nullableText,
	responseStatus: wireNumberSchema.nullable(),
	status: z.enum(["pending", "sending", "succeeded", "failed", "suppressed"]),
	updatedAt: z.string(),
});
export const deliverySchema = z.custom<NotifyDelivery>(
	(value) => deliveryValidation.safeParse(value).success
);
const preferencesValidation: z.ZodType<NotifyPreferences> = z.object({
	muted: z.boolean(),
	quietHours: z
		.object({ end: z.string(), start: z.string(), timezone: z.string() })
		.nullable(),
	recipient: nullableText,
	updatedAt: z.string(),
});
export const preferencesSchema = z.custom<NotifyPreferences>(
	(value) => preferencesValidation.safeParse(value).success
);
const silenceValidation: z.ZodType<NotifySilence> = z.object({
	createdAt: z.string(),
	expiresAt: z.string(),
	fingerprint: nullableText,
	id: z.string(),
	project: nullableText,
	source: nullableText,
	topic: nullableText,
});
export const silenceSchema = z.custom<NotifySilence>(
	(value) => silenceValidation.safeParse(value).success
);
const countMapSchema = z.custom<Record<string, number>>((value) => {
	const record = wireJsonRecordSchema.safeParse(value);
	return (
		record.success &&
		Object.values(record.data).every(
			(entry) => wireNumberSchema.safeParse(entry).success
		)
	);
});
const analyticsValidation: z.ZodType<NotifyAnalytics> = z.object({
	acknowledged: wireNumberSchema,
	byLevel: countMapSchema,
	bySource: countMapSchema,
	byTopic: countMapSchema,
	total: wireNumberSchema,
});
export const analyticsSchema = z.custom<NotifyAnalytics>(
	(value) => analyticsValidation.safeParse(value).success
);
const groupValidation = z.object({
	count: wireNumberSchema,
	fingerprint: z.string(),
	latest: notificationEventSchema,
	unacknowledged: wireNumberSchema,
});
const topicValidation = z.object({
	count: wireNumberSchema,
	topic: z.string(),
});
const eventListValidation = z.object({
	events: z.array(notificationEventSchema),
	nextCursor: nullableText,
});
const destinationTestValidation = z.object({ status: wireNumberSchema });

export const groupSchema = z.custom<z.infer<typeof groupValidation>>(
	(value) => groupValidation.safeParse(value).success
);

export const topicSchema = z.custom<z.infer<typeof topicValidation>>(
	(value) => topicValidation.safeParse(value).success
);

export const eventListSchema = z.custom<z.infer<typeof eventListValidation>>(
	(value) => eventListValidation.safeParse(value).success
);

const usageReportValidation: z.ZodType<NotifyUsageReport> = z.object({
	from: z.string(),
	meters: z.object({ events: wireNumberSchema }),
	to: z.string(),
});
export const usageReportSchema = z.custom<NotifyUsageReport>(
	(value) => usageReportValidation.safeParse(value).success
);

export const destinationTestSchema = z.custom<
	z.infer<typeof destinationTestValidation>
>((value) => destinationTestValidation.safeParse(value).success);
