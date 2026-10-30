import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceEvent } from "@ryuhq/protocol/interfaces";
import { type ReactNode, useId } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import {
	clockTime,
	courierRoutines,
	dayLabel,
	type TrackingParcel,
} from "./tracking-model.ts";

function DetailRow({
	label,
	children,
}: {
	children: ReactNode;
	label: string;
}) {
	return (
		<div className="flex flex-col gap-1 py-3 first:pt-0">
			<dt className="text-[13px] text-muted-foreground">{label}</dt>
			<dd className="min-w-0 text-foreground text-sm">{children}</dd>
		</div>
	);
}

const SERVICE_LABEL = { project: "Project", team: "Team" } as const;

export function ShipmentDetails({ parcel }: { parcel: TrackingParcel }) {
	const tl = useLiteralMessages();
	const headingId = useId();
	const { thread } = parcel;
	const title = thread.title.trim() || "Untitled conversation";
	return (
		<section aria-labelledby={headingId} className="min-w-0">
			<h2
				className="mb-4 font-semibold text-base text-foreground"
				id={headingId}
			>
				Shipment details
			</h2>
			<dl className="flex flex-col divide-y divide-border/60">
				<DetailRow label="Courier">
					{parcel.agents.length > 0 ? (
						<ul className="flex flex-col gap-1.5">
							{parcel.agents.map((agent) => (
								<li className="flex min-w-0 items-center gap-2" key={agent.id}>
									<BoardAvatar agent={agent} name={agent.name} size={20} />
									<span className="truncate">{agent.name}</span>
									{agent.status === "working" ? (
										<span className="text-muted-foreground text-xs">
											On a run
										</span>
									) : null}
								</li>
							))}
						</ul>
					) : (
						<span className="text-muted-foreground">No courier assigned</span>
					)}
				</DetailRow>
				<DetailRow label="Contents">
					<span className="flex flex-col gap-0.5">
						<span className="line-clamp-2">{title}</span>
						<span className="text-muted-foreground text-xs">
							{tl(
								"{messageCount, plural, one {# message} other {{messageCountLabel} messages}}",
								{
									messageCount: thread.messageCount,
									messageCountLabel: String(thread.messageCount),
								}
							)}
						</span>
					</span>
				</DetailRow>
				{parcel.service && parcel.serviceKind ? (
					<DetailRow label={SERVICE_LABEL[parcel.serviceKind]}>
						{parcel.service}
					</DetailRow>
				) : null}
			</dl>
		</section>
	);
}

/**
 * The courier's routines, kept apart from the parcel's own scans: they
 * describe the courier's day, not this parcel's journey.
 */
export function CourierSchedule({
	events,
	now,
	parcel,
}: {
	events: readonly InterfaceEvent[];
	now: number;
	parcel: TrackingParcel;
}) {
	const tl = useLiteralMessages();
	const headingId = useId();
	const routines = courierRoutines(parcel, events, now);
	if (!parcel.courier || routines.length === 0) {
		return null;
	}
	return (
		<section aria-labelledby={headingId} className="min-w-0">
			<h2
				className="mb-4 font-semibold text-base text-foreground"
				id={headingId}
			>
				{tl("{name}’s routines", { name: parcel.courier.name })}
			</h2>
			<ul className="flex flex-col divide-y divide-border/60">
				{routines.map((routine) => {
					const date = new Date(routine.at);
					const valid = !Number.isNaN(date.getTime());
					let status = "Completed";
					if (routine.estimated) {
						status = "Next";
					} else if (routine.failed) {
						status = "Failed";
					}
					return (
						<li
							className="flex flex-col gap-0.5 py-2.5 first:pt-0"
							key={routine.id}
						>
							<span className="truncate text-foreground text-sm">
								{routine.title}
							</span>
							<span className="text-muted-foreground text-xs tabular-nums leading-5">
								<span
									className={cn(
										routine.failed && "text-status-destructive",
										routine.estimated && "text-foreground"
									)}
								>
									{status}
								</span>
								{valid ? (
									<>
										{" · "}
										{dayLabel(date, now)},{" "}
										<time dateTime={routine.at}>{clockTime(date)}</time>
										{routine.estimated ? " est." : null}
									</>
								) : null}
							</span>
						</li>
					);
				})}
			</ul>
		</section>
	);
}
