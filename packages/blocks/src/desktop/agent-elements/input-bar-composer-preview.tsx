"use client";

import { Globe02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { EASE_OUT } from "@ryu/ui/lib/ease";
import { cn } from "@ryu/ui/lib/utils";
import { motion } from "motion/react";
import type { ReactNode, RefObject } from "react";
import { useCallback, useRef } from "react";
import { findMentionAt } from "./mention-format.ts";
import { MentionToken } from "./mention-token.tsx";
import type { MentionItem } from "./types.ts";
import { useComposerTokenDrag } from "./use-composer-token-drag.ts";

/**
 * The overlay painted behind the transparent textarea text: mention chips,
 * URL tokens, and the drop gap opened while a chip is dragged.
 */
export function useComposerPreview({
	disabled,
	input,
	mentionItems,
	reduceMotion,
	setInput,
	textareaRef,
}: {
	disabled?: boolean;
	input: string;
	mentionItems: MentionItem[] | undefined;
	reduceMotion: boolean;
	setInput: (v: string) => void;
	textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
	const composerPreviewRef = useRef<HTMLDivElement>(null);
	const tokenDrag = useComposerTokenDrag({
		enabled: !disabled,
		input,
		overlayRef: composerPreviewRef,
		setInput,
		textareaRef,
	});
	const draggingTokenStart = tokenDrag.draggingStart;
	const tokenDropGap = tokenDrag.dropGap;
	const renderComposerPreview = useCallback((): ReactNode[] => {
		const parts: ReactNode[] = [];
		let cursor = 0;
		// While a chip is dragged, the text after its landing spot slides aside
		// to open a chip-wide gap there (the textarea's own text is transparent,
		// so only this overlay reflows).
		let gapPending = tokenDropGap !== null;
		const pushGapAt = (position: number) => {
			if (!(gapPending && tokenDropGap?.index === position)) {
				return;
			}
			gapPending = false;
			parts.push(
				<motion.span
					animate={{ width: tokenDropGap.width }}
					aria-hidden="true"
					className="inline-block h-[1em] align-[-0.125em]"
					data-slot="composer-token-drop-gap"
					initial={{ width: 0 }}
					key={`gap-${position}`}
					transition={
						reduceMotion ? { duration: 0 } : { duration: 0.18, ease: EASE_OUT }
					}
				/>
			);
		};
		// Text runs and chips carry their draft offsets so a dragged chip can be
		// hit-tested and dropped by measuring this overlay's layout.
		const pushRun = (start: number, end: number) => {
			if (end > start) {
				parts.push(
					<span data-composer-text-start={start} key={`text-${start}`}>
						{input.slice(start, end)}
					</span>
				);
			}
		};
		const pushText = (start: number, end: number) => {
			const gapIndex = tokenDropGap?.index ?? -1;
			if (gapPending && gapIndex >= start && gapIndex < end) {
				pushRun(start, gapIndex);
				pushGapAt(gapIndex);
				pushRun(gapIndex, end);
				return;
			}
			pushRun(start, end);
		};
		for (let index = 0; index < input.length; index += 1) {
			const mention = findMentionAt(input, index, mentionItems);
			const isUrl =
				(index === 0 || /\s/.test(input[index - 1] ?? "")) &&
				/^https?:\/\//i.test(input.slice(index));
			if (!(mention || isUrl)) {
				continue;
			}
			const end = mention
				? mention.end
				: (() => {
						let urlEnd = index;
						while (urlEnd < input.length && !/\s|</.test(input[urlEnd] ?? "")) {
							urlEnd += 1;
						}
						return urlEnd;
					})();
			pushText(cursor, index);
			pushGapAt(index);
			const token = input.slice(index, end);
			parts.push(
				mention?.item ? (
					<span
						className={cn(
							"transition-opacity",
							draggingTokenStart === index && "opacity-40"
						)}
						data-composer-token-end={end}
						data-composer-token-start={index}
						key={`${index}-${token}`}
					>
						<MentionToken item={mention.item}>
							{mention.item.label}
						</MentionToken>
					</span>
				) : (
					<span className="font-medium text-primary" key={`${index}-${token}`}>
						<HugeiconsIcon
							aria-hidden="true"
							className="mr-1 inline-flex size-3.5 align-[-2px]"
							icon={Globe02Icon}
						/>
						{token}
					</span>
				)
			);
			cursor = end;
			index = end - 1;
		}
		pushText(cursor, input.length);
		pushGapAt(input.length);
		return parts;
	}, [draggingTokenStart, input, mentionItems, reduceMotion, tokenDropGap]);

	return { composerPreviewRef, renderComposerPreview, tokenDrag };
}
