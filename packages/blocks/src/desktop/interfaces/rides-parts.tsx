import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import {
	DitherAvatar,
	ditherAvatarSeed,
} from "@ryu/ui/components/dither-kit/avatar.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { createContext, type ReactNode, useContext } from "react";
import { compactAge } from "./interface-renderer.ts";
import type { RidesActTrip, RidesTripTone } from "./rides-acts.tsx";
import {
	availabilityText,
	clockTime,
	type DriverOption,
	type RideTrip,
	tripEta,
	tripWord,
} from "./rides-model.ts";

/**
 * Rows in the sheet: a muted fill marks the trip shown on the map, and an
 * inset ring marks keyboard focus, so the two states never look alike.
 */
export const SHEET_ROW =
	"flex w-full items-center gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

/**
 * The square destination mark, shared by the map's pins and the sheet so
 * both read as the same place. `hollow` punches the pin's centre.
 */
export function DestinationGlyph({
	className,
	hollow = false,
}: {
	className?: string;
	hollow?: boolean;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"flex shrink-0 items-center justify-center rounded-xs",
				className
			)}
		>
			{hollow ? <span className="size-1.5 bg-background" /> : null}
		</span>
	);
}

/**
 * An agent's photo, or a flat initial on a muted disc: the plain driver
 * photo slot of a rider app, in the theme's own tones.
 */
export function RideAvatar({
	agent,
	size,
}: {
	agent: InterfaceAgent | undefined;
	size: 32 | 40;
}) {
	const sizeClass = size === 40 ? "size-10" : "size-8";
	if (!agent) {
		return (
			<span
				aria-hidden="true"
				className={cn(
					"flex shrink-0 items-center justify-center rounded-full bg-muted",
					sizeClass
				)}
			>
				<DestinationGlyph className="size-2.5 bg-muted-foreground/60" />
			</span>
		);
	}
	// The agent's picture, or the generative tile Ryu draws for it elsewhere.
	return (
		<Avatar aria-hidden="true" className={sizeClass}>
			{agent.avatarUrl ? <AvatarImage alt="" src={agent.avatarUrl} /> : null}
			<AvatarFallback appearance="artwork" className="overflow-hidden bg-muted">
				<DitherAvatar
					animate={false}
					className="size-full"
					name={ditherAvatarSeed({ id: agent.id, name: agent.name })}
				/>
			</AvatarFallback>
		</Avatar>
	);
}

/**
 * A driver as a ride option: name, then when they are free and what they
 * do on one line, the way a rider app lists ride types.
 */
export function DriverOptionBody({ option }: { option: DriverOption }) {
	return (
		<>
			<RideAvatar agent={option.agent} size={40} />
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="truncate font-medium text-foreground text-sm">
					{option.agent.name}
				</span>
				<span className="truncate text-[13px] text-muted-foreground">
					<span className={cn(option.available ? null : "text-foreground")}>
						{availabilityText(option)}
					</span>
					{option.agent.description ? ` · ${option.agent.description}` : null}
				</span>
			</span>
		</>
	);
}

type RowVariant = "history" | "live";

const ACT_TONES: Record<RidesTripTone, string> = {
	alert: "text-destructive",
	dim: "text-muted-foreground/70",
	plain: "",
	you: "text-foreground",
};

function tripState(
	trip: RideTrip,
	acted: RidesActTrip | undefined
): { label: string; tone: string } {
	const label = tripWord(trip, acted);
	// A trip whose driver is gone is history, whatever its act said.
	if (acted && trip.stage !== "unassigned") {
		return { label, tone: ACT_TONES[acted.tone] };
	}
	switch (trip.stage) {
		case "arrived":
			return { label, tone: "text-foreground" };
		case "cancelled":
			return { label, tone: "text-destructive" };
		default:
			return { label, tone: "" };
	}
}

/**
 * The act layer is on (a snapshot with `asks`): trip rows show no age or
 * clock time from `updatedAt` (it is not when anything happened), and an
 * ETA only for a routine's run.
 */
export const RidesActed = createContext(false);

/**
 * With the act layer, each trip's ETA by thread: only a routine's run has
 * one, what is left of its estimate (`act.progress`, kind "estimate").
 */
