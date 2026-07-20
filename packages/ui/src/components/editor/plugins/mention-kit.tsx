"use client";

import { MentionInputPlugin, MentionPlugin } from "@platejs/mention/react";

import {
	MentionElement,
	MentionInputElement,
} from "@ryu/ui/components/editor/ui/mention-node.tsx";

export const MentionKit = [
	MentionPlugin.configure({
		options: {
			triggerPreviousCharPattern: /^$|^[\s"']$/,
		},
	}).withComponent(MentionElement),
	MentionInputPlugin.withComponent(MentionInputElement),
];
