import { Button } from "@ryu/ui/components/button.tsx";
import { type CSSProperties, useId } from "react";
import {
	CELL_WIDTH,
	type NoticeboardArea,
	noticeboardLayout,
	noticeboardNote,
} from "./noticeboard-model.ts";
import { PushPin } from "./noticeboard-paper.tsx";

/**
 * The board color: a step below the paper in both modes, so notes always sit
 * on top of it (light themes darken muted; dark themes use the page itself).
 */
export const BOARD_SURFACE_CLASS =
	"bg-[color-mix(in_oklab,var(--muted),var(--foreground)_3%)] dark:bg-[color-mix(in_oklab,var(--background),var(--foreground)_2%)]";

/**
 * The board texture: felt-like speckle in the theme's own colors, drawn with
 * three offset dot grids of different pitch so no regular grid shows through.
 */
export const BOARD_SURFACE: CSSProperties = {
	backgroundImage: [
		"radial-gradient(color-mix(in oklab, var(--foreground) 9%, transparent) 0.6px, transparent 1.2px)",
		"radial-gradient(color-mix(in oklab, var(--background) 40%, transparent) 0.7px, transparent 1.3px)",
		"radial-gradient(color-mix(in oklab, var(--foreground) 6%, transparent) 0.9px, transparent 1.6px)",
	].join(", "),
	backgroundAttachment: "local",
	backgroundPosition: "0 0, 3px 5px, 9px 2px",
	backgroundSize: "7px 7px, 11px 11px, 17px 13px",
};

const SKELETON_COUNTS = [1, 4, 2, 2] as const;
const SKELETON_LABEL_WIDTHS = ["w-28", "w-20", "w-16", "w-32"] as const;

function skeletonAreas(): NoticeboardArea[] {
	const statuses = ["attention", "your-turn", "working", "waiting"] as const;
	return statuses.map((status, areaIndex) => ({
		label: status,
		notes: Array.from({ length: SKELETON_COUNTS[areaIndex] ?? 1 }, (_, index) =>
			noticeboardNote(
				{ agents: [], groups: [], threads: [], version: 1 },
				{
					agentIds: [],
					id: `skeleton-${areaIndex}-${index}`,
					lastMessage: null,
					lastMessageRole: null,
					messageCount: 0,
					pinned: false,
					projectId: null,
					running: false,
					teamId: null,
					title: "",
					updatedAt: "",
				}
			)
		),
		status,
	}));
}

/** Blank papers where the notes will land, laid out like the real board. */
export function NoticeboardSkeleton({ width }: { width: number }) {
	const layout = noticeboardLayout(skeletonAreas(), {}, width);
	return (
		<div
			aria-busy="true"
			aria-label="Loading notes"
			className="relative"
			data-testid="noticeboard-skeleton"
			role="status"
			style={{ height: layout.height, width: layout.width }}
		>
			{layout.areas.map((area, index) => (
				<div
					className="absolute flex h-7 items-center gap-3"
					key={area.status}
					style={{ left: area.x, top: area.y, width: area.width }}
				>
					<span
						className={`h-3 rounded-sm bg-foreground/10 ${SKELETON_LABEL_WIDTHS[index] ?? "w-20"}`}
					/>
					<span className="h-px flex-1 bg-foreground/10" />
				</div>
			))}
			{layout.notes.map(({ note, x, y }) => (
				<span
					className="absolute rounded-[3px] bg-card/60 motion-safe:animate-pulse"
					key={note.thread.id}
					style={{
						height: note.size.height,
						left: x,
						top: y,
						transform: `rotate(${note.look.rotation}deg)`,
						width: note.size.width,
					}}
				/>
			))}
		</div>
	);
}

/**
 * Nothing on the board yet: one blank card pinned in the middle that says
 * what the board is for and offers the first note.
 */
export function NoticeboardEmpty({
	hasAgents,
	onPin,
}: {
	hasAgents: boolean;
	onPin: () => void;
}) {
	const titleId = useId();
	return (
		<div
			className="flex min-h-full items-center justify-center p-6"
			data-testid="noticeboard-empty"
		>
			<section
				aria-labelledby={titleId}
				className="relative flex flex-col items-start gap-2 rounded-[3px] bg-card px-6 pt-8 pb-6 text-card-foreground shadow-foreground/15 shadow-md"
				style={{
					maxWidth: CELL_WIDTH + 96,
					transform: "rotate(-1deg)",
				}}
			>
				<PushPin
					className="top-3 left-1/2 -translate-x-1/2"
					status="your-turn"
				/>
				<h2 className="font-semibold text-base leading-6" id={titleId}>
					Nothing pinned yet
				</h2>
				<p className="text-card-foreground/70 text-sm leading-5">
					{hasAgents
						? "Each conversation shows up here as a note, grouped by what it needs from you. Pin one to ask an agent for something."
						: "Add an agent, then pin a note to start a conversation. Each one shows up here, grouped by what it needs from you."}
				</p>
				<Button className="mt-2" onClick={onPin} size="sm">
					Pin a note
				</Button>
			</section>
		</div>
	);
}
