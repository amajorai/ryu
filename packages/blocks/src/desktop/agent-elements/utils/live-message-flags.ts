import { z } from "zod";

const nativeTextSchema = z.string();

import { nativeSdkSchemaAdmits } from "./native-sdk-admission.ts";
import {
	type NativeSdkValue,
	nativeSdkObjectSchema,
} from "./native-sdk-observation.ts";

interface NativeFlagPartObservation {
	data?: NativeSdkValue;
	note?: NativeSdkValue;
	type?: NativeSdkValue;
}
const flagPart = z.custom<NativeFlagPartObservation>((value) =>
	nativeSdkSchemaAdmits(nativeSdkObjectSchema, value)
);
export function getFailoverNote(part: NativeSdkValue): string | null {
	const observation = flagPart.safeParse(part);
	if (!observation.success || observation.data.type !== "data-ryu-failover") {
		return null;
	}
	const data = observation.data.data;
	const dataObservation = flagPart.safeParse(data);
	if (!dataObservation.success) {
		return null;
	}
	const note = dataObservation.data.note;
	return nativeSdkSchemaAdmits(nativeTextSchema, note) && note.trim().length > 0
		? note.trim()
		: null;
}
/** A live reactive-failover verdict (`data-ryu-failover`, serde tag "kind"). */
export interface FailoverVerdict {
	/** The agent whose window `resetsAt` names, when Core reports one. */
	agentId?: string;
	kind: "held" | "no_candidate" | "reroute" | "wait";
	note: string | null;
	resetsAt?: string;
}

const FAILOVER_KINDS: ReadonlySet<string> = new Set([
	"held",
	"no_candidate",
	"reroute",
	"wait",
]);

interface NativeFailoverDataObservation {
	agent_id?: NativeSdkValue;
	kind?: NativeSdkValue;
	note?: NativeSdkValue;
	resets_at?: NativeSdkValue;
}
const failoverData = z.custom<NativeFailoverDataObservation>((value) =>
	nativeSdkSchemaAdmits(nativeSdkObjectSchema, value)
);

function optionalText(value: NativeSdkValue): string | undefined {
	return nativeSdkSchemaAdmits(nativeTextSchema, value) && value.trim()
		? value.trim()
		: undefined;
}

/**
 * The verdict a live `data-ryu-failover` part carries, or null. Core never
 * emits `stand`; any kind outside wait / held / reroute / no_candidate reads
 * as null rather than being guessed at.
 */
export function getFailoverVerdict(
	part: NativeSdkValue
): FailoverVerdict | null {
	const observation = flagPart.safeParse(part);
	if (!observation.success || observation.data.type !== "data-ryu-failover") {
		return null;
	}
	const data = failoverData.safeParse(observation.data.data);
	if (!data.success) {
		return null;
	}
	const kind = optionalText(data.data.kind);
	if (!(kind && FAILOVER_KINDS.has(kind))) {
		return null;
	}
	const verdict: FailoverVerdict = {
		kind: kind as FailoverVerdict["kind"],
		note: optionalText(data.data.note) ?? null,
	};
	const agentId = optionalText(data.data.agent_id);
	if (agentId) {
		verdict.agentId = agentId;
	}
	const resetsAt = optionalText(data.data.resets_at);
	if (resetsAt) {
		verdict.resetsAt = resetsAt;
	}
	return verdict;
}

export function isWorkflowRunPart(part: NativeSdkValue): boolean {
	const observation = flagPart.safeParse(part);
	return observation.success && observation.data.type === "data-ryu-workflow";
}
