import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Plus } from "lucide-react";
import { GalleryCardSkeleton } from "./gallery-card.tsx";
import { GalleryCover } from "./gallery-cover.tsx";
import type { GalleryCoverSpec } from "./gallery-model.ts";

const SAMPLE: GalleryCoverSpec = {
	author: null,
	count: 0,
	excerpt: null,
	group: null,
	groupKind: null,
	hue: 250,
	kind: "quote",
	neutral: true,
	ratio: 1,
	seed: 0,
	speaker: "Agent",
	status: "quiet",
};

/** Three sample covers for the empty board, so it previews what cards look like. */
const PREVIEW_COVERS: readonly GalleryCoverSpec[] = [
	{ ...SAMPLE, count: 12, kind: "stat", ratio: 4 / 3 },
	{
		...SAMPLE,
		excerpt: "Your conversations will gather here.",
		kind: "quote",
		ratio: 5 / 4,
	},
	{
		...SAMPLE,
		group: "Your projects",
		groupKind: "project",
		kind: "poster",
		ratio: 1,
	},
];

const PREVIEW_LAYOUT = [
	{ className: "mt-6 w-20 -rotate-3", key: "a" },
	{ className: "z-10 w-24", key: "b" },
	{ className: "mt-8 w-20 rotate-3", key: "c" },
] as const;

/** No threads at all: a small stack of sample covers and one clear action. */
export function GalleryEmpty({
	agentName,
	onNew,
}: {
	agentName: string | null;
	onNew: () => void;
}) {
	const tl = useLiteralMessages();
	return (
		<div className="flex flex-1 flex-col items-center justify-center px-6 pb-16 text-center">
			<div aria-hidden="true" className="flex items-start -space-x-4">
				{PREVIEW_LAYOUT.map((slot, index) => {
					const cover = PREVIEW_COVERS[index];
					return cover ? (
						<div
							className={`overflow-hidden rounded-xl bg-muted ring-4 ring-background ${slot.className}`}
							key={slot.key}
						>
							<GalleryCover cover={cover} />
						</div>
					) : null;
				})}
			</div>
			<h2 className="mt-8 font-semibold text-base text-foreground">
				No conversations yet
			</h2>
			<p className="mt-1 max-w-xs text-balance text-muted-foreground text-sm">
				Every conversation with an agent becomes a card on this board.
			</p>
			<Button className="mt-6" onClick={onNew} radius="pill">
				<Plus aria-hidden="true" data-icon="inline-start" />
				{agentName
					? tl("Message {agentName}", { agentName })
					: "New conversation"}
			</Button>
		</div>
	);
}

/** Threads exist but the filter hides all of them. */
export function GalleryNoMatch({
	description,
	onClear,
}: {
	description: string;
	onClear: () => void;
}) {
	return (
		<div className="flex flex-1 flex-col items-center justify-center px-6 pb-16 text-center">
			<h2 className="font-semibold text-base text-foreground">No matches</h2>
			<p className="mt-1 max-w-sm text-balance text-muted-foreground text-sm">
				{description}
			</p>
			<Button
				className="mt-6"
				onClick={onClear}
				radius="pill"
				variant="secondary"
			>
				Clear filters
			</Button>
		</div>
	);
}

const SKELETON_COLUMN_KEYS = [
	"col-a",
	"col-b",
	"col-c",
	"col-d",
	"col-e",
	"col-f",
	"col-g",
] as const;
const SKELETON_ROW_KEYS = ["row-a", "row-b", "row-c"] as const;

/** The loading board: the same columns and rhythm as the real one. */
export function GallerySkeleton({
	columnCount,
	gap,
}: {
	columnCount: number;
	gap: number;
}) {
	return (
		<div
			aria-busy="true"
			aria-label="Loading conversations"
			className="flex items-start px-[var(--gallery-inset)] pb-8"
			role="status"
			style={{ gap }}
		>
			{SKELETON_COLUMN_KEYS.slice(0, columnCount).map((columnKey, column) => (
				<div
					className="flex min-w-0 flex-1 flex-col"
					key={columnKey}
					style={{ gap: gap + 8 }}
				>
					{SKELETON_ROW_KEYS.map((rowKey, row) => (
						<GalleryCardSkeleton key={rowKey} seed={column * 2 + row} />
					))}
				</div>
			))}
		</div>
	);
}
