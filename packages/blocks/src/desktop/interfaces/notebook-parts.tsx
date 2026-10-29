import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import {
	DitherAvatar,
	ditherAvatarSeed,
} from "@ryu/ui/components/dither-kit/avatar.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceAgent,
	THREAD_STATUS_LABELS,
	type ThreadStatus,
} from "@ryuhq/protocol/interfaces";
import { FileText } from "lucide-react";

/**
 * An agent's picture, or Ryu's dither tile seeded by id. Notion's page and
 * person icons are rounded squares, so `shape="tile"` squares the corners.
 * Decorative: the surrounding row or property names the agent.
 */
export function NotebookAgentArt({
	agent,
	className,
	shape = "round",
}: {
	agent: InterfaceAgent | undefined;
	className?: string;
	shape?: "round" | "tile";
}) {
	const seed = ditherAvatarSeed({ id: agent?.id, name: agent?.name ?? "?" });
	const radius = shape === "tile" ? "rounded-[22%]" : "rounded-full";
	return (
		<Avatar
			aria-hidden="true"
			className={cn(
				"size-5 before:hidden",
				radius,
				shape === "tile" && "*:rounded-[inherit]",
				className
			)}
		>
			{agent?.avatarUrl ? <AvatarImage alt="" src={agent.avatarUrl} /> : null}
			<AvatarFallback
				appearance="artwork"
				className={cn("overflow-hidden bg-muted", radius)}
			>
				<DitherAvatar animate={false} className="size-full" name={seed} />
			</AvatarFallback>
		</Avatar>
	);
}

/**
 * A page's icon: Notion's plain document, bare above the title with no tile,
 * one look for every page so the title, not the artwork, carries the page.
 * The negative inset lines the glyph's ink up with the title's left edge.
 */
export function NotebookPageIcon({ className }: { className?: string }) {
	return (
		<FileText
			aria-hidden="true"
			className={cn("-ms-2 block size-12 text-muted-foreground", className)}
			strokeWidth={1.25}
		/>
	);
}

/** The page glyph: Notion's plain document, the same in every theme. */
export function NotebookPageGlyph({ className }: { className?: string }) {
	return (
		<FileText
			aria-hidden="true"
			className={cn("size-4 shrink-0 text-muted-foreground", className)}
			strokeWidth={1.75}
		/>
	);
}

const MARK: Record<ThreadStatus, string> = {
	attention: "bg-destructive",
	quiet: "border border-muted-foreground/60 border-dashed",
	waiting: "border-[1.5px] border-muted-foreground/60",
	working: "border-2 border-success",
	// Neutral ink, not primary: in themes whose primary is green or red the
	// your-turn dot would read as working or attention.
	"your-turn": "bg-foreground/75",
};

/** A status mark that differs by shape as well as color. */
export function NotebookStatusMark({
	className,
	status,
}: {
	className?: string;
	status: ThreadStatus;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"inline-block size-2 shrink-0 rounded-full",
				MARK[status],
				className
			)}
		/>
	);
}

/**
 * Accent text pulled toward the foreground so 13px labels read at full
 * contrast on any theme (a bright accent alone is ~3:1 on white).
 */
export const NOTEBOOK_INK: Record<"attention" | "working", string> = {
	attention:
		"text-[color-mix(in_oklab,var(--destructive)_62%,var(--foreground))]",
	working: "text-[color-mix(in_oklab,var(--success)_52%,var(--foreground))]",
};

/**
 * Secondary text a step above the theme's muted ink: some dark themes ship a
 * muted-foreground near 3:1, too faint for placeholders and counts.
 */
export const NOTEBOOK_FAINT =
	"text-[color-mix(in_oklab,var(--muted-foreground)_74%,var(--foreground))]";
export const NOTEBOOK_SIDEBAR_FAINT =
	"text-[color-mix(in_oklab,var(--muted-foreground)_55%,var(--sidebar-foreground))]";

const PILL: Record<ThreadStatus, string> = {
	attention: cn("bg-destructive/10", NOTEBOOK_INK.attention),
	// Neutral pills: muted text on bg-muted drops below 2:1 in some dark
	// themes, so the label uses the foreground and a ring carries the shape.
	quiet: "bg-transparent text-foreground/80 ring-1 ring-border ring-inset",
	waiting:
		"bg-foreground/[0.04] text-foreground/80 ring-1 ring-border ring-inset",
	working: cn("bg-success/12", NOTEBOOK_INK.working),
	"your-turn": "bg-foreground/[0.07] text-foreground",
};

/**
 * Notion's status property: a soft select tag with a leading mark. A 20px
 * line box, so its text shares a baseline with plain values beside it.
 */
export function NotebookStatusPill({ status }: { status: ThreadStatus }) {
	return (
		<span
			className={cn(
				"inline-flex h-5 items-center gap-1.5 rounded-sm px-1.5 text-sm leading-5",
				PILL[status]
			)}
		>
			<NotebookStatusMark status={status} />
			{THREAD_STATUS_LABELS[status]}
		</span>
	);
}

/**
 * Statuses worth a mark in the sidebar: only a failure or a live run. Pages
 * waiting on the reader are counted on Home, so the tree stays quiet.
 */
export function sidebarShowsStatus(status: ThreadStatus): boolean {
	return status === "attention" || status === "working";
}
