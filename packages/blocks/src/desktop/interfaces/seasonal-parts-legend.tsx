import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { Check, Snowflake } from "lucide-react";
import { GameLegend } from "./game-hud.tsx";

type LegendKind = "needs" | "opened" | "stopped" | "today" | "working";

/** The marks the number plates carry in the scene, at legend size. */
function LegendGlyph({ kind }: { kind: LegendKind }) {
	if (kind === "today") {
		return (
			<span
				aria-hidden="true"
				className="size-3.5 shrink-0 rounded-full border-(--gk-edge) border-2 outline-(--gk-gold) outline-2 outline-solid"
			/>
		);
	}
	if (kind === "working") {
		return (
			<span
				aria-hidden="true"
				className="font-black text-(--gk-good) text-[11px] tracking-tight"
			>
				•••
			</span>
		);
	}
	if (kind === "stopped") {
		return (
			<Snowflake
				aria-hidden="true"
				className="size-3.5 text-(--gk-ink-muted)"
				strokeWidth={3}
			/>
		);
	}
	if (kind === "opened") {
		return (
			<Check
				aria-hidden="true"
				className="size-3.5 text-(--gk-gold)"
				strokeWidth={3.5}
			/>
		);
	}
	return (
		<span
			aria-hidden="true"
			className="grid size-4 place-items-center rounded-full border-(--gk-edge) border-2 bg-(--gk-bad) font-black text-[10px] text-white leading-none"
		>
			!
		</span>
	);
}

/** What the marks on the board mean, as the game kit's legend plate. */
export function Legend({
	acts = false,
	today,
}: {
	/**
	 * The act layer is on: the marks follow the HUD summary's terms (an
	 * ask needs you, a run is working, a stopped run is frosted shut) and
	 * opened means its answers are read.
	 */
	acts?: boolean;
	/** Today has a door on this board, so its mark needs a key. */
	today: boolean;
}) {
	const items: { kind: LegendKind; label: string }[] = acts
		? [
				{ kind: "needs", label: "Needs you" },
				{ kind: "working", label: "Working" },
				{ kind: "stopped", label: "Failed or stopped" },
				{ kind: "opened", label: "Read" },
			]
		: [
				{ kind: "needs", label: "Needs you" },
				{ kind: "working", label: "Agent working" },
				{ kind: "opened", label: "Opened" },
			];
	if (today) {
		items.push({ kind: "today", label: "Today" });
	}
	return (
		<GameLegend
			items={items.map((item) => ({
				key: item.kind,
				label: item.label,
				mark: (
					<span className="grid h-4 min-w-4 place-items-center">
						<LegendGlyph kind={item.kind} />
					</span>
				),
			}))}
			label="Legend"
		/>
	);
}

export function BoardSkeleton() {
	return (
		<div
			aria-hidden="true"
			className="flex flex-1 items-center justify-center p-8"
			data-seasonal-loading=""
		>
			<div className="relative aspect-[5/3] w-full max-w-5xl">
				<Skeleton
					className="absolute inset-0 bg-(--gk-plate)/40"
					radius="panel"
				/>
			</div>
		</div>
	);
}
