import type { SlateLeafProps } from "platejs/static";
import { SlateLeaf } from "platejs/static";

export function HighlightLeafStatic(props: SlateLeafProps) {
	return (
		<SlateLeaf
			{...props}
			as="mark"
			className="ryu-editor-highlight text-inherit"
		>
			{props.children}
		</SlateLeaf>
	);
}
