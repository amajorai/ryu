import {
	ToolApprovalActions,
	type ToolApprovalActionsProps,
} from "@ryu/ui/components/agents/tool-approval.tsx";
import type { DynamicToolUIPart } from "ai";
/** Raw optional field observations; these are not ArtifactAction DTOs. Native
 * required lookup on null/undefined may still throw at the original read. */
export interface NativeArtifactActionObservation {
	id?: DynamicToolUIPart["input"];
	label?: DynamicToolUIPart["input"];
	tone?: DynamicToolUIPart["input"];
}
export interface NativeArtifactActionChoice {
	id: DynamicToolUIPart["input"];
	label: DynamicToolUIPart["input"];
	onSelect: () => void;
	tone: DynamicToolUIPart["input"];
}
export interface NativeActionListOperations {
	find(
		callback: (value: NativeArtifactActionObservation) => boolean
	): NativeArtifactActionObservation | undefined;
	readonly length: DynamicToolUIPart["input"];
	map(
		callback: (
			value: NativeArtifactActionObservation
		) => NativeArtifactActionChoice
	): NativeArtifactActionChoice[];
}
type NativeApprovalOperationProps = Omit<
	ToolApprovalActionsProps,
	"choices"
> & { choices: NativeArtifactActionChoice[] };
// SAFETY: this is the same installed native UI function, with only its argument
// forwarding ABI exposed. The Rust render dispatcher validates kind/content,
// not action slots; the existing UI operation consumes raw React labels, React
// keys and tone lookup values. This does not decode or claim full validated
// ToolApprovalChoice DTOs. The same function/props/children/errors are retained;
// React and the actual native UI code perform their original consumed reads.
// SAFETY: same installed UI operation; raw argument forwarding only, not a validated choice DTO.
export const NativeToolApprovalActions =
	// SAFETY: same installed native component identity; opaque argument ABI only, no decoded DTO claim.
	ToolApprovalActions as (
		props: NativeApprovalOperationProps
	) => ReturnType<typeof ToolApprovalActions>;
