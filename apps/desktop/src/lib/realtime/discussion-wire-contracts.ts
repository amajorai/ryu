import type { TDiscussion } from "@ryu/ui/components/editor/plugins/discussion-kit.tsx";
import type { TComment } from "@ryu/ui/components/editor/ui/comment.tsx";
import {
	type AppRequestValue,
	appRequestValueSchema,
} from "@ryuhq/core-client/app-request-json.ts";
import { z } from "zod";
import type { DiscussionUser } from "./discussion-collab.ts";

/** Stored rich text is a JSON array, including old and future native node forms.
 * Only the editor-facing reader refines it into Plate's complete Value owner. */
export interface StoredDiscussionComment extends Omit<TComment, "contentRich"> {
	contentRich: AppRequestValue[];
}
export interface StoredDiscussion extends Omit<TDiscussion, "comments"> {
	comments: StoredDiscussionComment[];
}

const storedRichTextFieldsSchema = z.array(appRequestValueSchema);
const storedRichTextSchema = z.custom<AppRequestValue[]>(
	(value) => storedRichTextFieldsSchema.safeParse(value).success
);
export const discussionDateSchema = z
	.string()
	.transform((value) => new Date(value))
	.pipe(z.date());
export const discussionMetadataSchema = z.object({
	createdAt: z.string(),
	documentContent: z.string().optional(),
	id: z.string(),
	isResolved: z.boolean(),
	userId: z.string(),
});
export const storedDiscussionCommentSchema = z.object({
	contentRich: storedRichTextSchema,
	createdAt: discussionDateSchema,
	discussionId: z.string(),
	id: z.string(),
	isEdited: z.boolean(),
	userId: z.string(),
}) satisfies z.ZodType<StoredDiscussionComment>;
// JSON.parse accepts overflowing JSON exponents as infinities. The original
// collaboration user owner accepted every native number, so retain that hue.
const discussionHueSchema = z.union([
	z.number(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);
export const discussionUserSchema = z.object({
	avatarUrl: z.string().optional(),
	hue: discussionHueSchema.optional(),
	id: z.string(),
	name: z.string(),
}) satisfies z.ZodType<DiscussionUser>;
export const discussionJsonTextSchema = z
	.string()
	.transform((value, context): AppRequestValue => {
		try {
			return appRequestValueSchema.parse(JSON.parse(value));
		} catch {
			context.addIssue({
				code: "custom",
				message: "Expected stored discussion JSON",
			});
			return z.NEVER;
		}
	});
