import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { z } from "zod";
import type { SetModelEnabledInput } from "../src/lib/api/pi-config.ts";

export type AgentModelsJson = z.output<typeof appResponseValueSchema>;
const requestFields = z.looseObject({
	body: appResponseValueSchema,
	method: z.string(),
	path: z.string(),
});
export type AgentModelsRequest = z.output<typeof requestFields>;
const snapshotFields = z.looseObject({
	agentModelOverrides: z.record(z.string(), z.record(z.string(), z.boolean())),
	requests: z.array(requestFields),
});
export const agentModelsSnapshotSchema = z.custom<
	z.output<typeof snapshotFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		snapshotFields.safeParse(value).success
);
export type AgentModelsSnapshot = z.output<typeof agentModelsSnapshotSchema>;
const modelEnabledFields = z.looseObject({
	enabled: z.boolean(),
	model: z.string(),
	provider: z.string(),
}) satisfies z.ZodType<SetModelEnabledInput>;
/** Complete actual SetModelEnabledInput writer, preserving raw request refs. */
export const agentModelsEnabledSchema = z.custom<SetModelEnabledInput>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		modelEnabledFields.safeParse(value).success
);
export const agentModelsBodyStringSchema = z.string();
export interface AgentModelsProofState {
	armFailure: (operation: string) => void;
	refreshAgents: () => Promise<void>;
	releasePendingWrite: () => void;
	requests: AgentModelsRequest[];
	snapshot: () => AgentModelsSnapshot;
}
declare global {
	interface Window {
		__agentModelsSettingsProof?: AgentModelsProofState;
	}
}
