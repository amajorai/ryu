// Mirrors the focused tab into the terminal title and Herdr metadata. Split out
// of App.tsx.

import type { CliRenderer } from "@opentui/core";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { chatActivity } from "./core/chatActivity.ts";
import { herdrReporter } from "./core/herdr.ts";
import {
	TITLE_SPINNER_INTERVAL_MS,
	terminalTitle,
} from "./core/terminalTitle.ts";

/**
 * Mirror the focused tab into the terminal title (an OSC window-title sequence) and the Herdr pane
 * metadata. The title spinner advances on its own slow tick and the title is
 * written only when its text changes, so streaming never floods the terminal.
 */
export function useShellTitle(renderer: CliRenderer, tabTitle: string | null) {
	const focusedChat = useSyncExternalStore(
		chatActivity.subscribe,
		chatActivity.focused
	);
	const label = focusedChat?.title ?? tabTitle ?? "";
	const streaming = focusedChat?.streaming ?? false;
	const model = focusedChat?.model ?? null;
	const [frame, setFrame] = useState(0);
	useEffect(() => {
		setFrame(0);
		if (!streaming) {
			return;
		}
		const timer = setInterval(
			() => setFrame((value) => value + 1),
			TITLE_SPINNER_INTERVAL_MS
		);
		return () => clearInterval(timer);
	}, [streaming]);
	const title = terminalTitle(label, streaming ? frame : null);
	const written = useRef<string | null>(null);
	useEffect(() => {
		if (written.current === title) {
			return;
		}
		written.current = title;
		renderer.setTerminalTitle(title);
	}, [renderer, title]);
	useEffect(() => {
		if (label) {
			herdrReporter?.reportMetadata({ title: label, model });
		}
	}, [label, model]);
}
