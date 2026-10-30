import { Button } from "@ryu/ui/components/button.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceEvent } from "@ryuhq/protocol/interfaces";
import {
	ArrowLeft,
	Check,
	Copy,
	MessageSquareText,
	RotateCcw,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import {
	clockTime,
	exceptionReason,
	expectedLine,
	type HistoryEntry,
	type HistoryTone,
	TRACKING_STAGE_LABELS,
	type TrackingParcel,
	trackingHistory,
} from "./tracking-model.ts";
import { CourierSchedule, ShipmentDetails } from "./tracking-page-details.tsx";
import { TrackingRoute } from "./tracking-route.tsx";

const COPIED_MS = 1600;

function CopyNumber({ value }: { value: string }) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) {
			return;
		}
		const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
		return () => window.clearTimeout(timer);
	}, [copied]);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(value);
			setCopied(true);
		} catch {
			setCopied(false);
		}
	};
	return (
		<Button
			aria-label={copied ? "Tracking number copied" : "Copy tracking number"}
			className="text-muted-foreground"
			onClick={copy}
			size="icon-xs"
			title="Copy tracking number"
			type="button"
			variant="ghost"
		>
			{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
		</Button>
	);
}

const DOT_TONE: Record<HistoryTone, string> = {
	default: "border-foreground/60 bg-background",
	exception: "border-destructive bg-destructive",
	scheduled: "border-muted-foreground bg-background",
	success: "border-status-success bg-status-success",
};

function HistoryRow({
	entry,
	isFirst,
	isLast,
}: {
	entry: HistoryEntry;
	/** First and last scan of the whole history: the rail stops at the dot. */
	isFirst: boolean;
	isLast: boolean;
}) {
	const date = entry.at ? new Date(entry.at) : null;
	const latest = entry.id === "latest";
	return (
		<li className="grid grid-cols-[4.5rem_0.75rem_minmax(0,1fr)] gap-x-3">
			<span className="flex flex-col text-right text-[13px] text-muted-foreground tabular-nums leading-6">
				{date && !Number.isNaN(date.getTime()) ? (
					<time dateTime={entry.at ?? undefined}>{clockTime(date)}</time>
				) : null}
				{entry.estimated && entry.at ? (
					<span title="Projected from the courier's schedule">est.</span>
				) : null}
			</span>
			<span aria-hidden="true" className="relative flex justify-center">
				{isFirst && isLast ? null : (
					<span
						className={cn(
							"absolute w-px bg-border",
							isFirst ? "top-2.5" : "top-0",
							isLast ? "h-2.5" : "bottom-0"
						)}
					/>
				)}
				<span
					className={cn(
						"relative mt-1.25 size-2.5 rounded-full border-2",
						latest && entry.tone === "default"
							? "border-primary bg-primary"
							: DOT_TONE[entry.tone]
					)}
				/>
			</span>
			<div className={cn("flex min-w-0 flex-col gap-0.5", !isLast && "pb-5")}>
				<p
					className={cn(
						"text-sm leading-5",
						latest ? "font-medium text-foreground" : "text-foreground",
						entry.tone === "exception" && "text-status-destructive"
					)}
				>
					{entry.title}
				</p>
				{entry.location ? (
					<p className="text-[13px] text-muted-foreground leading-5">
						{entry.detail
							? `${entry.location} · ${entry.detail}`
							: entry.location}
					</p>
				) : null}
				{entry.detail && !entry.location ? (
					<p className="line-clamp-2 max-w-prose text-[13px] text-muted-foreground leading-5">
						{entry.detail}
					</p>
				) : null}
			</div>
		</li>
	);
}

/** A day heading sitting on the rail between scans. */
function HistoryLabel({ label, rail }: { label: string; rail: boolean }) {
	return (
		<li className="grid grid-cols-[4.5rem_0.75rem_minmax(0,1fr)] gap-x-3">
			<span aria-hidden="true" />
			<span aria-hidden="true" className="relative flex justify-center">
				{rail ? <span className="absolute inset-y-0 w-px bg-border" /> : null}
			</span>
			<h3 className="pb-2 font-medium text-[13px] text-muted-foreground leading-5">
				{label}
			</h3>
		</li>
	);
}

function TrackingHistory({
	events,
	now,
	parcel,
}: {
	events: readonly InterfaceEvent[];
	now: number;
	parcel: TrackingParcel;
}) {
	const headingId = useId();
	const groups = trackingHistory(parcel, events, now);
	const total = groups.reduce((sum, group) => sum + group.entries.length, 0);
	const rows: ReactNode[] = [];
	let seen = 0;
	for (const group of groups) {
		// The rail runs through a heading only once the first scan is above it.
		rows.push(
			<HistoryLabel
				key={`label-${group.id}`}
				label={group.label}
				rail={seen > 0}
			/>
		);
		for (const entry of group.entries) {
			rows.push(
				<HistoryRow
					entry={entry}
					isFirst={seen === 0}
					isLast={seen === total - 1}
					key={`${group.id}-${entry.id}`}
				/>
			);
			seen += 1;
		}
	}
	return (
		<section aria-labelledby={headingId} className="min-w-0">
			<h2
				className="mb-4 font-semibold text-base text-foreground"
				id={headingId}
			>
				Tracking history
			</h2>
			<ol className="flex flex-col">{rows}</ol>
		</section>
	);
}

