import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import { AnimatePresence, motion } from "motion/react";
import type { RefObject } from "react";
import type { Zone } from "./calendar-interface-hooks.ts";
import type {
	CalendarLayer,
	CalendarScale,
	RunItem,
} from "./calendar-model.ts";
import { CalendarRail } from "./calendar-rail.tsx";

interface CalendarRailOverlayProps {
	activeDayKeys: ReadonlySet<string>;
	closeRailOverlay: (returnFocus: boolean) => void;
	hidden: ReadonlySet<CalendarLayer>;
	miniKey: string;
	newThread: (() => void) | null;
	now: Date;
	onMessage: (agentId: string) => void;
	railOverlay: boolean;
	railOverlayOpen: boolean;
	railOverlayRef: RefObject<HTMLDivElement | null>;
	reduceMotion: boolean;
	runs: readonly RunItem[];
	scale: CalendarScale;
	selectDay: (key: string, zone?: Zone | null) => void;
	selectedKey: string;
	setMiniKey: (key: string) => void;
	snapshot: InterfaceSnapshot;
	todayKey: string;
	toggleLayer: (layer: CalendarLayer) => void;
}

/** The rail opened over the grid when there is no room beside it. */
export function CalendarRailOverlay({
	activeDayKeys,
	closeRailOverlay,
	hidden,
	miniKey,
	newThread,
	now,
	onMessage,
	railOverlay,
	railOverlayOpen,
	railOverlayRef,
	reduceMotion,
	runs,
	scale,
	selectDay,
	selectedKey,
	setMiniKey,
	snapshot,
	todayKey,
	toggleLayer,
}: CalendarRailOverlayProps) {
	return (
		<AnimatePresence>
			{railOverlay && railOverlayOpen ? (
				<motion.div
					animate={{ opacity: 1 }}
					className="absolute inset-0 z-20 flex"
					exit={{ opacity: 0 }}
					initial={reduceMotion ? false : { opacity: 0 }}
					key="rail-overlay"
					transition={{ duration: 0.16 }}
				>
					<motion.div
						animate={{ x: 0 }}
						className="flex h-full shrink-0 border-border border-r bg-background shadow-xl"
						exit={reduceMotion ? {} : { x: -16 }}
						initial={reduceMotion ? false : { x: -16 }}
						ref={railOverlayRef}
						transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
					>
						<CalendarRail
							activeDayKeys={activeDayKeys}
							className="flex"
							hidden={hidden}
							miniKey={miniKey}
							now={now}
							onMessage={onMessage}
							onMiniChange={setMiniKey}
							onNewThread={newThread}
							onSelectDay={(key) => {
								closeRailOverlay(false);
								selectDay(key, "main");
							}}
							onToggleLayer={toggleLayer}
							runs={runs}
							scale={scale}
							selectedKey={selectedKey}
							snapshot={snapshot}
							todayKey={todayKey}
						/>
					</motion.div>
					<button
						aria-label="Close sidebar"
						className="min-w-0 flex-1 cursor-default bg-foreground/15 outline-none dark:bg-background/55"
						onClick={() => closeRailOverlay(true)}
						tabIndex={-1}
						type="button"
					/>
				</motion.div>
			) : null}
		</AnimatePresence>
	);
}
