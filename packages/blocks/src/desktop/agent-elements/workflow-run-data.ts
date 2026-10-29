import {
	isNativeObjectLike,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";
import { nativeSdkSchemaAdmits } from "./utils/native-sdk-admission.ts";
import type {
	NativeSdkValue,
	RenderedMessage,
} from "./utils/native-sdk-observation.ts";

export interface WorkflowNodeProgress {
	error?: string | null;
	id: string;
	kind?: string | null;
	output?: string | null;
	status: "pending" | "running" | "completed" | "failed" | "skipped";
}

export interface WorkflowRunProgress {
	/** Stable part id — every frame re-emits this so the SDK reconciles in place. */
	id: string;
	nodes: WorkflowNodeProgress[];
	runId: string;
	status: "running" | "completed" | "failed" | "awaiting_input";
	workflowId: string;
	workflowName: string;
}

/** Raw cells from route_workflow_chat_stream's complete run/node publishers.
 * Admission below checks every known field; additional native metadata stays
 * on the original receiver rather than being stripped or cloned. */
interface WorkflowFrameObservation {
	error?: NativeSdkValue;
	id?: NativeSdkValue;
	kind?: NativeSdkValue;
	nodes?: NativeSdkValue;
	output?: NativeSdkValue;
	runId?: NativeSdkValue;
	status?: NativeSdkValue;
	workflowId?: NativeSdkValue;
	workflowName?: NativeSdkValue;
}
const workflowFrameObservationSchema =
	z.custom<WorkflowFrameObservation>(isNativeObjectLike);
function isRecord(value: NativeSdkValue): value is WorkflowFrameObservation {
	return nativeSdkSchemaAdmits(workflowFrameObservationSchema, value);
}
function isOptionalNodeText(value: NativeSdkValue): boolean {
	return value === undefined || value === null || isNativeText(value);
}

function isWorkflowNodeProgress(
	value: NativeSdkValue
): value is WorkflowNodeProgress {
	if (!isRecord(value)) {
		return false;
	}
	return (
		isNativeText(value.id) &&
		(value.status === "pending" ||
			value.status === "running" ||
			value.status === "completed" ||
			value.status === "failed" ||
			value.status === "skipped") &&
		isOptionalNodeText(value.error) &&
		isOptionalNodeText(value.kind) &&
		isOptionalNodeText(value.output)
	);
}

export function isWorkflowRunProgress(
	value: NativeSdkValue
): value is WorkflowRunProgress {
	if (!isRecord(value)) {
		return false;
	}
	return (
		isNativeText(value.id) &&
		isNativeText(value.runId) &&
		isNativeText(value.workflowId) &&
		isNativeText(value.workflowName) &&
		(value.status === "running" ||
			value.status === "completed" ||
			value.status === "failed" ||
			value.status === "awaiting_input") &&
		Array.isArray(value.nodes) &&
		value.nodes.every(isWorkflowNodeProgress)
	);
}

/** The latest `data-ryu-workflow` snapshot on a message, or null. */
export function extractWorkflowRun(
	msg: Pick<RenderedMessage, "parts">
): WorkflowRunProgress | null {
	const parts = msg.parts ?? [];
	for (const part of parts) {
		if (part.type !== "data-ryu-workflow" || !part.data) {
			continue;
		}
		const data = Array.isArray(part.data) ? part.data.at(-1) : part.data;
		if (isWorkflowRunProgress(data)) {
			return data;
		}
	}
	return null;
}
