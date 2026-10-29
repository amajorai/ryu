import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { type ReactNode, type RefObject, useContext, useId } from "react";
import { GameAction } from "./game-hud.tsx";
import { compactAge } from "./interface-renderer.ts";
import type { RidesActTrip } from "./rides-acts.tsx";
import {
	type RideTrip,
	tripEta,
	tripHeadline,
	tripWord,
} from "./rides-model.ts";
import {
	RideAvatar,
	RidesActEtas,
	RidesActed,
	RidesActTrips,
} from "./rides-parts.tsx";

/** A trip's word and sentence: the act's when there is one. */
function tripWords(
	trip: RideTrip | undefined,
	actTrip: RidesActTrip | undefined
): { detail: string; status: string } {
	if (actTrip && trip?.stage !== "unassigned") {
		return {
			detail: actTrip.detail,
			status: trip ? tripWord(trip, actTrip) : actTrip.word,
		};
	}
	return trip
		? tripHeadline(trip)
		: { detail: "Your driver is on the way", status: "Requested" };
}

/**
 * The open trip: where it is headed and who is driving, over the host's own
 * conversation surface. Back (or Escape) closes the thread.
 */
export function RidesTrip({
	headingRef,
	onBack,
	threadView,
	trip,
}: {
	headingRef: RefObject<HTMLHeadingElement | null>;
	onBack: () => void;
	threadView: ReactNode;
	trip: RideTrip | undefined;
}) {
	const headingId = useId();
	const actTrips = useContext(RidesActTrips);
	const actTrip = trip ? actTrips?.get(trip.id) : undefined;
	const headline = tripWords(trip, actTrip);
	const acted = useContext(RidesActed);
	const etas = useContext(RidesActEtas);
	// With acts the track only shows a real estimate's progress.
	let eta = trip ? tripEta(trip) : null;
	if (acted) {
		eta = trip ? (etas.get(trip.thread.id)?.label ?? null) : null;
	}
	const enRoute = eta !== null;
	const share = acted
		? (etas.get(trip?.thread.id ?? "")?.share ?? 0)
		: (trip?.progress ?? 0);
	const progress = Math.round(share * 100);
	// With acts a trip is done only when it ended well (not a stop or a limit).
	const done = actTrip
		? actTrip.done
		: trip?.stage === "arrived" || trip?.stage === "completed";
	let trackFill = 0;
	if (enRoute) {
		trackFill = progress;
	} else if (done) {
		trackFill = 100;
	}
	const cancelled = actTrip
		? actTrip.tone === "alert"
		: trip?.stage === "cancelled";
	return (
		<section
			aria-labelledby={headingId}
			className="flex min-h-0 flex-1 flex-col"
		>
			<header className="flex flex-col gap-4 px-4 pt-3 pb-4">
				<div className="flex items-start gap-2">
					<Button
						aria-label="Back to trips"
						className="-ml-2 shrink-0"
						onClick={onBack}
						size="icon-sm"
						variant="ghost"
					>
						<ArrowLeft aria-hidden="true" />
					</Button>
					<h2
						className="line-clamp-2 min-w-0 pt-0.5 font-semibold text-foreground text-lg leading-7 tracking-tight outline-none"
						id={headingId}
						ref={headingRef}
						tabIndex={-1}
					>
						<span className="sr-only">Trip to </span>
						{trip?.thread.title ?? "New conversation"}
					</h2>
				</div>
				<div className="flex flex-col gap-3">
					<div className="flex items-center gap-3">
						<RideAvatar agent={trip?.driver} size={40} />
						<div className="flex min-w-0 flex-1 flex-col gap-0.5">
							<p className="truncate font-medium text-foreground text-sm">
								{trip?.driver?.name ?? "No driver"}
							</p>
							<p
								className={cn(
									"truncate text-[13px]",
									cancelled ? "text-destructive" : "text-muted-foreground"
								)}
							>
								{headline.status}
							</p>
						</div>
						{eta ? (
							<p className="shrink-0 text-right">
								<span className="sr-only">Arriving in about </span>
								<span className="font-semibold text-2xl text-foreground tabular-nums leading-8 tracking-tight">
									{eta}
								</span>
								<span className="text-muted-foreground text-sm"> est.</span>
							</p>
						) : null}
					</div>
					<p className="text-pretty text-muted-foreground text-sm">
						{headline.detail}
					</p>
				</div>
			</header>
			{/* Full-bleed track under the header, as a rider app draws it. The
			    track is always there, so the conversation never shifts. */}
			<div
				aria-hidden={enRoute ? undefined : true}
				aria-label={enRoute ? "Trip progress" : undefined}
				aria-valuemax={enRoute ? 100 : undefined}
				aria-valuemin={enRoute ? 0 : undefined}
				aria-valuenow={enRoute ? progress : undefined}
				className="h-1 shrink-0 bg-border"
				role={enRoute ? "progressbar" : undefined}
			>
				<div
					className="h-full bg-primary transition-[width] duration-1000 ease-linear motion-reduce:transition-none"
					style={{ width: `${trackFill}%` }}
				/>
			</div>
			<div className="min-h-0 flex-1">{threadView}</div>
		</section>
	);
}