export interface RidesActEta {
	/** "5 min": what is left of the estimate. */
	label: string;
	/** The estimate's done share, 0 to 1. */
	share: number;
}
/** With the act layer, each trip's stage and row word by thread. */
export const RidesActTrips = createContext<ReadonlyMap<
	string,
	RidesActTrip
> | null>(null);

export const RidesActEtas = createContext<ReadonlyMap<string, RidesActEta>>(
	new Map()
);

function ageText(iso: string, now: number): string {
	const age = compactAge(iso, now);
	if (age === "") {
		return "";
	}
	return age === "now" ? "just now" : `${age} ago`;
}

/**
 * One trip in the sheet. Focus (or hover) previews it on the map; pressing
 * it, or Enter, opens the trip. The right-hand column is only ever the ETA
 * of a trip en route (or the clock time in the history); how long ago a
 * trip last moved stays in the meta line, so the two never read alike.
 */
export function TripRow({
	now,
	onFocusTrip,
	onOpen,
	selected,
	trip,
	variant,
}: {
	now: number;
	onFocusTrip: (tripId: string) => void;
	onOpen: (tripId: string) => void;
	selected: boolean;
	trip: RideTrip;
	variant: RowVariant;
}) {
	const acted = useContext(RidesActed);
	const state = tripState(trip, useContext(RidesActTrips)?.get(trip.id));
	const age =
		variant === "live" && !acted ? ageText(trip.thread.updatedAt, now) : "";
	const etas = useContext(RidesActEtas);
	let eta: string | null = null;
	if (variant === "live") {
		eta = acted ? (etas.get(trip.thread.id)?.label ?? null) : tripEta(trip);
	}
	const time =
		variant === "history" && !acted ? clockTime(trip.thread.updatedAt) : "";
	return (
		<li>
			<button
				aria-current={selected ? "true" : undefined}
				className={cn(SHEET_ROW, selected && "bg-muted hover:bg-muted")}
				data-trip-id={trip.id}
				onClick={() => onOpen(trip.id)}
				onFocus={() => onFocusTrip(trip.id)}
				type="button"
			>
				<RideAvatar agent={trip.driver} size={40} />
				<span className="flex min-w-0 flex-1 flex-col gap-0.5">
					{/* The ETA (or clock time) shares the title's baseline. */}
					<span className="flex items-baseline gap-3">
						<span className="min-w-0 flex-1 truncate font-medium text-foreground text-sm">
							{trip.thread.title}
						</span>
						{eta ? (
							<span className="shrink-0 text-sm tabular-nums">
								<span className="font-medium text-foreground">{eta}</span>
								<span className="text-muted-foreground"> est.</span>
							</span>
						) : null}
						{time ? (
							<span className="shrink-0 text-[13px] text-muted-foreground tabular-nums">
								{time}
							</span>
						) : null}
					</span>
					<span className="truncate text-[13px] text-muted-foreground">
						{trip.driver ? `${trip.driver.name} · ` : null}
						<span className={state.tone}>{state.label}</span>
						{age ? ` · ${age}` : null}
					</span>
				</span>
			</button>
		</li>
	);
}

/** A quiet two-line note for an empty list. */
export function SheetEmpty({
	children,
	title,
}: {
	children: ReactNode;
	title: string;
}) {
	return (
		<div className="flex flex-col gap-1 px-4 py-10 text-center">
			<p className="font-medium text-foreground text-sm">{title}</p>
			<p className="text-pretty text-muted-foreground text-sm">{children}</p>
		</div>
	);
}

/** Placeholder rows while the first snapshot loads. */
export function SheetSkeleton() {
	return (
		<ul aria-busy="true" aria-label="Loading trips" className="flex flex-col">
			{["one", "two", "three", "four"].map((key) => (
				<li className="flex items-center gap-3 px-4 py-3" key={key}>
					<Skeleton className="size-10 rounded-full" />
					<span className="flex flex-1 flex-col gap-2">
						<Skeleton className="h-3.5 w-3/5" />
						<Skeleton className="h-3 w-2/5" />
					</span>
					<Skeleton className="h-3.5 w-10" />
				</li>
			))}
		</ul>
	);
}
