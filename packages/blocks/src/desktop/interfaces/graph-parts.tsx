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
import { FolderKanban, type LucideIcon, Users } from "lucide-react";

/**
 * An agent's picture, or the generative dither tile the rest of Ryu falls back
 * to (seeded by id, so it survives renames). Decorative: the surrounding
 * control names the agent.
 */
export function GraphAvatar({
	agent,
	className,
}: {
	agent: InterfaceAgent | undefined;
	className?: string;
}) {
	const seed = ditherAvatarSeed({ id: agent?.id, name: agent?.name ?? "" });
	return (
		<Avatar aria-hidden="true" className={cn("size-8", className)}>
			{agent?.avatarUrl ? <AvatarImage alt="" src={agent.avatarUrl} /> : null}
			<AvatarFallback appearance="artwork" className="overflow-hidden bg-card">
				<DitherAvatar animate={false} className="size-full" name={seed} />
			</AvatarFallback>
		</Avatar>
	);
}

export const GROUP_ICON: Record<"project" | "team", LucideIcon> = {
	project: FolderKanban,
	team: Users,
};

/**
 * One round 6px mark per status. "Your turn" is drawn in the text ink, not
 * the theme's primary, so it never matches "Working" in themes whose primary
 * is green; the words beside each mark carry the meaning too.
 */
const DOT: Record<ThreadStatus, string> = {
	attention: "bg-destructive",
	quiet: "bg-muted-foreground/40",
	waiting: "border border-muted-foreground",
	working: "bg-success",
	"your-turn": "bg-foreground",
};

/** The one status mark the Graph uses. */
export function GraphStatusDot({
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
				"inline-block size-1.5 shrink-0 rounded-full",
				DOT[status],
				className
			)}
		/>
	);
}

/** Dot and plain label for a thread's status, in the surrounding text style. */
export function GraphStatusLabel({
	className,
	status,
}: {
	className?: string;
	status: ThreadStatus;
}) {
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap",
				status === "attention" && "text-destructive",
				className
			)}
		>
			<GraphStatusDot status={status} />
			{THREAD_STATUS_LABELS[status]}
		</span>
	);
}

/*
 * The Graph's three text steps: meta (13px), body and map labels (14px),
 * titles (16px). Every surface picks from these.
 */
export const TEXT_META = "text-[13px] leading-[18px]";
export const TEXT_BODY = "text-sm leading-5";
export const TEXT_TITLE = "text-base leading-6";
