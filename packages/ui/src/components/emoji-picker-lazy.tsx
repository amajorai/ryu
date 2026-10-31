"use client";

import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { preloadableLazy } from "@ryu/ui/lib/preloadable-lazy.tsx";
import type { EmojiPickerProps } from "./emoji-picker.tsx";

// EmojiMart and its full emoji dataset load the first time a picker opens.
const emojiPicker = preloadableLazy<EmojiPickerProps>(() =>
	import("./emoji-picker.tsx").then((module) => module.EmojiPicker)
);

/** The shared emoji picker, loaded on first open behind a picker-sized skeleton. */
export function LazyEmojiPicker(props: EmojiPickerProps) {
	return (
		<emojiPicker.Render
			{...props}
			fallback={<Skeleton className="h-80 w-full" radius="panel" />}
		/>
	);
}
