import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceAgent,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { UserRound } from "lucide-react";
import {
	type CSSProperties,
	createContext,
	type ReactNode,
	useContext,
	useMemo,
} from "react";
import { agentHandle, initials } from "./interface-renderer.ts";

/**
 * Shared focus ring for every control in the feed. It uses the theme's ring
 * token, offset from the theme background, so it reads in every palette.
 */
export const FEED_FOCUS =
	"outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/** Focus ring for full-bleed rows, drawn inside the row instead of around it. */
export const FEED_FOCUS_INSET =
	"outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

/**
 * Thin, theme-coloured scrollbars for the feed's native scrollers. (@ryu/ui
 * ScrollArea's viewport polls getAnimations(), which the unit-test DOM lacks.)
 */
export const FEED_SCROLLBAR =
	"[scrollbar-color:var(--border)_transparent] [scrollbar-width:thin]";

export interface FeedAuthor {
	agent: InterfaceAgent | undefined;
	handle: string;
	name: string;
}

export const YOU: FeedAuthor = {
	agent: undefined,
	handle: "@you",
	name: "You",
};

export function feedAuthor(agent: InterfaceAgent | undefined): FeedAuthor {
	return agent
		? { agent, handle: agentHandle(agent.name), name: agent.name }
		: YOU;
}

/** Who wrote a thread's newest message: its agent, or the user. */
export function lastSpeaker(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread | undefined
): FeedAuthor {
	if (!thread || thread.lastMessageRole === "user") {
		return YOU;
	}
	const agentId = thread.agentIds[0];
	return feedAuthor(snapshot.agents.find((agent) => agent.id === agentId));
}

/** True when both authors are the same account (the same agent, or both the user). */
export function sameAuthor(a: FeedAuthor, b: FeedAuthor): boolean {
	return a.agent?.id === b.agent?.id;
}

const AVATAR_SIZES = {
	xs: "size-5 text-[9px]",
	sm: "size-8 text-xs",
	md: "size-10 text-sm",
} as const;

/**
 * Secondary text (handles, timestamps, counts, meta lines): the theme's muted
 * foreground pulled 40% toward its foreground. It keeps the theme's own muted
 * tone but holds a readable contrast floor in palettes whose muted text is
 * faint (Solarized, Catppuccin, Dracula). Plain muted-foreground stays for
 * placeholders and footnotes.
 */
export const FEED_META =
	"text-[color-mix(in_oklab,var(--muted-foreground)_60%,var(--foreground))]";

/**
 * Hue offsets (degrees) applied to the theme's primary, spread so the first
 * agents sit far apart on the wheel. Turned tints keep the primary's
 * lightness but drop to 60% of its chroma, so the washes stay quiet and the
 * theme's own primary remains the one saturated colour; a monochrome theme
 * stays monochrome.
 */
const AVATAR_HUE_OFFSETS = [0, 180, 90, 270, 45, 225, 135, 315] as const;

/**
 * LCH hues outside the brown band. Orange and yellow at the mid lightness a
 * theme's primary usually has turn brown, olive or khaki (worse still as a
 * wash on a dark background), so turned hues are squeezed onto the rest of
 * the wheel instead: green, through cyan, blue, violet and pink, to red.
 */
const HUE_ARC_START = 140;
const HUE_ARC_SPAN = 260;

/** Fallback for an agent the snapshot does not list: a stable hash of its id. */
function hashTint(id: string): number {
	let hash = 0;
	for (const char of id) {
		hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 9973;
	}
	return hash % AVATAR_HUE_OFFSETS.length;
}

/**
 * The agent's tint as CSS: the theme's primary, hue-turned in LCH with CSS
 * relative colour syntax, so it is derived from the active theme alone.
 */
function tintColor(index: number): string {
	const offset = AVATAR_HUE_OFFSETS[index] ?? 0;
	if (offset === 0) {
		return "var(--primary)";
	}
	const scale = HUE_ARC_SPAN / 360;
	const hue = `calc(${HUE_ARC_START} + mod(h + ${offset - HUE_ARC_START}, 360) * ${scale.toFixed(4)})`;
	return `lch(from var(--primary) l calc(c * 0.6) ${hue})`;
}

const FeedTintContext = createContext<ReadonlyMap<string, number>>(new Map());

/**
 * Hands each agent its own tint: agents are ranked by id, so the first
 * AVATAR_HUE_OFFSETS.length agents never share one and a rename keeps it.
 */