/**
 * The selected trip, docked under the lists the way a rider app shows the
 * ride you are watching: the driver, the two stops (you, then where the
 * conversation is headed), the estimate, and Open trip.
 */
export function TripPreview({
	now,
	onOpen,
	trip,
}: {
	now: number;
	onOpen: () => void;
	trip: RideTrip;
}) {
	const tl = useLiteralMessages();
	const acted = useContext(RidesActed);
	const headline = tripWords(trip, useContext(RidesActTrips)?.get(trip.id));
	const etas = useContext(RidesActEtas);
	const eta = acted ? (etas.get(trip.thread.id)?.label ?? null) : tripEta(trip);
	return (
		<section
			aria-label={tl("Selected trip: {tripTitle}", {
				tripTitle: trip.thread.title,
			})}
			className="flex shrink-0 flex-col gap-3 border-(--gk-plate-sunk) border-t-2 px-4 pt-3 pb-4"
			data-testid="rides-trip-preview"
		>
			<div className="flex items-center gap-3">
				<RideAvatar agent={trip.driver} size={40} />
				<div className="flex min-w-0 flex-1 flex-col">
					<p className="gk-display truncate text-(--gk-ink) text-[18px] leading-6">
						{trip.driver?.name ?? "No driver"}
					</p>
					<p className="truncate font-semibold text-(--gk-ink-muted) text-[13px] leading-5">
						{headline.status}
					</p>
				</div>
				{eta ? (
					<p className="shrink-0 text-right">
						<span className="sr-only">Arriving in about </span>
						<span className="gk-display text-(--gk-ink) text-[26px] tabular-nums leading-7">
							{eta}
						</span>
						<span className="font-semibold text-(--gk-ink-muted) text-[13px]">
							{" "}
							est.
						</span>
					</p>
				) : null}
			</div>
			<ol aria-label="Route" className="flex flex-col">
				<li className="flex items-center gap-3">
					<span
						aria-hidden="true"
						className="size-3 shrink-0 rounded-full border-(--gk-ink) border-[3px]"
					/>
					<span className="truncate font-medium text-(--gk-ink-muted) text-sm">
						You
					</span>
				</li>
				<li
					aria-hidden="true"
					className="ms-[5px] h-4 w-0.5 bg-(--gk-plate-sunk)"
				/>
				<li className="flex items-center gap-3">
					<span aria-hidden="true" className="size-3 shrink-0 bg-(--gk-ink)" />
					<span className="truncate font-semibold text-(--gk-ink) text-sm">
						{trip.thread.title}
					</span>
					{acted ? null : (
						<span className="ms-auto shrink-0 text-(--gk-ink-muted) text-[13px] tabular-nums">
							{compactAge(trip.thread.updatedAt, now)}
						</span>
					)}
				</li>
			</ol>
			<GameAction
				icon={<ArrowRight strokeWidth={2.75} />}
				label="Open trip"
				onClick={onOpen}
			/>
		</section>
	);
}
