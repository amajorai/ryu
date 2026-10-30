"use client";

import { CheckmarkBadge02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { DoorClosed, DoorOpen } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { isNativeNumber } from "../lib/native-primitive-observation.ts";
import { formatCount } from "../lib/number-format.ts";
import { safeHttpUrl } from "../lib/safe-url.ts";
import { Button } from "./button.tsx";
import { METAL_EDGE_TILE_RING_PX, MetalEdge } from "./metal-edge.tsx";
import PageHeader from "./page-header.tsx";
import { Spinner } from "./spinner.tsx";
import { QUEUE_STATS_MIN } from "./waitlist-pass.tsx";

/**
 * The overview step of the shared queue screen (`waitlist-queue.tsx`), and the
 * strip's default. It carries the greeting, the optional application, the
 * housekeeping actions, and the two queue numbers: everything that is context
 * rather than an action you take on your own account.
 */

/** How long Refresh stays disabled after a press. */
const REFRESH_COOLDOWN_MS = 60_000;
/**
 * Persisted so the cooldown survives a reload. On the web build this screen is
 * an ordinary route, so refreshing the browser would otherwise reset the limit
 * and make it decorative — the one place a cooldown has to hold is exactly where
 * reloading is free.
 */
const REFRESH_COOLDOWN_KEY = "ryu_waitlist_refresh_until";
const MS_PER_SECOND = 1000;
const COOLDOWN_TICK_MS = 500;
/**
 * Radius of the stat tiles beside the pass, in the CSS px `metal-fx` wants it
 * in: `rounded-xl` (12px). Kept in step with that class by hand, because the
 * library measures the ring itself and cannot read a Tailwind token.
 */
const TILE_RADIUS_PX = 12;
/**
 * A same-site absolute path (`/discord`), never protocol-relative (`//host`,
 * or `/\host`, which browsers also resolve off-site).
 */
const SITE_PATH_RE = /^\/(?![/\\])/;

function readCooldownUntil(): number {
	try {
		const raw = Number(localStorage.getItem(REFRESH_COOLDOWN_KEY) ?? "0");
		// Must be a FUTURE stamp within one cooldown. A clock that moved backwards,
		// or a hand-edited value, must not lock the button for hours.
		const ahead = raw - Date.now();
		return Number.isFinite(raw) && ahead > 0 && ahead <= REFRESH_COOLDOWN_MS
			? raw
			: 0;
	} catch {
		return 0;
	}
}

export function WaitlistOverviewStep({
	discordHref,
	error,
	eta,
	hasApplied,
	loaded,
	metalTheme,
	onApply,
	onRefresh,
	onSignOut,
	signingOut,
	subtitle,
	title,
	totalWaiting,
}: {
	discordHref?: string;
	error: boolean;
	eta?: string | null;
	hasApplied: boolean;
	loaded: boolean;
	metalTheme: "auto" | "dark" | "light";
	onApply?: () => void;
	onRefresh?: () => void | Promise<void>;
	onSignOut: () => void;
	signingOut: boolean;
	subtitle?: string;
	title: string;
	totalWaiting?: number | null;
}) {
	const tl = useLiteralMessages();
	const [refreshing, setRefreshing] = useState(false);
	const [cooldownUntil, setCooldownUntil] = useState<number>(readCooldownUntil);
	const [now, setNow] = useState(() => Date.now());
	const cooldownLeftMs = Math.max(0, cooldownUntil - now);
	const cooldownSeconds = Math.ceil(cooldownLeftMs / MS_PER_SECOND);

	// Tick only while the cooldown runs, so an idle screen is not re-rendering
	// twice a second forever.
	useEffect(() => {
		if (cooldownLeftMs <= 0) {
			return;
		}
		const id = setInterval(() => setNow(Date.now()), COOLDOWN_TICK_MS);
		return () => clearInterval(id);
	}, [cooldownLeftMs]);

	const refresh = useCallback(async () => {
		if (!onRefresh) {
			return;
		}
		setRefreshing(true);
		// Armed on press, not on success: the point is to rate-limit the request,
		// and a failed read costs the server exactly what a successful one does.
		const until = Date.now() + REFRESH_COOLDOWN_MS;
		setCooldownUntil(until);
		setNow(Date.now());
		try {
			localStorage.setItem(REFRESH_COOLDOWN_KEY, String(until));
		} catch {
			// Storage unavailable: the in-memory cooldown still holds for this view.
		}
		try {
			await onRefresh();
		} finally {
			setRefreshing(false);
		}
	}, [onRefresh]);
	const discordIsSitePath = SITE_PATH_RE.test(discordHref ?? "");
	const safeDiscordHref = discordIsSitePath
		? discordHref
		: safeHttpUrl(discordHref);
	const showStats =
		loaded && isNativeNumber(totalWaiting) && totalWaiting > QUEUE_STATS_MIN;

	return (
		<div className="flex flex-col gap-4">
			<PageHeader subtitle={subtitle} title={title} />

			{/* Kept on screen once applied rather than removed. A CTA that simply
					    disappears leaves the user wondering whether the submit went
					    through; a disabled button that states the outcome answers it. */}
			{onApply && loaded ? (
				<Button
					className="w-full"
					disabled={hasApplied}
					onClick={onApply}
					size="lg"
					type="button"
				>
					{hasApplied ? (
						<>
							<HugeiconsIcon icon={CheckmarkBadge02Icon} size={18} />
							You have requested early access
						</>
					) : (
						"Apply for early access"
					)}
				</Button>
			) : null}

			{error ? (
				<p className="text-muted-foreground text-sm">
					Couldn&apos;t load your position right now. You&apos;re still on the
					list. Refresh in a bit.
				</p>
			) : null}

			{/* Refresh and sign out live here rather than behind a step of their
					    own. Neither changes your place in the queue, so a step promised
					    an action and delivered housekeeping; under the overview they read
					    as what they are. */}
			<div className="flex flex-col gap-2 sm:flex-row">
				{onRefresh ? (
					<Button
						className="flex-1"
						disabled={refreshing || cooldownLeftMs > 0}
						onClick={refresh}
						size="lg"
						type="button"
						variant="secondary"
					>
						{refreshing ? (
							<span className="flex items-center gap-2">
								<Spinner className="size-4" />
								Refreshing…
							</span>
						) : cooldownLeftMs > 0 ? (
							tl("Refresh status {cooldownSeconds}s", { cooldownSeconds })
						) : (
							tl("Refresh status")
						)}
					</Button>
				) : null}
				{safeDiscordHref ? (
					<Button
						className="flex-1"
						render={
							discordIsSitePath ? (
								<a href={safeDiscordHref} />
							) : (
								<a
									href={safeDiscordHref}
									rel="noopener noreferrer"
									target="_blank"
								/>
							)
						}
						size="lg"
						variant="outline"
					>
						Join our Discord
					</Button>
				) : null}
				{/* The door swings open on hover — the same gesture the account menu's
					    sign-out used to carry, moved here now that this is the only
					    sign-out on the screen. */}
				<Button
					className="group flex-1"
					disabled={signingOut}
					onClick={onSignOut}
					size="lg"
					type="button"
					variant="destructive"
				>
					<DoorClosed className="size-4 group-hover:hidden" />
					<DoorOpen className="hidden size-4 group-hover:block" />
					{signingOut ? "Signing out…" : "Sign out"}
				</Button>
			</div>

			{/* The numbers the pass doesn't carry: how many are behind you and
					    roughly how long it takes. Held back until the queue is big
					    enough for them to read as momentum — a two-digit "in line"
					    undersells the product to the very people who joined earliest. */}
			{showStats ? (
				// The same metal edge the pass wears, so the numbers beside it
				// read as part of the same object rather than as plain panels
				// parked next to a fancy card. The fill sits inside the ring's
				// own gutter (see `MetalEdge`), so its radius is the outer one
				// less the ring — otherwise the band thins at the corners.
				<div className="grid grid-cols-2 gap-3">
					<MetalEdge
						borderRadius={TILE_RADIUS_PX}
						// `h-full` on both the ring box and the face: the grid row
						// stretches the ring to the taller sibling, and a face that
						// only wrapped its own text left the ring's canvas showing
						// through underneath as a slab of bare chrome.
						className="h-full"
						ringPx={METAL_EDGE_TILE_RING_PX}
						small
						theme={metalTheme}
					>
						<div className="h-full rounded-[11px] bg-muted px-4 py-3">
							<p className="text-muted-foreground text-xs">In line</p>
							<p className="font-medium text-lg tabular-nums">
								{formatCount(totalWaiting) ?? "—"}
							</p>
						</div>
					</MetalEdge>
					<MetalEdge
						borderRadius={TILE_RADIUS_PX}
						className="h-full"
						ringPx={METAL_EDGE_TILE_RING_PX}
						small
						theme={metalTheme}
					>
						<div className="h-full rounded-[11px] bg-muted px-4 py-3">
							<p className="text-muted-foreground text-xs">Estimated wait</p>
							<p className="font-medium text-lg">{eta ?? "—"}</p>
						</div>
					</MetalEdge>
				</div>
			) : null}
		</div>
	);
}