export function FeedTints({
	agents,
	children,
}: {
	agents: readonly InterfaceAgent[];
	children: ReactNode;
}) {
	const tints = useMemo(() => {
		const ids = agents.map((agent) => agent.id).sort();
		return new Map(
			ids.map((id, index) => [id, index % AVATAR_HUE_OFFSETS.length])
		);
	}, [agents]);
	return (
		<FeedTintContext.Provider value={tints}>
			{children}
		</FeedTintContext.Provider>
	);
}

/** The surface an avatar sits on, so the working dot's cut-out matches it. */
export type FeedSurface = "background" | "card";

const DOT_RING: Record<FeedSurface, string> = {
	background: "ring-background",
	card: "ring-card",
};

/**
 * Round avatar: the agent's picture or its initials on a wash of its tint
 * (the theme's primary, hue-turned per agent), or a neutral silhouette for the
 * user. A working agent carries a small success dot on its corner, cut out of
 * the surface the avatar sits on.
 */
export function FeedAvatar({
	author,
	size = "md",
	surface = "background",
	working = false,
}: {
	author: FeedAuthor;
	size?: keyof typeof AVATAR_SIZES;
	surface?: FeedSurface;
	working?: boolean;
}) {
	const { agent } = author;
	const tints = useContext(FeedTintContext);
	const tint = agent ? (tints.get(agent.id) ?? hashTint(agent.id)) : 0;
	return (
		<span
			aria-hidden="true"
			className="relative inline-flex shrink-0 self-start"
		>
			<Avatar className={AVATAR_SIZES[size]}>
				{agent?.avatarUrl ? <AvatarImage alt="" src={agent.avatarUrl} /> : null}
				{agent ? (
					<AvatarFallback
						className={cn(
							"bg-primary/15 font-semibold text-[length:inherit] text-primary",
							// Engines without relative colour syntax keep the primary tint. The
							// initial leans toward the foreground so it holds contrast on the wash.
							"supports-[color:lch(from_currentcolor_l_c_h)]:bg-[color-mix(in_oklab,var(--feed-tint)_22%,var(--background))] supports-[color:lch(from_currentcolor_l_c_h)]:text-[color-mix(in_oklab,var(--feed-tint)_68%,var(--foreground))]"
						)}
						style={{ "--feed-tint": tintColor(tint) } as CSSProperties}
					>
						{initials(agent.name)}
					</AvatarFallback>
				) : (
					<AvatarFallback className="bg-muted text-muted-foreground">
						<UserRound aria-hidden="true" className="size-[58%]" />
					</AvatarFallback>
				)}
			</Avatar>
			{working ? (
				<span
					className={cn(
						"absolute right-0 bottom-0 size-3 rounded-full bg-success ring-2",
						DOT_RING[surface]
					)}
				/>
			) : null}
		</span>
	);
}

/** Display name, the line's one bold run. */
export function AuthorName({
	author,
	className,
}: {
	author: FeedAuthor;
	className?: string;
}) {
	return (
		<span className={cn("flex min-w-0 items-center gap-1", className)}>
			<span className="truncate font-semibold text-foreground">
				{author.name}
			</span>
		</span>
	);
}

/**
 * Dot for live runs, in the design system's success tone. It stays still in
 * lists; only the post page's "Live now" pulses, so one dot moves at a time.
 */
export function LiveDot({
	pulse = false,
	size = "md",
}: {
	pulse?: boolean;
	size?: "sm" | "md";
}) {
	const box = size === "sm" ? "size-1.5" : "size-2";
	return (
		<span aria-hidden="true" className={cn("relative flex shrink-0", box)}>
			{pulse ? (
				<span className="absolute inset-0 rounded-full bg-success/40 motion-safe:animate-ping motion-reduce:hidden" />
			) : null}
			<span className={cn("relative rounded-full bg-success", box)} />
		</span>
	);
}

const TIME_FORMAT = new Intl.DateTimeFormat("en-US", {
	hour: "numeric",
	minute: "2-digit",
});
const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
	day: "numeric",
	month: "short",
	year: "numeric",
});

/** Full post timestamp: "10:42 AM · Oct 12, 2026". */
export function fullTimestamp(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return "";
	}
	return `${TIME_FORMAT.format(date)} · ${DATE_FORMAT.format(date)}`;
}

/** Compact counts the way a timeline shows them: 950, 1.2K, 3.4M. */
export function compactCount(value: number): string {
	if (value < 1000) {
		return String(value);
	}
	if (value < 1_000_000) {
		return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/, "")}K`;
	}
	return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
