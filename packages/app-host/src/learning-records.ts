import { z } from "zod";
import { jsonResponseValueSchema } from "./json-values.ts";

/** These are the complete Core learning DTOs forwarded by the trusted host.
 * Validate additional JSON metadata while retaining the original object. */
function preserveLearningResponse<S extends z.ZodObject>(schema: S) {
	return z.custom<z.output<S>>((value) => {
		const parsed = schema
			.catchall(jsonResponseValueSchema.optional())
			.safeParse(value);
		if (!parsed.success) {
			return false;
		}
		const prototypeEntry = Object.getOwnPropertyDescriptor(value, "__proto__");
		return (
			!prototypeEntry ||
			jsonResponseValueSchema.optional().safeParse(prototypeEntry.value).success
		);
	});
}

export const learningConfigSchema = preserveLearningResponse(
	z.object({
		base_model: z.string().nullable(),
		enabled: z.boolean(),
		min_reward: z.number(),
		prm_model: z.string(),
		prm_via_byo: z.boolean(),
		skill_generation: z.number(),
		skills_enabled: z.boolean(),
		synth_model: z.string(),
	})
);
export type LearningConfigRecord = z.output<typeof learningConfigSchema>;

export const learningExperienceSchema = preserveLearningResponse(
	z.object({
		agent_id: z.string().nullable(),
		assistant_text: z.string(),
		base_model: z.string().nullable(),
		conversation_id: z.string(),
		excluded: z.boolean(),
		id: z.string(),
		outcome: z.string(),
		reward: z.number().nullable(),
		skill_generation: z.number(),
		user_text: z.string(),
	})
);
export type LearningExperience = z.output<typeof learningExperienceSchema>;

export const learningExperienceListSchema = preserveLearningResponse(
	z.object({
		experiences: z.array(learningExperienceSchema),
		min_reward: z.number(),
		scored: z.number(),
		total: z.number(),
		trainable: z.number(),
	})
);
export type LearningExperienceRecord = z.output<
	typeof learningExperienceListSchema
>;

export const learningHealAttemptSchema = preserveLearningResponse(
	z.object({
		count: z.number(),
		given_up: z.boolean(),
		last_at: z.number(),
	})
);
export type LearningHealAttempt = z.output<typeof learningHealAttemptSchema>;

const healingAttemptsFieldsSchema = z.record(
	z.string(),
	learningHealAttemptSchema
);
const healingAttemptsSchema = z.custom<
	z.output<typeof healingAttemptsFieldsSchema>
>((value) => {
	const parsed = healingAttemptsFieldsSchema.safeParse(value);
	if (!parsed.success) {
		return false;
	}
	// The original map retains this entry even though Zod omits it from outputs.
	const prototypeEntry = Object.getOwnPropertyDescriptor(value, "__proto__");
	return (
		!prototypeEntry ||
		learningHealAttemptSchema.safeParse(prototypeEntry.value).success
	);
});
export const learningHealingStatusSchema = preserveLearningResponse(
	z.object({
		attempts: healingAttemptsSchema,
	})
);
export type LearningHealingRecord = z.output<
	typeof learningHealingStatusSchema
>;
