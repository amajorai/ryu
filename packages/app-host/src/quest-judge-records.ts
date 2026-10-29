import { z } from "zod";
import { jsonResponseDocumentSchema } from "./json-values.ts";

/** The quests sidecar returns either a completed verdict or an explicit skip.
 * Preserve its original JSON object, including additive sidecar metadata. */
const questJudgeFieldsSchema = z.union([
	z.object({
		confidence: z.number(),
		met: z.boolean(),
		reason: z.string(),
	}),
	z.object({ reason: z.string(), skipped: z.literal(true) }),
]);
export const questJudgeResultSchema = z.custom<
	z.output<typeof questJudgeFieldsSchema>
>(
	(value) =>
		jsonResponseDocumentSchema.safeParse(value).success &&
		questJudgeFieldsSchema.safeParse(value).success
);
export type QuestJudgeResult = z.output<typeof questJudgeResultSchema>;
