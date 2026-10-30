"use client";
import { useMediaQuery } from "@ryu/ui/hooks/use-mobile.ts";
import { cn } from "@ryu/ui/lib/utils";
import { useMemo } from "react";
import { Streamdown } from "streamdown";
import { useChatDisplayPrefs } from "./chat-display-prefs.tsx";
import { linkifyAtMentions } from "./linkify-mentions.ts";
import styles from "./markdown.module.css";
import { formatMentionContent } from "./mention-format.ts";
import { linkifyCitationMarkers } from "./utils/citations.ts";
import "streamdown/styles.css";
import {
	enrichInlineFileReferences,
	fixNumberedListBreaks,
	type MarkdownProps,
	normalizeCodeFenceLanguages,
} from "./markdown-content.ts";
import {
	MARKDOWN_COMPONENTS,
	MarkdownRenderContext,
	type MarkdownRenderContextValue,
	STATIC_PLUGINS,
	STREAMING_PLUGINS,
} from "./markdown-renderers.tsx";

export type { FileReference, MarkdownProps } from "./markdown-content.ts";
export { MarkdownResponseImages } from "./markdown-renderers.tsx";

// Fixed streaming-animation treatment (Streamdown's animate plugin). Word-by-word
// blur-in is the softest of the built-ins; the toggle lives upstream (settings),
// so the config here is a constant, not a lock.
const STREAM_ANIMATION = {
	animation: "blurIn",
	duration: 200,
	sep: "word",
} as const;

export function Markdown({
	mentionItems,
	citations,
	content,
	className,
	fileReferences,
	isAnimating = false,
	isStreaming = false,
	onOpenFile,
	onOpenLink,
	onOpenMention,
	previewResolvers,
	tone = "default",
	wideBlocks = false,
}: MarkdownProps) {
	// Code blocks obey the same "Tool detail" level as tool calls: at anything
	// below Detailed a long block is capped and scrolls in place. The switch is a
	// data attribute rather than a prop on the code plugin because the fenced
	// block is rendered by `@streamdown/code`, not by a component we own — the
	// cap lands in CSS against its stable `data-streamdown` parts (agent-ui.css).
	const { expandCodeBlocks, streamAnimation, animationsEnabled } =
		useChatDisplayPrefs();
	const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
	const animateText =
		streamAnimation &&
		animationsEnabled &&
		!reducedMotion &&
		(isAnimating || isStreaming);
	const safeContent = useMemo(
		() =>
			normalizeCodeFenceLanguages(
				fixNumberedListBreaks(
					linkifyCitationMarkers(
						linkifyAtMentions(
							enrichInlineFileReferences(
								formatMentionContent(content, mentionItems),
								fileReferences
							)
						),
						citations
					)
				)
			),
		[citations, content, fileReferences, mentionItems]
	);
	const renderContext = useMemo<MarkdownRenderContextValue>(
		() => ({
			citations,
			fileReferences,
			mentionItems,
			onOpenFile,
			onOpenLink,
			onOpenMention,
			previewResolvers,
			tone,
			wideBlocks,
		}),
		[
			citations,
			fileReferences,
			mentionItems,
			onOpenFile,
			onOpenLink,
			onOpenMention,
			previewResolvers,
			tone,
			wideBlocks,
		]
	);

	return (
		<div
			className={cn(
				styles.markdown,
				"wrap-break-word overflow-hidden",
				"[&_li>p]:mb-0 [&_li>p]:inline",
				className
			)}
			data-code-detail={expandCodeBlocks ? "full" : "capped"}
			data-ryu-i18n="off"
		>
			<MarkdownRenderContext.Provider value={renderContext}>
				<Streamdown
					animated={animateText ? STREAM_ANIMATION : false}
					components={MARKDOWN_COMPONENTS}
					isAnimating={animateText}
					plugins={isStreaming ? STREAMING_PLUGINS : STATIC_PLUGINS}
				>
					{safeContent}
				</Streamdown>
			</MarkdownRenderContext.Provider>
		</div>
	);
}
