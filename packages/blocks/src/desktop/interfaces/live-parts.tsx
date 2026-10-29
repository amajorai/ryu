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
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import {
	type CSSProperties,
	type ReactNode,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useState,
} from "react";
import { LiveScene } from "./live-art.tsx";
import { type LiveArtSpec, liveUptime } from "./live-model.ts";

/** Size assumed before the first measurement (and where layout is absent). */
const UNMEASURED = { height: 900, width: 1440 } as const;

export interface LiveSize {
	height: number;
	width: number;
}

/** The element's rendered size, kept current with a ResizeObserver. */
export function useLiveSize(ref: RefObject<HTMLElement | null>): LiveSize {
	const [size, setSize] = useState<LiveSize | null>(null);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const rect = element.getBoundingClientRect();
		if (rect.width > 0) {
			setSize({ height: rect.height, width: rect.width });
		}
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver((entries) => {
			const box = entries[0]?.contentRect;
			if (box && box.width > 0) {
				setSize({ height: box.height, width: box.width });
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return size ?? UNMEASURED;
}

/** A wall clock that ticks every `interval` ms while `enabled`. */
export function useLiveNow(interval: number, enabled = true): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!enabled) {
			return;
		}
		setNow(Date.now());
		const timer = window.setInterval(() => {
			if (document.visibilityState !== "hidden") {
				setNow(Date.now());
			}
		}, interval);
		return () => window.clearInterval(timer);
	}, [enabled, interval]);
	return now;
}

/** True for targets whose keys belong to typing or to the host's chat. */
export function liveOwnsKeys(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement ||
		target.closest("[data-live-chat-view]") !== null
	);
}

export type LiveAvatarSize = 28 | 32 | 40 | 64;

const AVATAR_SIZE: Record<LiveAvatarSize, string> = {
	28: "size-7",
	32: "size-8",
	40: "size-10",
	64: "size-16",
};

/**
 * An agent's picture, or the generative dither tile Ryu falls back to. Offline
 * channels render it desaturated, the way the reference greys followed
 * channels that are not streaming. Decorative: the row or card names the agent.
 */
export function LiveAvatar({
	agent,
	className,
	offline = false,
	size,
}: {
	agent: InterfaceAgent;
	className?: string;
	offline?: boolean;
	size: LiveAvatarSize;
}) {
	const seed = ditherAvatarSeed({ id: agent.id, name: agent.name });
	return (
		<Avatar
			aria-hidden="true"
			className={cn(
				AVATAR_SIZE[size],
				offline && "opacity-60 grayscale",
				className
			)}
		>
			{agent.avatarUrl ? <AvatarImage alt="" src={agent.avatarUrl} /> : null}
			<AvatarFallback appearance="artwork" className="overflow-hidden bg-muted">
				<DitherAvatar animate={false} className="size-full" name={seed} />
			</AvatarFallback>
		</Avatar>
	);
}

/** The red LIVE badge from the reference, in the theme's destructive token. */
export function LiveBadge({ className }: { className?: string }) {
	return (
		<span
			className={cn(
				"inline-flex h-5 items-center rounded-sm bg-destructive px-1.5 font-semibold text-background text-xs uppercase tracking-wide",
				className
			)}
		>
			Live
		</span>
	);
}

/** The small live dot for rows: a solid destructive dot with a soft pulse. */
export function LiveDot({ className }: { className?: string }) {
	return (
		<span
			aria-hidden="true"
			className={cn("relative inline-flex size-2 shrink-0", className)}
		>
			<span className="absolute inset-0 rounded-full bg-destructive/40 motion-safe:animate-ping motion-safe:[animation-duration:2s]" />
			<span className="relative size-2 rounded-full bg-destructive" />
		</span>
	);
}

/** A neutral rounded tag, like the reference's stream tags. */
export function LiveTag({ children }: { children: string }) {
	return (
		<span className="inline-flex h-5 items-center rounded-full bg-muted px-2 font-medium text-foreground/80 text-xs">
			{children}
		</span>
	);
}

/** Overlay chip on a thumbnail corner (uptime, message count, age). */
export function LiveChip({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"inline-flex h-5 items-center rounded-sm bg-background/85 px-1.5 text-foreground text-xs tabular-nums",
				className
			)}
		>
			{children}
		</span>
	);
}

/** Uptime that ticks every second while the stream is live. */
export function LiveUptime({
	className,
	since,
}: {
	className?: string;
	since: string;
}) {
	const now = useLiveNow(1000);
	return (
		<time className={cn("tabular-nums", className)} dateTime={since}>
			{liveUptime(since, now)}
		</time>
	);
}

/**
 * A stream frame: the scene built from the thread (see `LiveScene`), with
 * overlay chips passed as children. Offline frames are desaturated and dimmed
 * like a paused broadcast.
 */
export function LiveScreen({
	agent,
	children,
	className,
	dim = false,
	mode = "thumb",
	spec,
	style,
}: {
	agent: InterfaceAgent | null;
	children?: ReactNode;
	className?: string;
	dim?: boolean;
	mode?: "player" | "thumb";
	spec: LiveArtSpec;
	style?: CSSProperties;
}) {
	return (
		<span
			className={cn(
				"@container relative block aspect-video w-full overflow-hidden bg-muted",
				className
			)}
			style={style}
		>
			<LiveScene
				agent={agent}
				className={cn(dim && "brightness-[0.62] grayscale")}
				mode={mode}
				spec={spec}
			/>
			{children}
		</span>
	);
}
