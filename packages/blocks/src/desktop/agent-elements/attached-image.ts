import { z } from "zod";
import type { AttachedImage } from "./input-bar.tsx";

const attachedImageFieldsSchema = z.object({
	filename: z.string(),
	id: z.string(),
	mimeType: z.string().optional(),
	size: z.number().finite().optional(),
	url: z.string(),
}) satisfies z.ZodType<AttachedImage>;

/** Native attachment events may carry additive host objects such as File or
 * Date metadata. Validate the complete image fields while retaining identity. */
export const attachedImageSchema = z.custom<AttachedImage>(
	(value) => attachedImageFieldsSchema.safeParse(value).success
);
