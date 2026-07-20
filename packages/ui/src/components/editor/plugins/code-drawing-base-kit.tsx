import { BaseCodeDrawingPlugin } from "@platejs/code-drawing";

import { CodeDrawingElement } from "@ryu/ui/components/editor/ui/code-drawing-node.tsx";

export const BaseCodeDrawingKit = [
	BaseCodeDrawingPlugin.configure({
		node: { component: CodeDrawingElement },
	}),
];
