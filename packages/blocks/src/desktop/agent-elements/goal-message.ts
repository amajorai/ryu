import {
	isNativeNumber,
	isNativeObjectLike,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import type { UIMessage } from "ai";
import { z } from "zod";
import { nativeSdkSchemaAdmits } from "./utils/native-sdk-admission.ts";

/** The durable completion data shown beside the assistant's final turn. */
export interface GoalCompletion {
	achievedAt?: number;
	messageId?: string;
	startedAt?: number;
}

/** Metadata attached to a client-authored message that sets or edits a goal. */
export interface GoalMessageMetadata {
	goal?: boolean;
}

/** Format an elapsed goal duration in the compact style used by the transcript. */
export function formatGoalElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const seconds = totalSeconds % 60;
	const minutes = Math.floor(totalSeconds / 60) % 60;
	const hours = Math.floor(totalSeconds / 3600);

	if (hours > 0) {
		return `${hours}h${minutes > 0 ? ` ${minutes}m` : ""}${seconds > 0 ? ` ${seconds}s` : ""}`;
	}
	if (minutes > 0) {
		return `${minutes}m${seconds > 0 ? ` ${seconds}s` : ""}`;
	}
	return `${seconds}s`;
}

/** Resolve the fixed duration at completion, or the live duration for legacy state. */
export function getGoalElapsedMs(
	completion: GoalCompletion,
	now = Date.now()
): number | null {
	if (
		!(
			isNativeNumber(completion.startedAt) &&
			Number.isFinite(completion.startedAt)
		)
	) {
		return null;
	}
	const end =
		isNativeNumber(completion.achievedAt) &&
		Number.isFinite(completion.achievedAt)
			? completion.achievedAt
			: now;
	return Math.max(0, end - completion.startedAt);
}

/** Consumed metadata flag, not a full SDK metadata DTO. The native SDK owns
 * opaque values; the existing business comparison admits only literal true. */
interface GoalMetadataObservation {
	goal?: UIMessage["metadata"];
}
const goalMetadataObservationSchema =
	z.custom<GoalMetadataObservation>(isNativeObjectLike);

/** True when a user message represents a goal-setting action. */
export function isGoalMessage(message: UIMessage): boolean {
	const metadata = message.metadata;
	if (!nativeSdkSchemaAdmits(goalMetadataObservationSchema, metadata)) {
		return false;
	}
	return metadata.goal === true;
}
