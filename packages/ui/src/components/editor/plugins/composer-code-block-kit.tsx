"use client";

// The chat composer's code blocks. Same plugins as CodeBlockKit, but the
// highlight.js grammars load after first paint instead of with the composer:
// the composer is on the default route, and the full grammar set is the
// largest single dependency it would otherwise pull into startup. Blocks render
// as plaintext until the grammars arrive (see lazy-lowlight.ts).

import { CodeBlockRules } from "@platejs/code-block";
import {
	CodeBlockPlugin,
	CodeLinePlugin,
	CodeSyntaxPlugin,
} from "@platejs/code-block/react";
import {
	lazyLowlight,
	preloadLowlight,
} from "@ryu/ui/components/editor/plugins/lazy-lowlight.ts";
import {
	CodeBlockElement,
	CodeLineElement,
	CodeSyntaxLeaf,
} from "@ryu/ui/components/editor/ui/code-block-node.tsx";

preloadLowlight();

export const ComposerCodeBlockKit = [
	CodeBlockPlugin.configure({
		inputRules: [CodeBlockRules.markdown({ on: "match" })],
		node: { component: CodeBlockElement },
		options: { lowlight: lazyLowlight },
		shortcuts: { toggle: { keys: "mod+alt+8" } },
	}),
	CodeLinePlugin.withComponent(CodeLineElement),
	CodeSyntaxPlugin.withComponent(CodeSyntaxLeaf),
];
