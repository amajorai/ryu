import { useLiteralMessages } from "@ryu/i18n/react";
import type { PreviewRailItem } from "@ryu/ui/components/motion/preview-rail";
import type React from "react";
import { useEffect, useRef } from "react";
import type { ChatTocItem } from "./chat-toc.tsx";
import { FileTypeIcon } from "./file-type-icon.tsx";
import { nativeSdkCallable } from "./utils/native-dom-observations.ts";

const MAX_PREVIEW_FILES = 4;

/**
 * The rich card the beUI rail shows while hovering a tick. Reuses the exact
 * content of the old left-gutter ChatToc popover — user prompt, agent mark +
 * reply excerpt, files changed — so switching navigation from the bespoke TOC
 * to the beUI PreviewRail keeps every fact, just in a beUI surface.
 */
export function ChatRailPreview({ item }: { item: PreviewRailItem }) {
	const tl = useLiteralMessages();
	// SAFETY: This callback is bound only to this surface's railItems, whose
	// fully typed ChatTocItem[] producer maps each row as data: item. The native
	// non-generic PreviewRail/MessageScroller forwards that same item unchanged;
	// its arbitrary payload slot loses the owned type, not the runtime identity.
	// This erased view retains opaque React avatar fields and the single data
	// getter read; it neither parses JSON nor infers a DTO from partial fields.
	const toc = item.data as ChatTocItem | undefined;
	if (!toc) {
		return (
			<div
				className="w-full rounded-xl border border-border bg-card p-3 shadow-sm"
				data-slot="preview-rail-card"
			>
				<p
					className="font-medium text-card-foreground text-xs"
					data-slot="preview-rail-title"
				>
					{item.label}
				</p>
			</div>
		);
	}
	const extraFiles = (toc.files?.length ?? 0) - MAX_PREVIEW_FILES;
	return (
		<div
			className="w-full rounded-xl border border-border bg-card p-3 shadow-sm"
			data-slot="preview-rail-card"
		>
			<p
				className="line-clamp-2 font-medium text-card-foreground text-xs leading-4"
				data-slot="preview-rail-title"
			>
				{toc.title}
			</p>
			{(toc.description || toc.agentAvatar) && (
				<div className="mt-1.5 flex items-start gap-1.5">
					{toc.agentAvatar ? (
						<span className="mt-0.5 flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted">
							{toc.agentAvatar}
						</span>
					) : null}
					{toc.agentName ? (
						<p className="mb-0.5 text-muted-foreground text-xs leading-3">
							{toc.agentName}
						</p>
					) : null}
					{toc.description ? (
						<p
							className="line-clamp-2 text-muted-foreground text-xs leading-4"
							data-slot="preview-rail-description"
						>
							{toc.description}
						</p>
					) : null}
				</div>
			)}
			{toc.files && toc.files.length > 0 ? (
				<div className="mt-1.5 border-border border-t pt-1.5">
					<ul className="flex flex-col gap-0.5">
						{toc.files.slice(0, MAX_PREVIEW_FILES).map((file) => (
							<li
								className="flex min-w-0 items-baseline justify-between gap-2"
								key={file.name}
							>
								<span className="flex min-w-0 items-center gap-1.5 truncate font-mono text-xs leading-3">
									<FileTypeIcon className="size-3.5" path={file.name} />
									{file.name}
								</span>
								{file.stats ? (
									<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
										{file.stats}
									</span>
								) : null}
							</li>
						))}
					</ul>
					{extraFiles > 0 ? (
						<p className="mt-0.5 text-muted-foreground text-xs">
							{tl("+{extraFiles} more", { extraFiles: String(extraFiles) })}
						</p>
					) : null}
				</div>
			) : null}
		</div>
	);
}

/**
 * Jumps the transcript to the newest message once per conversation.
 *
 * The scroller positions itself at the end when content first arrives, which
 * covers a chat hydrating in front of you (ChatPage loads history *after* mount).
 * What it does not cover is a transcript whose history lands while the surface
 * has NO layout — a tab restored behind `display:none`, or a background pane —
 * because there is nothing to scroll at that moment and the placement is never
 * revisited when the tab is shown. Measured in the chat-scroll story: that case
 * opens ~7200px up, at the very start of the conversation. A wheel/touch/key
 * event during the load has the same effect, dropping the scroller out of its
 * follow-the-bottom mode for good.
 *
 * So the jump is made explicit: try on mount, on hydration, and again whenever
 * the surface gains layout, then stop until the conversation changes so a
 * scrolled-up read is never yanked back down.
 *
 * Rendered above the scroller; scrolls the beUI MessageScroller's viewport,
 * located the same way `usePinnedUserMessage` finds it (by data-slot). Renders
 * nothing.
 */
export function OpenAtBottom({
	containerRef,
	enabled,
	hasMessages,
	conversationKey,
}: {
	containerRef: React.RefObject<HTMLDivElement | null>;
	enabled: boolean;
	hasMessages: boolean;
	conversationKey: string | null;
}) {
	const settledKeyRef = useRef<string | null>(null);

	useEffect(() => {
		if (
			!(enabled && hasMessages && conversationKey) ||
			settledKeyRef.current === conversationKey
		) {
			return;
		}
		const container = containerRef.current;
		if (!container) {
			return;
		}
		const viewport = container.querySelector<HTMLElement>(
			'[data-slot="message-scroller-viewport"]'
		);
		if (!viewport) {
			return;
		}
		let observer: ResizeObserver | null = null;
		const jump = () => {
			// Consult the latch on EVERY pass, not just before installing the
			// observer. Without this the observer — installed only when the first
			// attempt found a zero-height container — keeps firing for the life of
			// the effect and yanks a scrolled-up reader back to the bottom on any
			// resize of the chat container.
			if (settledKeyRef.current === conversationKey) {
				observer?.disconnect();
				return;
			}
			// A surface with no layout yet (a tab still hidden behind `display:none`)
			// would scroll a zero-height viewport and settle on nothing, so wait for
			// the ResizeObserver below to report real height.
			if (container.clientHeight === 0) {
				return;
			}
			if (nativeSdkCallable(viewport.scrollTo)) {
				viewport.scrollTo({ top: viewport.scrollHeight, behavior: "auto" });
			} else {
				viewport.scrollTop = viewport.scrollHeight;
			}
			settledKeyRef.current = conversationKey;
			observer?.disconnect();
		};
		jump();
		if (
			settledKeyRef.current === conversationKey ||
			globalThis.ResizeObserver === undefined
		) {
			return;
		}
		observer = new ResizeObserver(jump);
		observer.observe(container);
		return () => observer?.disconnect();
	}, [containerRef, conversationKey, enabled, hasMessages]);

	return null;
}
