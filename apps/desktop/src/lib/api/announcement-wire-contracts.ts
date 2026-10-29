import { z } from "zod";
import type { Announcement } from "./announcements.ts";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";

// Full UserAnnouncementView emitted by packages/api serializeForUser.
const announcementFieldsSchema = z.object({
	blobColors: z.array(z.string()),
	body: z.string().nullable(),
	color: z.string().nullable(),
	createdAt: z.string().nullable(),
	icon: z.string().nullable(),
	iconUrl: z.string().nullable(),
	id: z.string(),
	linkLabel: z.string().nullable(),
	linkUrl: z.string().nullable(),
	read: z.boolean(),
	title: z.string(),
	type: z.enum(["card", "dialog"]),
	visualCode: z.string().nullable(),
	visualIcon: z.string().nullable(),
	visualIconBackground: z.string().nullable(),
	visualIconDither: z
		.object({
			direction: z.string().nullish(),
			from: z.union([z.string(), z.number()]).nullish(),
			to: z.union([z.string(), z.number()]).nullish(),
		})
		.nullable(),
	visualIconUrl: z.string().nullable(),
}) satisfies z.ZodType<Announcement>;
export const announcementRecordSchema = z.custom<Announcement>(
	(value) =>
		announcementFieldsSchema.safeParse(value).success &&
		gatewayJsonValueSchema.safeParse(value).success
);
const feedFieldsSchema = z.object({
	announcements: z.array(announcementRecordSchema).nullish(),
});
export const announcementFeedSchema = z.custom<
	z.output<typeof feedFieldsSchema>
>(
	(value) =>
		feedFieldsSchema.safeParse(value).success &&
		gatewayJsonValueSchema.safeParse(value).success
);