/** The selected parcel's tracking page. */
export function TrackingPage({
	events,
	isOpen = false,
	now,
	onBack,
	onOpen,
	parcel,
}: {
	events: readonly InterfaceEvent[];
	/** True while this parcel's conversation is open in the panel. */
	isOpen?: boolean;
	now: number;
	/** Set in the stacked (narrow) layout, where the page replaces the list. */
	onBack?: () => void;
	onOpen: (threadId: string) => void;
	parcel: TrackingParcel;
}) {
	const { stage, thread } = parcel;
	const exception = stage === "exception";
	const headlineId = useId();
	return (
		<article
			aria-labelledby={headlineId}
			className="@container mx-auto flex w-full max-w-6xl flex-col gap-8 @3xl:px-10 px-6 py-6 md:px-10 md:py-8"
			data-testid="tracking-page"
		>
			<header className="flex flex-col gap-4">
				{onBack ? (
					<Button
						className="-ml-2 self-start"
						onClick={onBack}
						size="sm"
						type="button"
						variant="ghost-muted"
					>
						<ArrowLeft aria-hidden="true" data-icon="inline-start" />
						My deliveries
					</Button>
				) : null}
				<div className="flex flex-wrap items-start gap-x-6 gap-y-4">
					<div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
						<p className="flex h-6 items-center gap-1.5 text-muted-foreground text-xs">
							<span>Tracking number</span>
							<span className="font-mono text-foreground text-xs tracking-wide">
								{parcel.number}
							</span>
							<CopyNumber value={parcel.number} />
						</p>
						<h1
							className={cn(
								"font-semibold text-3xl tracking-tight",
								exception ? "text-status-destructive" : "text-foreground"
							)}
							id={headlineId}
						>
							{TRACKING_STAGE_LABELS[stage]}
						</h1>
						{exception ? (
							<p className="mt-1 text-pretty text-sm" role="status">
								<span className="font-medium text-foreground">
									{exceptionReason(parcel)}
								</span>
								<span className="text-muted-foreground">
									{" · "}
									{expectedLine(parcel, events, now)}
								</span>
							</p>
						) : (
							<p className="mt-1 text-pretty text-muted-foreground text-sm">
								{expectedLine(parcel, events, now)}
							</p>
						)}
					</div>
					{!isOpen && exception ? (
						<Button
							onClick={() => onOpen(thread.id)}
							title="Open the conversation to run it again"
							type="button"
							variant="outline"
						>
							<RotateCcw aria-hidden="true" data-icon="inline-start" />
							Reschedule
						</Button>
					) : null}
					{isOpen || exception ? null : (
						<Button
							onClick={() => onOpen(thread.id)}
							type="button"
							variant={stage === "delivered" ? "default" : "outline"}
						>
							<MessageSquareText aria-hidden="true" data-icon="inline-start" />
							View conversation
						</Button>
					)}
				</div>
			</header>

			<TrackingRoute parcel={parcel} />

			<div className="grid @2xl:grid-cols-[minmax(0,1fr)_18rem] gap-x-12 gap-y-8 pt-2">
				<TrackingHistory events={events} now={now} parcel={parcel} />
				<div className="flex min-w-0 flex-col gap-8">
					<ShipmentDetails parcel={parcel} />
					<CourierSchedule events={events} now={now} parcel={parcel} />
				</div>
			</div>
		</article>
	);
}

const SKELETON_STEPS = ["placed", "picked", "transit", "out", "delivered"];
const SKELETON_HISTORY = ["first", "second", "third"];

/** Placeholder in the page's own shape, so loading does not reflow. */
export function TrackingPageSkeleton() {
	return (
		<div
			aria-hidden="true"
			className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-6 md:px-10 md:py-8"
			data-testid="tracking-page-skeleton"
		>
			<div className="flex flex-col gap-2">
				<Skeleton className="h-4 w-56" radius="dense" />
				<Skeleton className="h-8 w-64" radius="dense" />
				<Skeleton className="mt-1 h-4 w-80 max-w-full" radius="dense" />
			</div>
			<div className="flex flex-col gap-4">
				<div className="h-12" />
				<ol className="grid grid-cols-5">
					{SKELETON_STEPS.map((step) => (
						<li className="flex flex-col items-center gap-2" key={step}>
							<Skeleton className="size-5" radius="pill" />
							<Skeleton className="h-3 w-16 max-w-[80%]" radius="dense" />
							<Skeleton className="h-3 w-10" radius="dense" />
						</li>
					))}
				</ol>
			</div>
			<div className="grid gap-x-12 gap-y-8 border-border border-t pt-8 md:grid-cols-[minmax(0,1fr)_15rem]">
				<div className="flex flex-col gap-4">
					<Skeleton className="h-4 w-32" radius="dense" />
					{SKELETON_HISTORY.map((row) => (
						<div className="flex gap-3" key={row}>
							<Skeleton className="h-4 w-14 shrink-0" radius="dense" />
							<div className="flex min-w-0 flex-1 flex-col gap-1.5">
								<Skeleton className="h-4 w-full max-w-sm" radius="dense" />
								<Skeleton className="h-3 w-40" radius="dense" />
							</div>
						</div>
					))}
				</div>
				<div className="flex flex-col gap-4">
					<Skeleton className="h-4 w-28" radius="dense" />
					<Skeleton className="h-3 w-16" radius="dense" />
					<Skeleton className="h-4 w-32" radius="dense" />
					<Skeleton className="h-3 w-16" radius="dense" />
					<Skeleton className="h-4 w-40" radius="dense" />
				</div>
			</div>
		</div>
	);
}
