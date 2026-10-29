import { z } from "zod";

export const fixtureJsonSchema = z.json();
export type FixtureJson = z.infer<typeof fixtureJsonSchema>;
export const fixtureRecordSchema = z.record(z.string(), fixtureJsonSchema);
export type FixtureRecord = z.infer<typeof fixtureRecordSchema>;
const fixtureTextPartSchema = z
	.object({ type: z.literal("text"), text: z.string() })
	.catchall(fixtureJsonSchema);
export const mergedBodyFields = new Set([
	"agent_id",
	"conversation_id",
	"enable_long_term",
	"messages",
]);
export const mergedFixtureChatSchema = fixtureRecordSchema
	.refine((body) => Object.keys(body).every((key) => mergedBodyFields.has(key)))
	.pipe(
		z.strictObject({
			agent_id: z.literal("agent-reviewer"),
			conversation_id: z.string().min(1),
			enable_long_term: z.literal(false),
			messages: z
				.array(
					z
						.object({
							role: z.enum(["user", "assistant"]),
							content: z.tuple([fixtureTextPartSchema]),
						})
						.catchall(fixtureJsonSchema)
				)
				.min(1),
		})
	);
/** Body of the CLI's `POST /api/chat/cancel`: Stop cancels the persisted turn on Core. */
export const mergedFixtureCancelSchema = z.strictObject({
	conversation_id: z.string().min(1),
});
export const herdrFixtureChatSchema = z
	.object({
		conversation_id: z.string(),
		messages: z.array(fixtureJsonSchema),
	})
	.catchall(fixtureJsonSchema);
export const herdrFixtureTurnSchema = z
	.object({ content: z.array(fixtureJsonSchema) })
	.catchall(fixtureJsonSchema);
export const herdrFixturePromptSchema = z
	.object({ text: z.string() })
	.catchall(fixtureJsonSchema);
export function parseFixtureJson(raw: string): FixtureJson {
	const parsed = JSON.parse(raw);
	fixtureJsonSchema.parse(parsed);
	// SAFETY: JSON.parse produced the value and the JSON schema validated its JSON contract; retaining it preserves original own keys for the strict routing guard.
	return parsed as FixtureJson;
}
