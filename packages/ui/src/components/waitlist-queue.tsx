"use client";

import {
	ArrowLeft02Icon,
	CheckmarkBadge02Icon,
	Ticket01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { BorderBeam } from "border-beam";
import { DoorClosed, DoorOpen } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { formatCount } from "../lib/number-format.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "./button.tsx";
import { METAL_EDGE_TILE_RING_PX, MetalEdge } from "./metal-edge.tsx";
import PageHeader from "./page-header.tsx";
import { Spinner } from "./spinner.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs.tsx";
import { UsernameMarquee } from "./username-marquee.tsx";
import { QUEUE_STATS_MIN, WaitlistPass } from "./waitlist-pass.tsx";
import { WaitlistUsernameField } from "./waitlist-username-field.tsx";

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
 * Radii of the two ringed surfaces beside the pass, in the CSS px `metal-fx`
 * wants them in — `rounded-xl` (12px) for the stat tiles, `rounded-3xl` (24px)
 * for the invite row. Kept in step with those classes by hand: the library
 * measures the ring itself and cannot read a Tailwind token.
 */
const TILE_RADIUS_PX = 12;
const REFERRAL_RADIUS_PX = 24;
/** The filled surface inside each ring, rounded to stay concentric with it. */
const TILE_FACE_RADIUS_PX = TILE_RADIUS_PX - METAL_EDGE_TILE_RING_PX;
const REFERRAL_FACE_RADIUS_PX = REFERRAL_RADIUS_PX - METAL_EDGE_TILE_RING_PX;

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

/**
 * The queue screen — pass on the left, the facts and the actions that change
 * them on the right. ONE definition, rendered by both `apps/web`'s
 * `waitlist-view.tsx` and `apps/desktop`'s `WaitlistPage.tsx`.
 *
 * These used to be two hand-written screens that happened to share only the
 * card, and they drifted exactly as you would expect: every change to the web
 * copy — the header that follows the handle state, the press-to-copy invite row,
 * the button sizes, the spacing — left the desktop showing an older product.
 *
 * Presentational and platform-free, which is what lets it live in the UI
 * package: it holds no auth client, no router, and no clipboard. Everything that
 * differs between a browser tab and a Tauri window arrives as a callback
 * (`onApply` navigates on web and opens a browser on desktop; `onShare` opens
 * the share dialog on web) or as the `userNav` slot.
 */
export interface WaitlistQueueProps {
	/** Optional web-only tab for redeeming an admin-issued waitlist code. */
	accessCodeContent?: ReactNode;
	/**
	 * Canonical dither seed for the signed-in member (`ditherAvatarSeed`), so the
	 * pass draws the same placeholder glyph as the account menu. Only a screen
	 * with a session can supply it.
	 */
	avatarSeed?: string | null;
	/** The member's own picture, when they have set one. Wins over the glyph. */
	avatarUrl?: string | null;
	className?: string;
	/** True once the invite link has just been copied; drives the row's label. */
	copied?: boolean;
	/** The queue read failed. The screen still renders, minus the numbers. */
	error?: boolean;
	eta?: string | null;
	handle: string;
	handleError?: string | null;
	hasApplied?: boolean;
	joinedAt?: string | null;
	/** True once the waitlist is large enough to expose its points ranking. */
	leaderboardEnabled?: boolean;
	/** False until `/me` resolves; suppresses the facts, not the whole screen. */
	loaded?: boolean;
	metalTheme?: "auto" | "dark" | "light";
	onApply?: () => void;
	/** Renders a Back button when supplied. The desktop shell has nowhere to go. */
	onBack?: () => void;
	onChangeHandle: (value: string) => void;
	onCopyReferral: () => void;
	/** Opens the Lifetime plan picker supplied by the host app. */
	onLifetimeAccess?: () => void;
	/** Opens the waitlist-only leaderboard dialog supplied by the host app. */
	onOpenLeaderboard?: () => void;
	/** Re-read the queue. Both apps get the button; both rate-limit it here. */
	onRefresh?: () => void | Promise<void>;
	onReserve: () => void;
	onShare: () => void;
	onSignOut: () => void;
	onUnreserve?: () => void;
	/** Opens the paid plan picker supplied by the host app. */
	onUpgrade?: () => void;
	position?: number | null;
	/** Optional web-only quest surface. The desktop queue keeps this tab absent. */
	questsContent?: ReactNode;
	referralCount?: number;
	referralUrl?: string | null;
	reserved?: string | null;
	reserving?: boolean;
	signingOut?: boolean;
	subtitle?: string;
	totalWaiting?: number | null;
	userName?: string | null;
	/** Account menu, pinned top right. Platform-specific, so it arrives as a slot. */
	userNav?: ReactNode;
}

/**
 * Split a referral URL into the part nobody reads and the part everybody does.
 * The scheme is dropped — nobody needs to see "https://" on a link they are
 * about to copy. Falls back to the whole string if it will not parse, so a
 * malformed link still renders rather than disappearing.
 */
const splitReferralUrl = (url: string): { code: string; origin: string } => {
	try {
		const parsed = new URL(url);
		return { code: parsed.pathname, origin: parsed.host };
	} catch {
		return { code: url, origin: "" };
	}
};

export function WaitlistQueue({
	accessCodeContent,
	avatarSeed,
	avatarUrl,
	className,
	questsContent,
	leaderboardEnabled = false,
	onOpenLeaderboard,
	onUpgrade,
	onLifetimeAccess,
	copied = false,
	error = false,
	eta,
	handle,
	handleError,
	hasApplied = false,
	joinedAt,
	loaded = false,
	metalTheme = "auto",
	onApply,
	onBack,
	onChangeHandle,
	onCopyReferral,
	onRefresh,
	onReserve,
	onShare,
	onSignOut,
	onUnreserve,
	position,
	referralCount = 0,
	referralUrl,
	reserved,
	reserving = false,
	signingOut = false,
	subtitle,
	totalWaiting,
	userName,
	userNav,
}: WaitlistQueueProps) {
	const [refreshing, setRefreshing] = useState(false);
	/**
	 * The step the member steered to, if any. Null means "follow my progress" —
	 * see `activeStep`. Held as a plain id rather than an index so a strip that
	 * drops its share step (no referral link yet) cannot shift the selection onto
	 * a different panel behind the member's back.
	 */
	const [chosenStep, setChosenStep] = useState<string | null>(null);
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
	const link = splitReferralUrl(referralUrl ?? "");
	// Once a handle is claimed, that IS the headline — it is the newest and most
	// specific thing true about this user, and repeating "you're in line" under it
	// says nothing the position on the pass does not already say.
	let headerTitle = "You're on the waitlist";
	if (reserved) {
		headerTitle = `@${reserved} is reserved`;
	} else if (userName) {
		headerTitle = `You're in line, ${userName}`;
	}
	const showStats =
		loaded &&
		typeof totalWaiting === "number" &&
		totalWaiting > QUEUE_STATS_MIN;

	// Where the strip opens when the member has not steered it themselves: the
	// one thing left to do. Unclaimed handle first, and once it is claimed the
	// link that actually moves them up the queue. A suggestion, not a rail — the
	// moment they press a step, `chosenStep` wins for the rest of the visit.
	const activeStep =
		chosenStep ?? (reserved && referralUrl ? "share" : "access");
	const steps: { content: ReactNode; id: string; label: string }[] = [
		{
			// The overview, and the strip's default. It carries the greeting, the
			// optional application, and the two queue numbers — everything that is
			// context rather than an action you take on your own account.
			content: (
				<div className="flex flex-col gap-4">
					<PageHeader subtitle={subtitle} title={headerTitle} />

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
							Couldn&apos;t load your position right now. You&apos;re still on
							the list. Refresh in a bit.
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
								) : (
									`Refresh status${cooldownLeftMs > 0 ? ` ${cooldownSeconds}s` : ""}`
								)}
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
							<DoorClosed className="size-4 transition-all duration-200 group-hover:hidden" />
							<DoorOpen className="hidden size-4 transition-all duration-200 group-hover:block" />
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
								<div
									className="h-full bg-muted px-4 py-3"
									style={{ borderRadius: `${TILE_FACE_RADIUS_PX}px` }}
								>
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
								<div
									className="h-full bg-muted px-4 py-3"
									style={{ borderRadius: `${TILE_FACE_RADIUS_PX}px` }}
								>
									<p className="text-muted-foreground text-xs">
										Estimated wait
									</p>
									<p className="font-medium text-lg">{eta ?? "—"}</p>
								</div>
							</MetalEdge>
						</div>
					) : null}
				</div>
			),
			id: "access",
			label: "Early access",
		},
		...(accessCodeContent
			? [
					{
						content: (
							<div className="flex flex-col gap-4">{accessCodeContent}</div>
						),
						id: "access-code",
						label: "Access code",
					},
				]
			: []),
		{
			// Gated on `loaded` rather than the whole strip being gated: the sign-out
			// under "More" has to stay reachable exactly when `/me` is slow or broken.
			content: loaded ? (
				<div className="flex flex-col gap-4">
					<PageHeader
						subtitle={
							reserved
								? "It's yours the moment you're in. We'll let you know."
								: "Pick the handle you want. It's held for you from the moment you claim it."
						}
						title={
							reserved ? `@${reserved} is reserved` : "Reserve your handle"
						}
					/>
					<WaitlistUsernameField
						error={handleError}
						onChange={onChangeHandle}
						onSubmit={onReserve}
						onUnreserve={onUnreserve}
						pending={reserving}
						reserved={reserved}
						value={handle}
					/>
				</div>
			) : null,
			id: "handle",
			label: "Reserve your handle",
		},
		// Nothing to share until the server has minted a link, so the step is absent
		// rather than present-and-empty.
		...(referralUrl
			? [
					{
						content: (
							<div className="flex flex-col gap-3">
								<PageHeader
									subtitle="Want in faster? Every friend who joins on your link moves you up the queue."
									title="Share your link"
								/>
								{/* The username reel: the handle on the pass is the same name
								    everyone on your link can now claim for themselves. A short
								    reel keeps it in the room without stealing the step. */}
								<div className="flex items-center gap-3">
									<UsernameMarquee height={80} speed={1.5} />
									<p className="text-muted-foreground text-xs">
										Claim your username before it&apos;s taken.
									</p>
								</div>
								{/* The link as an object you press, not a text field you are
								    invited to edit. A read-only input asks to be selected and
								    copied by hand; this is one big target that does the
								    copying, with the code carrying the weight and the origin
								    dimmed behind it. */}
								{/* The invite row wears the BEAM rather than the metal ring: it
								    is the one control on this screen whose whole job is to be
								    pressed, and a beam travelling round its edge points at it in
								    a way a static chrome band does not. `md` is the rotate
								    family's full-border preset. */}
								<BorderBeam
									borderRadius={REFERRAL_RADIUS_PX}
									size="md"
									theme={metalTheme === "auto" ? "auto" : metalTheme}
								>
									<button
										className="flex h-16 w-full items-center justify-between gap-3 bg-muted px-5 text-left transition-colors hover:bg-[color-mix(in_oklab,var(--muted),var(--foreground)_5%)] focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
										onClick={onCopyReferral}
										style={{ borderRadius: `${REFERRAL_FACE_RADIUS_PX}px` }}
										type="button"
									>
										<span className="min-w-0 truncate">
											<span className="text-muted-foreground">
												{link.origin}
											</span>
											<span className="font-medium">{link.code}</span>
										</span>
										<span className="shrink-0 text-muted-foreground text-sm">
											{copied ? "Copied" : "Copy"}
										</span>
									</button>
								</BorderBeam>
								{/* The referral count rides on the button rather than sitting
								    in a tile of its own: it is the score for the action the
								    button performs, and it is private, so it does not belong
								    on the pass. */}
								<Button
									className="w-full"
									onClick={onShare}
									size="lg"
									type="button"
								>
									{/* Rotated 45°: upright the ticket reads as a stub, angled it
									    reads as one being handed over. */}
									<HugeiconsIcon
										className="rotate-45 text-current"
										icon={Ticket01Icon}
										size={18}
										strokeWidth={2}
									/>
									Share your pass
									<span className="text-primary-foreground/70 tabular-nums">
										({formatCount(referralCount) ?? "—"}{" "}
										{referralCount === 1 ? "friend" : "friends"} referred)
									</span>
								</Button>
							</div>
						),
						id: "share",
						label: "Share your link",
					},
				]
			: []),
		...(questsContent
			? [
					{
						content: <div className="flex flex-col gap-4">{questsContent}</div>,
						id: "quests",
						label: "Quests",
					},
				]
			: []),
		...(onUpgrade && onLifetimeAccess
			? [
					{
						content: (
							<div className="flex flex-col gap-4">
								<PageHeader
									subtitle="Choose any paid plan and get access as soon as your payment is confirmed."
									title="Upgrade now for instant access"
								/>
								<div className="flex flex-col gap-4 rounded-2xl border border-primary/20 bg-primary/5 p-5">
									<div>
										<p className="font-medium">Skip the waitlist</p>
										<p className="mt-1 text-muted-foreground text-sm">
											Your account leaves the waitlist as soon as payment is
											confirmed.
										</p>
									</div>
									<div className="flex flex-wrap gap-2">
										<Button onClick={onUpgrade} size="lg">
											Upgrade to Pro
										</Button>
										<Button
											onClick={onLifetimeAccess}
											size="lg"
											variant="outline"
										>
											Get Lifetime Access
										</Button>
									</div>
								</div>
							</div>
						),
						id: "upgrade",
						label: "Upgrade",
					},
				]
			: []),
		...(leaderboardEnabled && onOpenLeaderboard
			? [
					{
						content: (
							<div className="flex flex-col gap-3">
								<PageHeader
									subtitle="The top 100 waitlist members by points."
									title="Leaderboard"
								/>
								<p className="text-muted-foreground text-sm">
									Open the leaderboard to see who is leading the queue.
								</p>
							</div>
						),
						id: "leaderboard",
						label: "Leaderboard",
					},
				]
			: []),
	];
	const selectedStep = steps.some((step) => step.id === activeStep)
		? activeStep
		: "access";

	return (
		<div
			className={cn(
				"relative flex min-h-full items-center justify-center px-4 py-12",
				className
			)}
		>
			{userNav ? <div className="absolute top-4 right-4">{userNav}</div> : null}

			{onBack ? (
				// Way out. The queue is a dead end otherwise: everything else on the
				// screen is an action inside the waitlist, with nothing pointing back at
				// the marketing site.
				<Button
					className="absolute top-4 left-4 text-muted-foreground"
					onClick={onBack}
					type="button"
					variant="ghost"
				>
					<HugeiconsIcon icon={ArrowLeft02Icon} size={18} />
					Back
				</Button>
			) : null}

			<div className="mx-auto grid w-full max-w-5xl items-center gap-14 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] md:gap-24">
				<div className="mx-auto w-full max-w-sm md:mx-0">
					<WaitlistPass
						avatarSeed={avatarSeed}
						avatarUrl={avatarUrl}
						joinedAt={joinedAt}
						metalTheme={metalTheme}
						name={userName}
						position={position ?? null}
						totalWaiting={totalWaiting ?? null}
						username={reserved}
					/>
				</div>

				<div className="flex w-full flex-col gap-4">
					{/* The strip sits ABOVE the header on purpose: each step carries its
					    own `PageHeader` as the first thing in its panel, so the heading
					    always names what you are looking at rather than describing the
					    screen in general. Reading order is therefore steps, then the
					    heading for the step you are on, then its controls. */}
					<Tabs
						onValueChange={(next) => {
							const value = String(next);
							setChosenStep(value);
							if (value === "leaderboard") {
								onOpenLeaderboard?.();
							}
						}}
						value={selectedStep}
					>
						<TabsList className="w-full" manageLayout={false} variant="stepper">
							{steps.map((step) => (
								<TabsTrigger key={step.id} value={step.id}>
									{step.label}
								</TabsTrigger>
							))}
						</TabsList>
						{steps.map((step) => (
							<TabsContent className="mt-8" key={step.id} value={step.id}>
								{step.content}
							</TabsContent>
						))}
					</Tabs>
				</div>
			</div>
		</div>
	);
}
