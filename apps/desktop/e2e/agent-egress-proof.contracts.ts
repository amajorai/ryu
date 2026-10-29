import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { z } from "zod";

export type AgentEgressJson = z.output<typeof appResponseValueSchema>;
const capturedRequestFields = z.looseObject({
	authorization: z.string().nullable(),
	body: appResponseValueSchema,
	method: z.string(),
	path: z.string(),
	status: z.number().nullable(),
});
export type AgentEgressCapturedRequest = z.output<typeof capturedRequestFields>;
const snapshotFields = z.looseObject({
	preferences: z.record(z.string(), z.string()),
	requests: z.array(capturedRequestFields),
});
/** Complete local snapshot writer, retaining raw future fields and nested refs. */
export const agentEgressSnapshotSchema = z.custom<
	z.output<typeof snapshotFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		snapshotFields.safeParse(value).success
);
export type AgentEgressSnapshot = z.output<typeof agentEgressSnapshotSchema>;
// Complete native preferences PUT writer. Invalid values retain the original 400
// response rather than becoming a transport exception or a coerced string.
export const agentEgressPreferenceWriteSchema = z.object({ value: z.string() });
export const agentEgressBodyStringSchema = z.string();
export interface AgentEgressProofState {
	failNextWrite: (path: string) => void;
	holdNextWrite: (path: string) => void;
	releaseHeldWrite: (failed: boolean) => void;
	setReadFailure: (failed: boolean) => void;
	snapshot: () => AgentEgressSnapshot;
}
declare global {
	interface Window {
		__agentEgressProof?: AgentEgressProofState;
	}
}
