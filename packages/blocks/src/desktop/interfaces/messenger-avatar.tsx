import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { MessagesSquare, Users } from "lucide-react";
import type { ReactNode } from "react";
import { initials } from "./interface-renderer.ts";
import type { MessengerEntry } from "./messenger-model.ts";

export type MessengerAvatarSize = "chip" | "header" | "list";

/** Face box per size; monograms scale off the box (see {@link Face}). */
const FACE: Record<MessengerAvatarSize, string> = {
	chip: "size-6",
	header: "size-10",
	list: "size-11",
};

/** Smaller faces for the two-up group-chat stack. */
const GROUP_FACE: Record<MessengerAvatarSize, string> = {
	chip: "size-4",
	header: "size-6",
	list: "size-7.5",
};

const ICON: Record<MessengerAvatarSize, string> = {
	chip: "size-3.5",
	header: "size-4",
	list: "size-5",
};

/**
 * One face: the agent's picture, else monogram initials drawn the same way
 * for every contact, as a messaging app does for a contact with no photo.
 * The face is a size container so the initials scale with the disc.
 * Decorative; the row or header around it names the contact.
 */
function Face({
	agent,
	className,
	monogramClassName,
	name,
}: {
	agent: InterfaceAgent | undefined;
	className: string;
	/** Shifts the initials, e.g. into the uncovered corner of a stack. */
	monogramClassName?: string;
	name: string;
}) {
	return (
		<Avatar
			aria-hidden="true"
			className={cn(
				"bg-background [container-type:size] before:hidden",
				className
			)}
		>
			{agent?.avatarUrl ? <AvatarImage alt="" src={agent.avatarUrl} /> : null}
			<AvatarFallback
				className={cn(
					"bg-linear-to-b from-muted-foreground/55 to-muted-foreground/90 font-semibold text-[length:40cqw] text-background dark:from-muted-foreground/45 dark:to-muted-foreground/70 dark:text-foreground",
					monogramClassName
				)}
			>
				{initials(name)}
			</AvatarFallback>
		</Avatar>
	);
}

/**
 * A glyph in place of a face (Unassigned, a team at chip size). Drawn on the
 * same opaque base as {@link Face} so it reads the same on any row surface.
 */
function GlyphFace({ children }: { children: ReactNode }) {
	return (
		<span aria-hidden="true" className="size-full rounded-full bg-background">
			<span className="flex size-full items-center justify-center rounded-full bg-linear-to-b from-muted-foreground/55 to-muted-foreground/90 text-background dark:from-muted-foreground/45 dark:to-muted-foreground/70 dark:text-foreground">
				{children}
			</span>
		</span>
	);
}

/**
 * A contact's avatar. Teams draw as a two-face group stack; `ringClassName`
 * cuts the front face out of whatever surface the avatar sits on. There is
 * no presence dot: as in Messages, typing shows on the preview line.
 */
export function MessengerAvatar({
	entry,
	ringClassName = "ring-sidebar",
	size,
}: {
	entry: Pick<MessengerEntry, "kind" | "members" | "name">;
	ringClassName?: string;
	size: MessengerAvatarSize;
}) {
	const [first, second] = entry.members;
	let faces: ReactNode;
	if (entry.kind === "other") {
		faces = (
			<GlyphFace>
				<MessagesSquare className={ICON[size]} />
			</GlyphFace>
		);
	} else if (entry.kind === "team" && size === "chip") {
		// Two faces at chip size are unreadable; a group glyph reads at a glance.
		faces = (
			<GlyphFace>
				<Users className="size-3" />
			</GlyphFace>
		);
	} else if (entry.kind === "team") {
		faces = (
			<>
				<Face
					agent={second}
					className={cn(
						"absolute top-0 right-0 ring-2",
						GROUP_FACE[size],
						ringClassName
					)}
					// The front face covers the lower left; centre the initials
					// in what stays visible.
					monogramClassName="pb-[20%] pl-[20%]"
					name={second?.name ?? entry.name}
				/>
				<Face
					agent={first}
					className={cn(
						"absolute bottom-0 left-0 ring-2",
						GROUP_FACE[size],
						ringClassName
					)}
					name={first?.name ?? entry.name}
				/>
			</>
		);
	} else {
		faces = <Face agent={first} className="size-full" name={entry.name} />;
	}
	return (
		<span className={cn("relative inline-flex shrink-0", FACE[size])}>
			{faces}
		</span>
	);
}

/** Three pulsing dots, the universal "someone is typing" cue. */
export function TypingDots({ className }: { className?: string }) {
	return (
		<span
			aria-hidden="true"
			className={cn("inline-flex items-center gap-0.5", className)}
		>
			<span className="size-1 rounded-full bg-current motion-safe:animate-pulse" />
			<span className="size-1 rounded-full bg-current motion-safe:animate-pulse motion-safe:[animation-delay:200ms]" />
			<span className="size-1 rounded-full bg-current motion-safe:animate-pulse motion-safe:[animation-delay:400ms]" />
		</span>
	);
}
