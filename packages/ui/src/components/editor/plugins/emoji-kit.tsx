"use client";

import emojiMartData, { type EmojiMartData } from "@emoji-mart/data";
import { EmojiInputPlugin, EmojiPlugin } from "@platejs/emoji/react";

import { EmojiInputElement } from "@ryu/ui/components/editor/ui/emoji-node.tsx";

export const EmojiKit = [
	EmojiPlugin.configure({
		// SAFETY: @emoji-mart/data 1.2.1 exports its complete sets/15/native.json at runtime;
		// its declaration exports EmojiMartData but omits that actual default value.
		options: { data: emojiMartData as EmojiMartData },
	}),
	EmojiInputPlugin.withComponent(EmojiInputElement),
];
