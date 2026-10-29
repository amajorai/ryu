import type { DynamicToolUIPart } from "ai";
import type { ComponentProps, ExoticComponent, ReactNode } from "react";
import { GenericTool } from "../tools/generic-tool.tsx";

type NativeArtifactGenericToolProps = Omit<
	ComponentProps<typeof GenericTool>,
	"title"
> & { title: DynamicToolUIPart["input"] };
// SAFETY: this is the same installed native memo component, with only the raw
// SDK title argument forwarding ABI exposed. It does not validate or claim a
// title is a string/DTO; its unchanged native UI/React consumers own rendering,
// coercion, warnings and errors. Memo identity, other props and defaults remain.
// SAFETY: same native memo identity; only the opaque SDK title forwarding ABI is exposed.
export const NativeArtifactGenericTool =
	// SAFETY: same installed native component identity; opaque argument ABI only, no decoded DTO claim.
	GenericTool as ExoticComponent<NativeArtifactGenericToolProps>;
export function nativeArtifactReactChild(
	value: DynamicToolUIPart["input"]
): ReactNode {
	// SAFETY: this erased view exposes only the actual native JSX child argument
	// operation. No child/ReactElement brand or value kind is asserted/validated;
	// the exact raw SDK value enters the same React renderer, retaining numeric,
	// opaque element, unsupported value, getter, warning and error behavior.
	return value as ReactNode;
}
