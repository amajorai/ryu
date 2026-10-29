"use client";

import { CopilotPlugin } from "@platejs/ai/react";
import { useElement, usePluginOption } from "platejs/react";

export function GhostText() {
	const element = useElement();

	const isSuggested = usePluginOption(
		CopilotPlugin,
		"isSuggested",
		// SAFETY: Native Copilot isSuggested only compares suggestionNodeId === id.
		// Forward the original identity; this does not prove it is a string.
		element.id as string
	);

	if (!isSuggested) {
		return null;
	}

	return <GhostTextContent />;
}

function GhostTextContent() {
	const suggestionText = usePluginOption(CopilotPlugin, "suggestionText");

	return (
		<span
			className="pointer-events-none text-muted-foreground/70 max-sm:hidden"
			contentEditable={false}
		>
			{suggestionText}
		</span>
	);
}
