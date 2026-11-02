"use client";

import emojiMartData from "@emoji-mart/data";
import Picker from "@emoji-mart/react";
import { useEmojiMartLocaleProps } from "./emoji-picker-locale.ts";

export interface EmojiPickerSelection {
	native: string;
}

export interface EmojiPickerProps {
	onEmojiSelect: (emoji: EmojiPickerSelection) => void;
}

/**
 * Shared EmojiMart picker with the product's default presentation settings.
 * Consumers only need to handle the selected native emoji; the picker's own
 * strings follow the UI locale.
 */
export function EmojiPicker({ onEmojiSelect }: EmojiPickerProps) {
	const { i18n, locale } = useEmojiMartLocaleProps();
	return (
		<Picker
			data={emojiMartData}
			dynamicWidth
			emojiButtonSize={32}
			emojiSize={20}
			i18n={i18n}
			key={locale}
			locale={locale}
			maxFrequentRows={1}
			navPosition="bottom"
			onEmojiSelect={onEmojiSelect}
			previewPosition="none"
			skinTonePosition="search"
			theme="auto"
		/>
	);
}
