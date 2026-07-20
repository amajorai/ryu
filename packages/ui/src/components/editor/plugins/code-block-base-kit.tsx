import {
	BaseCodeBlockPlugin,
	BaseCodeLinePlugin,
	BaseCodeSyntaxPlugin,
} from "@platejs/code-block";
import {
	CodeBlockElementStatic,
	CodeLineElementStatic,
	CodeSyntaxLeafStatic,
} from "@ryu/ui/components/editor/ui/code-block-node-static.tsx";
import { all, createLowlight } from "lowlight";

const lowlight = createLowlight(all);

export const BaseCodeBlockKit = [
	BaseCodeBlockPlugin.configure({
		node: { component: CodeBlockElementStatic },
		options: { lowlight },
	}),
	BaseCodeLinePlugin.withComponent(CodeLineElementStatic),
	BaseCodeSyntaxPlugin.withComponent(CodeSyntaxLeafStatic),
];
