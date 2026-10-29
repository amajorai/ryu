import type { DynamicToolUIPart } from "ai";
import type {
	NativeActionListOperations,
	NativeArtifactActionChoice,
	NativeArtifactActionObservation,
} from "./native-artifact-action-abi.ts";

export type {
	NativeArtifactActionChoice,
	NativeArtifactActionObservation,
} from "./native-artifact-action-abi.ts";
/** Same native UI length/map/field/click stages; every action slot stays opaque. */
export function liveArtifactActionChoices(
	actions: DynamicToolUIPart["input"],
	submit: (text: DynamicToolUIPart["input"]) => void
): NativeArtifactActionChoice[] | undefined {
	// SAFETY: this erased native property/method operation ABI claims no Array or
	// decoded action DTO. It retains the original actions.length/actions.map
	// expressions, receiver, raw callback slots and native missing-method errors.
	if (!actions || (actions as NativeActionListOperations).length === 0) {
		return undefined;
	}
	// SAFETY: same raw native map operation ABI; the local result fields are
	// observed opaque values, not validated id/label/tone claims. No wrapper,
	// boxing/inspection changes the original native method/callback/error phases.
	return (actions as NativeActionListOperations).map((action) => ({
		id: action.id,
		label: action.label,
		tone: action.tone,
		onSelect: () => submit(action.label),
	}));
}
export function findLiveArtifactAction(
	actions: DynamicToolUIPart["input"],
	text: DynamicToolUIPart["input"]
): NativeArtifactActionObservation | undefined {
	if (actions === undefined || actions === null) {
		return undefined;
	}
	// SAFETY: only the original native find property/call ABI is exposed. The
	// original actions.find expression and receiver remain; raw item label reads
	// and return identity keep their native errors without any slot/Array gate.
	return (actions as NativeActionListOperations).find(
		(action) => action.label === text
	);
}
