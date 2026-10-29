// Keyboard transcript scrolling and the reserved "Jump to latest" strip.
//
// The ScrollBoxRenderable exposes no scroll event, so the surface re-reads the
// scroll position after every keyboard scroll, mouse wheel, pointer release,
// and render. Keyboard scrolls go through scrollBy/scrollTo exactly like the
// mouse wheel, so they drop and re-arm stickyScroll the same way.

import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTheme, useUnicode } from "@/components/ui/theme-provider.tsx";
import {
	type AwaySnapshot,
	countNewSinceAway,
	isAwayFromBottom,
	jumpToLatestLabel,
	type TranscriptScrollKind,
	transcriptHalfStep,
	transcriptPageStep,
} from "../../core/transcriptScroll.ts";

/**
 * Maps a key to a transcript scroll, or null. Plain Home/End stay with the
 * composer input (line start/end); only the Ctrl variants move the transcript.
 */
export function transcriptScrollForKey(
	key: Pick<KeyEvent, "ctrl" | "meta" | "name"> &
		Partial<Pick<KeyEvent, "option">>
): TranscriptScrollKind | null {
	// Alt arrives as `option` (kitty / modifyOtherKeys) or as `meta` (ESC prefix).
	const alt = key.meta || key.option === true;
	if (key.name === "pageup") {
		return "pageUp";
	}
	if (key.name === "pagedown") {
		return "pageDown";
	}
	if (key.ctrl && key.name === "home") {
		return "top";
	}
	if (key.ctrl && key.name === "end") {
		return "bottom";
	}
	if (key.ctrl && alt && key.name === "u") {
		return "halfUp";
	}
	if (key.ctrl && alt && key.name === "d") {
		return "halfDown";
	}
	return null;
}

export interface TranscriptScrollState {
	awayFromBottom: boolean;
	newCount: number;
	ref: RefObject<ScrollBoxRenderable | null>;
	scroll: (kind: TranscriptScrollKind) => void;
	sync: () => void;
}

export function useTranscriptScroll<T>(
	messages: readonly T[]
): TranscriptScrollState {
	const ref = useRef<ScrollBoxRenderable | null>(null);
	const [snapshot, setSnapshot] = useState<AwaySnapshot<T> | null>(null);
	const messagesRef = useRef(messages);
	messagesRef.current = messages;

	const sync = useCallback(() => {
		const box = ref.current;
		const away =
			box !== null &&
			isAwayFromBottom({
				scrollHeight: box.scrollHeight,
				scrollTop: box.scrollTop,
				viewportHeight: box.viewport.height,
			});
		setSnapshot((current) => {
			if (!away) {
				return null;
			}
			if (current) {
				return current;
			}
			const latest = messagesRef.current;
			return { last: latest.at(-1), length: latest.length };
		});
	}, []);

	const scroll = useCallback(
		(kind: TranscriptScrollKind) => {
			const box = ref.current;
			if (!box) {
				return;
			}
			const height = box.viewport.height;
			switch (kind) {
				case "pageUp":
					box.scrollBy(-transcriptPageStep(height));
					break;
				case "pageDown":
					box.scrollBy(transcriptPageStep(height));
					break;
				case "halfUp":
					box.scrollBy(-transcriptHalfStep(height));
					break;
				case "halfDown":
					box.scrollBy(transcriptHalfStep(height));
					break;
				case "top":
					box.scrollTo(0);
					break;
				case "bottom":
					box.scrollTo(box.scrollHeight);
					break;
				default:
					break;
			}
			sync();
		},
		[sync]
	);

	// No scroll event exists; re-check after each render so wheel scrolls,
	// scrollbar drags, and content changes all settle the strip.
	useEffect(() => {
		sync();
	});

	return {
		awayFromBottom: snapshot !== null,
		newCount: snapshot ? countNewSinceAway(messages, snapshot) : 0,
		ref,
		scroll,
		sync,
	};
}

/**
 * One reserved row between the transcript and the status line. It stays
 * blank at the bottom so the layout never shifts when it appears.
 */
export function JumpToLatestStrip({
	awayFromBottom,
	newCount,
	onJump,
}: {
	awayFromBottom: boolean;
	newCount: number;
	onJump: () => void;
}) {
	const theme = useTheme();
	const unicode = useUnicode();
	if (!awayFromBottom) {
		// The reserved blank row is the first thing a short terminal gives up,
		// so the composer keeps its border under the shell's clipped main row.
		return <box flexShrink={1} height={1} />;
	}
	return (
		<box
			// Opaque so a transcript row that spills into this one never shows
			// through the label.
			backgroundColor={theme.colors.background}
			flexDirection="row"
			flexShrink={0}
			height={1}
			onMouseDown={onJump}
			paddingLeft={1}
		>
			<text
				fg={newCount > 0 ? theme.colors.primary : theme.colors.mutedForeground}
			>
				{jumpToLatestLabel(newCount, unicode ? "↓" : "v")}
			</text>
		</box>
	);
}
