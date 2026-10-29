import { Button } from "@ryu/ui/components/button.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { Plus } from "lucide-react";
import { BoardAvatar } from "./board-avatar.tsx";
import { CINEMA_GAP } from "./cinema-model.ts";

const ROW_KEYS = ["row-a", "row-b"] as const;
const CARD_KEYS = [
	"card-a",
	"card-b",
	"card-c",
	"card-d",
	"card-e",
	"card-f",
	"card-g",
] as const;

/** Placeholders in the catalogue's own shape while the first load settles. */
export function CinemaSkeleton({
	billboardHeight,
	cardWidth,
	gutter,
	perRow,
}: {
	billboardHeight: number;
	cardWidth: number;
	gutter: number;
	perRow: number;
}) {
	const cards = CARD_KEYS.slice(0, perRow + 1);
	return (
		<div aria-hidden="true" className="flex flex-col overflow-hidden">
			<div
				className="relative flex flex-col justify-end gap-4 bg-muted/40"
				style={{
					height: billboardHeight,
					paddingBottom: 96,
					paddingInline: gutter,
				}}
			>
				<Skeleton className="h-3 w-20" />
				<Skeleton className="h-14 w-[min(480px,70%)]" />
				<Skeleton className="h-4 w-[min(400px,60%)]" />
				<div className="mt-2 flex gap-3">
					<Skeleton className="h-11 w-28 rounded-sm" />
					<Skeleton className="h-11 w-36 rounded-sm" />
				</div>
			</div>
			<div className="-mt-12 flex flex-col gap-8">
				{ROW_KEYS.map((row) => (
					<div className="flex flex-col gap-3" key={row}>
						<Skeleton
							className="h-5 w-40"
							style={{ marginInlineStart: gutter }}
						/>
						<div
							className="flex overflow-hidden"
							style={{ columnGap: CINEMA_GAP, paddingInline: gutter }}
						>
							{cards.map((card) => (
								<Skeleton
									className="aspect-video shrink-0 rounded-sm"
									key={`${row}-${card}`}
									style={{ width: cardWidth }}
								/>
							))}
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

/** No threads at all: an invitation to start one, with each agent a click away. */
export function CinemaEmpty({
	agents,
	onNew,
}: {
	agents: readonly InterfaceAgent[];
	onNew: (agentId: string | null) => void;
}) {
	return (
		<div className="flex min-h-full flex-col items-center justify-center px-6 pt-24 pb-16 text-center">
			<h1 className="text-2xl text-foreground leading-8 tracking-tight">
				<span className="font-semibold">Nothing showing yet</span>
			</h1>
			<p className="mt-2 max-w-md text-balance text-muted-foreground text-sm leading-6">
				Every conversation with your agents becomes a title here. Start one and
				it opens the first row.
			</p>
			{agents.length > 0 ? (
				<ul className="mt-8 flex max-w-xl flex-wrap justify-center gap-2">
					{agents.map((agent) => (
						<li key={agent.id}>
							<Button
								className="gap-2 rounded-sm pr-3 pl-2"
								onClick={() => onNew(agent.id)}
								size="sm"
								type="button"
								variant="outline"
							>
								<BoardAvatar agent={agent} name={agent.name} size={20} />
								{agent.name}
							</Button>
						</li>
					))}
				</ul>
			) : null}
			<Button
				className="mt-6 gap-2 rounded-sm px-5 font-semibold"
				onClick={() => onNew(null)}
				type="button"
			>
				<Plus aria-hidden="true" className="size-4" />
				New thread
			</Button>
		</div>
	);
}
