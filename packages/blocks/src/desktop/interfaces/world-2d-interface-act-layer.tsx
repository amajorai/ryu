import { cn } from "@ryu/ui/lib/utils";
import type { InterfacePort, World2dParams } from "@ryuhq/protocol/interfaces";
import type { RefObject } from "react";
import { GAME_PLATE } from "./game-hud.tsx";
import { actSummaryLine, type actTotals } from "./game3d-acts.ts";
import {
	ActAgentList,
	ActAnnouncer,
	AskQueueList,
	BlindSpotCaption,
	NeedYouButton,
	QueueButton,
} from "./interface-ask-card.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import type {
	useActAnnouncement,
	useActClockOptions,
	useActs,
} from "./use-acts.ts";
import type { useTalkingAgent } from "./use-world-controller.ts";
import type { useViewportSize } from "./world-2d-interface-hooks.ts";

type ActsView = ReturnType<typeof useActs>;

/**
 * With acts: the act column beside the village clock, the revealed ask and
 * agent lists, and the act announcer. Siblings of the map (never inside
 * role="application"), so its digit / M / [ / ] / ? keys never see theirs.
 */
export function World2dActLayer({
	acts,
	clock,
	hostPort,
	nowMs,
	onAsk,
	onBlocker,
	queueOpener,
	sentence,
	snapshot,
	talkingAgent,
	totals,
	unowned,
	viewport,
	worldHeadingRef,
}: {
	acts: ActsView["acts"];
	clock: ReturnType<typeof useActClockOptions>;
	hostPort: InterfacePort;
	nowMs: number;
	onAsk: (askId: string, opener?: HTMLElement) => void;
	onBlocker: (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => void;
	queueOpener: RefObject<(() => void) | null>;
	sentence: ReturnType<typeof useActAnnouncement>;
	snapshot: InterfaceRendererProps<World2dParams>["snapshot"];
	talkingAgent: ReturnType<typeof useTalkingAgent>["talkingAgent"];
	totals: ReturnType<typeof actTotals>;
	unowned: ActsView["unowned"];
	viewport: ReturnType<typeof useViewportSize>;
	worldHeadingRef: RefObject<HTMLHeadingElement | null>;
}) {
	return (
		<>
			<h1 className="sr-only" ref={worldHeadingRef} tabIndex={-1}>
				World 2D
			</h1>
			<div
				// While talking the panel takes the right of the stage: the
				// column moves left of it (wide), or steps out (narrow, where
				// the panel covers the map) so nothing hides in the Tab order.
				className={cn(
					"pointer-events-none absolute right-3 z-[450] flex max-w-[calc(100%-24px)] flex-col items-end gap-2",
					talkingAgent &&
						"max-sm:hidden sm:right-[calc(clamp(320px,40%,440px)+12px)] sm:max-w-[calc(60%-24px)]"
				)}
				// Below the village clock.
				style={{ top: viewport.size.width < 760 ? 156 : 184 }}
			>
				<p
					className={cn(
						GAME_PLATE,
						"pointer-events-auto w-fit max-w-full truncate rounded-xl px-3 py-1.5 font-semibold text-[13px]"
					)}
					data-act-summary=""
				>
					{actSummaryLine(totals)}
				</p>
				<div className="pointer-events-auto">
					<BlindSpotCaption snapshot={snapshot} />
				</div>
				<div className="pointer-events-auto flex gap-2">
					<NeedYouButton onAsk={onAsk} snapshot={snapshot} totals={totals} />
					<QueueButton
						acts={acts}
						clock={clock}
						narrow={viewport.size.width < 640}
						nowMs={nowMs}
						onAsk={onAsk}
						onBlocker={onBlocker}
						openRef={queueOpener}
						snapshot={snapshot}
						totals={totals}
						unowned={unowned}
					/>
				</div>
			</div>
			{/* Over the map's HUD (z-400) and the act plate (z-450): a
			    revealed list is never painted under them. */}
			<div className="pointer-events-none absolute inset-0 z-[460] [&_button]:pointer-events-auto [&_ul]:pointer-events-auto">
				<AskQueueList
					acts={acts}
					clock={clock}
					fallbackFocus={worldHeadingRef}
					nowMs={nowMs}
					onAsk={onAsk}
					onBlocker={onBlocker}
					snapshot={snapshot}
					unowned={unowned}
				/>
				<ActAgentList
					acts={acts}
					clock={clock}
					nowMs={nowMs}
					onAsk={onAsk}
					onBlocker={onBlocker}
					onOpenThread={hostPort.openThread}
					revealOnFocus
					snapshot={snapshot}
				/>
			</div>
			<ActAnnouncer sentence={sentence} />
		</>
	);
}
