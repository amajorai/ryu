import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfacePort,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { Fish, Plus } from "lucide-react";
import type { AquariumActsLayer } from "./aquarium-interface-acts.ts";
import type { SummaryPart } from "./aquarium-interface-summary.ts";
import { GameAction, GameTitlePlate } from "./game-hud.tsx";
import { actSummaryLine } from "./game3d-acts.ts";
import {
	BlindSpotCaption,
	NeedYouButton,
	QueueButton,
} from "./interface-ask-card.tsx";

interface AquariumHeaderProps {
	actsLayer: AquariumActsLayer;
	loading: boolean;
	parts: SummaryPart[];
	port: InterfacePort;
	rootWidth: number;
	snapshot: InterfaceSnapshot;
}

/** The tank's top HUD: its title plate, summary and thread actions. */
export function AquariumHeader({
	actsLayer,
	loading,
	parts,
	port,
	rootWidth,
	snapshot,
}: AquariumHeaderProps) {
	const {
		acts,
		actsOn,
		clock,
		nowMs,
		onAsk,
		onBlocker,
		phone,
		queueOpener,
		tally,
		unowned,
	} = actsLayer;
	return (
		<header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between @min-[672px]:gap-3 gap-2 @min-[672px]:p-4 p-2.5">
			{actsOn ? (
				<div className="flex min-w-0 flex-col items-start gap-2">
					<GameTitlePlate
						compact={rootWidth > 0 && rootWidth < 720}
						icon={<Fish strokeWidth={2.25} />}
						keepStatus
						status={
							<span data-testid="aquarium-summary">
								{actSummaryLine(tally)}
							</span>
						}
						title="Aquarium"
					/>
					<BlindSpotCaption snapshot={snapshot} />
				</div>
			) : (
				<GameTitlePlate
					compact={rootWidth > 0 && rootWidth < 720}
					icon={<Fish strokeWidth={2.25} />}
					status={
						loading ? (
							<Skeleton className="mt-1 h-3 w-40" radius="pill" />
						) : (
							<span className="tabular-nums" data-testid="aquarium-summary">
								{parts.map((part, index) => (
									<span
										// A narrow tank keeps only the live counts.
										className={cn(
											!part.essential && "@max-[620px]:hidden",
											index === 1 && "@max-[620px]:[&>.sep]:hidden"
										)}
										key={part.text}
									>
										{index > 0 ? <span className="sep"> · </span> : null}
										{part.text}
									</span>
								))}
							</span>
						)
					}
					title="Aquarium"
				/>
			)}
			<div
				className={cn(
					"pointer-events-auto flex shrink-0 @min-[672px]:gap-3 gap-2",
					phone ? "flex-col items-end" : "items-start"
				)}
			>
				<GameAction
					compact={rootWidth > 0 && rootWidth < 720}
					disabled={loading}
					icon={<Plus strokeWidth={2.75} />}
					label="New thread"
					onClick={() => port.startThread({})}
				/>
				{actsOn ? (
					<>
						<NeedYouButton onAsk={onAsk} snapshot={snapshot} totals={tally} />
						<QueueButton
							acts={acts}
							clock={clock}
							narrow={phone}
							nowMs={nowMs}
							onAsk={onAsk}
							onBlocker={onBlocker}
							openRef={queueOpener}
							snapshot={snapshot}
							totals={tally}
							unowned={unowned}
						/>
					</>
				) : null}
			</div>
		</header>
	);
}
