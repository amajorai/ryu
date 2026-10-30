import type { PreviewRailItem } from "@ryu/ui/components/motion/preview-rail.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useCallback } from "react";
import { isNativeFunction } from "../../lib/native-primitive-observation.ts";
import type { useMessageScrollerFollow } from "./message-scroller-follow.ts";
import type { useMessageScrollerRail } from "./message-scroller-rail-sync.ts";
import type { MessageScrollerBaseScope } from "./message-scroller-scope.ts";

export type UseMessageScrollerViewportInput = MessageScrollerBaseScope &
	ReturnType<typeof useMessageScrollerRail> &
	ReturnType<typeof useMessageScrollerFollow>;

/** Jumping to a rail item, and the scroll viewport element. */
export function useMessageScrollerViewport({
	viewportRef,
	railTargetsRef,
	railItems,
	setActiveRailId,
	setFollowing,
	scrollToEnd,
	reduce,
	programmaticScrollRef,
	scrollTimerRef,
	smooth,
	restViewportProps,
	leaveLiveEdge,
	onViewportKeyDown,
	handleScroll,
	onViewportScroll,
	onViewportTouchStart,
	onViewportWheel,
	setViewportRef,
	contentRef,
	label,
	navigation,
	viewportClassName,
	busy,
	contentInset,
	contentSpacing,
	contentClassName,
	contentProps,
	children,
}: UseMessageScrollerViewportInput) {
	const scrollToRailItem = useCallback(
		(item: PreviewRailItem) => {
			const viewport = viewportRef.current;
			const target = railTargetsRef.current.get(item.id);
			if (!(viewport && target)) {
				return;
			}

			const lastItem = railItems.at(-1)?.id === item.id;
			setActiveRailId(item.id);
			if (lastItem) {
				setFollowing(true);
				scrollToEnd(reduce || !smooth ? "auto" : "smooth");
				return;
			}

			setFollowing(false);
			programmaticScrollRef.current = true;
			const behavior = reduce || !smooth ? "auto" : "smooth";

			if (isNativeFunction(target.scrollIntoView)) {
				target.scrollIntoView({ behavior, block: "center", inline: "nearest" });
			} else if (isNativeFunction(viewport.scrollTo)) {
				const viewportRect = viewport.getBoundingClientRect();
				const targetRect = target.getBoundingClientRect();
				const top =
					viewport.scrollTop +
					targetRect.top -
					viewportRect.top -
					(viewport.clientHeight - targetRect.height) / 2;
				viewport.scrollTo({ top, behavior });
			} else {
				const viewportRect = viewport.getBoundingClientRect();
				const targetRect = target.getBoundingClientRect();
				viewport.scrollTop =
					viewport.scrollTop +
					targetRect.top -
					viewportRect.top -
					(viewport.clientHeight - targetRect.height) / 2;
			}
			if (scrollTimerRef.current) {
				window.clearTimeout(scrollTimerRef.current);
			}
			scrollTimerRef.current = window.setTimeout(
				() => {
					programmaticScrollRef.current = false;
				},
				behavior === "smooth" ? 320 : 0
			);
		},
		[railItems, reduce, scrollToEnd, setFollowing, smooth]
	);

	const viewport = (
		<section
			aria-label={label}
			className={cn(
				"scroll-fade h-full overflow-y-auto overscroll-contain outline-none [overflow-anchor:none] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
				navigation === "rail"
					? "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
					: "[scrollbar-gutter:stable]",
				viewportClassName
			)}
			{...restViewportProps}
			onKeyDown={(event) => {
				if (["ArrowUp", "PageUp", "Home"].includes(event.key)) {
					leaveLiveEdge();
				}
				onViewportKeyDown?.(event);
			}}
			onScroll={(event) => {
				handleScroll();
				onViewportScroll?.(event);
			}}
			onTouchStart={(event) => {
				leaveLiveEdge();
				onViewportTouchStart?.(event);
			}}
			onWheel={(event) => {
				leaveLiveEdge();
				onViewportWheel?.(event);
			}}
			ref={setViewportRef}
		>
			<div
				aria-busy={busy}
				aria-live="polite"
				aria-relevant="additions text"
				className={
					contentInset === "default" && contentSpacing === "default"
						? contentClassName
						: cn(
								contentSpacing === "flush" && "gap-0",
								contentInset === "compact" && "px-0.5 py-1",
								contentInset === "transcript" && "px-3 py-6",
								contentClassName
							)
				}
				ref={contentRef}
				role="log"
				{...contentProps}
			>
				{children}
			</div>
		</section>
	);
	return { scrollToRailItem, viewport } as const;
}
