"use client";

import { SlashInputPlugin, SlashPlugin } from "@platejs/slash-command/react";
import { SlashInputElement } from "@ryu/ui/components/editor/ui/slash-node.tsx";
import { KEYS, type SlateEditor } from "platejs";

export const SlashKit = [
	SlashPlugin.configure({
		options: {
			triggerQuery: (editor: SlateEditor) =>
				!editor.api.some({
					match: { type: editor.getType(KEYS.codeBlock) },
				}),
		},
	}),
	SlashInputPlugin.withComponent(SlashInputElement),
];
