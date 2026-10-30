import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceParamsByRenderer } from "@ryuhq/protocol/interfaces";
import { CarFront } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { type ActTotals, actSummaryLine } from "./game3d-acts.ts";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { RidesBooking } from "./rides-booking.tsx";
import { SheetHandle } from "./rides-handle.tsx";
import { panelStatus } from "./rides-interface-parts.ts";
import type { DriverOption, RideTrip, SheetTab } from "./rides-model.ts";
import { TripRow } from "./rides-parts.tsx";
import { RidesSheetTabs, type SheetLists } from "./rides-sheet.tsx";
import { RidesTrip, TripPreview } from "./rides-trip.tsx";

/** The rides panel: booking and trip lists, or the open trip. */
export function RidesInterfaceSheet({
	book,
	booking,
	closeTrip,
	counts,
	driverId,
	headingRef,
	inputRef,
	lists,
	loading,
	now,
	openTrip,
	openTripById,
	options,
	peek,
	peekTrip,
	pickDriver,
	pickedDriverId,
	previewTrip,
	prompt,
	reduceMotion,
	selectedTripId,
	setExpanded,
	setPickedDriverId,
	setPreviewTripId,
	setPrompt,
	setTab,
	tab,
	threadOpen,
	threadView,
	totals,
	wide,
	withActs,
}: {
	book: () => void;
	booking: boolean;
	closeTrip: () => void;
	counts: { arrived: number; enRoute: number };
	driverId: string | undefined;
	headingRef: RefObject<HTMLHeadingElement | null>;
	inputRef: RefObject<HTMLTextAreaElement | null>;
	lists: SheetLists;
	loading: boolean;
	now: number;
	openTrip: RideTrip | undefined;
	openTripById: (tripId: string) => void;
	options: DriverOption[];
	peek: boolean;
	peekTrip: RideTrip | undefined;
	pickDriver: (agentId: string) => void;
	pickedDriverId: string | undefined;
	previewTrip: RideTrip | undefined;
	prompt: string;
	reduceMotion: boolean;
	selectedTripId: string | null;
	setExpanded: Dispatch<SetStateAction<boolean>>;
	setPickedDriverId: Dispatch<SetStateAction<string | undefined>>;
	setPreviewTripId: Dispatch<SetStateAction<string | null | undefined>>;
	setPrompt: Dispatch<SetStateAction<string>>;
	setTab: Dispatch<SetStateAction<SheetTab>>;
	tab: SheetTab;
	threadOpen: boolean;
	threadView: InterfaceRendererProps<
		InterfaceParamsByRenderer["rides"]
	>["threadView"];
	totals: ActTotals;
	wide: boolean;
	withActs: boolean;
}) {
	const tl = useLiteralMessages();
	return (
		<aside
			aria-label="Rides"
			className={cn(
				"relative z-30 order-2 @min-[1000px]:m-0 m-2 flex min-h-0 shrink-0 flex-col overflow-hidden rounded-[22px] border-(--gk-edge) border-2 bg-(--gk-plate) text-(--gk-ink) shadow-(--gk-lip)",
				"@min-[1000px]:absolute @min-[1000px]:inset-y-3 @min-[1000px]:left-3 @min-[1000px]:h-auto",
				// On a phone the open trip is a half sheet, as the
				// peeking one: the city above keeps room for its words.
				threadOpen
					? "h-[46%] @min-[1000px]:w-[440px]"
					: "@min-[1000px]:w-[400px]",
				!threadOpen &&
					(peek ? "@min-[1000px]:max-h-none max-h-[46%]" : "h-[64%]")
			)}
		>
			{threadOpen ? null : (
				<SheetHandle
					expanded={!peek}
					onExpandedChange={(next) => {
						setExpanded(next);
						if (!next) {
							setPrompt("");
						}
					}}
				/>
			)}
			{threadOpen ? null : (
				<header className="@min-[1000px]:flex hidden shrink-0 items-center gap-3 px-3 pt-3 pb-2.5">
					<span
						aria-hidden="true"
						className="grid size-11 shrink-0 place-items-center rounded-xl border-(--gk-edge) border-2 bg-(--gk-accent) text-(--gk-accent-ink)"
					>
						<CarFront className="size-6" strokeWidth={2.25} />
					</span>
					<div className="flex min-w-0 flex-col">
						{withActs ? (
							<h2 className="gk-display text-[24px] leading-7">Get a ride</h2>
						) : (
							<h1 className="gk-display text-[24px] leading-7">Get a ride</h1>
						)}
						<p
							className="truncate font-semibold text-(--gk-ink-muted) text-[13px] leading-5"
							data-act-summary={withActs && !loading ? "" : undefined}
						>
							{loading && "Finding drivers…"}
							{!loading && withActs ? actSummaryLine(totals) : null}
							{loading || withActs ? null : panelStatus(counts, tl)}
						</p>
					</div>
				</header>
			)}
			<div className="flex min-h-0 flex-1 flex-col overflow-hidden border-(--gk-plate-sunk) border-t-2">
				{threadOpen ? (
					<RidesTrip
						headingRef={headingRef}
						onBack={closeTrip}
						threadView={threadView}
						trip={openTrip}
					/>
				) : (
					<>
						<div className="flex shrink-0 flex-col gap-3 p-3">
							<RidesBooking
								driverId={driverId}
								inputRef={inputRef}
								onBook={book}
								onDriverChange={setPickedDriverId}
								onPromptChange={setPrompt}
								options={loading ? [] : options}
								prompt={prompt}
								reduceMotion={reduceMotion}
							/>
						</div>
						{/* The lists fade out as the driver picker opens in their
			    place, so the sheet never jumps on the first keystroke. */}
						<AnimatePresence initial={false}>
							{booking ? null : (
								<motion.div
									animate={{ opacity: 1 }}
									className={cn(
										"min-h-0 flex-1 flex-col",
										peek ? "@min-[1000px]:flex hidden" : "flex"
									)}
									exit={{ opacity: 0 }}
									initial={{ opacity: 0 }}
									key="lists"
									transition={{
										duration: reduceMotion ? 0 : 0.15,
										ease: "easeOut",
									}}
								>
									<RidesSheetTabs
										drivers={options}
										lists={lists}
										loading={loading}
										now={now}
										onFocusTrip={setPreviewTripId}
										onOpenTrip={openTripById}
										onPickDriver={pickDriver}
										onTabChange={setTab}
										pickedDriverId={pickedDriverId}
										reduceMotion={reduceMotion}
										selectedTripId={selectedTripId}
										tab={tab}
									/>
								</motion.div>
							)}
						</AnimatePresence>
						{wide && !booking && previewTrip ? (
							<TripPreview
								now={now}
								onOpen={() => openTripById(previewTrip.id)}
								trip={previewTrip}
							/>
						) : null}
						{peek && peekTrip ? (
							<ul
								aria-label="Next trip"
								className="@min-[1000px]:hidden border-border border-t"
							>
								<TripRow
									now={now}
									onFocusTrip={setPreviewTripId}
									onOpen={openTripById}
									selected={peekTrip.id === selectedTripId}
									trip={peekTrip}
									variant="live"
								/>
							</ul>
						) : null}
					</>
				)}
			</div>
		</aside>
	);
}
