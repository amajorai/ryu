"use client";

import { ArrowLeft02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useState } from "react";
import { cn } from "../lib/utils.ts";
import { Button } from "./button.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs.tsx";
import { WaitlistPass } from "./waitlist-pass.tsx";
import { WaitlistOverviewStep } from "./waitlist-queue-overview.tsx";
import {
	WaitlistHandleStep,
	WaitlistLeaderboardStep,
	WaitlistShareStep,
	WaitlistUpgradeStep,
} from "./waitlist-queue-steps.tsx";

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
	/**
	 * Optional community link supplied by a host surface: an absolute http(s)
	 * URL (opens in a new tab) or a same-site path such as `/discord`.
	 */
	discordHref?: string;
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
	onPassTearComplete?: () => void;
	/** Re-read the queue. Both apps get the button; both rate-limit it here. */
	onRefresh?: () => void | Promise<void>;
	onReserve: () => void;
	onShare: () => void;
	onSignOut: () => void;
	onUnreserve?: () => void;
	/** Opens the paid plan picker supplied by the host app. */
	onUpgrade?: () => void;
	/** Optional decoration drawn over the pass, such as a seasonal companion. */
	passCompanion?: ReactNode;
	/** True after a submitted waitlist access code succeeds. */
	passTorn?: boolean;
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

export function WaitlistQueue({
	accessCodeContent,
	passCompanion,
	avatarSeed,
	avatarUrl,
	className,
	questsContent,
	discordHref,
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
	onPassTearComplete,
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
	passTorn = false,
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
	/**
	 * The step the member steered to, if any. Null means "follow my progress" —
	 * see `activeStep`. Held as a plain id rather than an index so a strip that
	 * drops its share step (no referral link yet) cannot shift the selection onto
	 * a different panel behind the member's back.
	 */
	const [chosenStep, setChosenStep] = useState<string | null>(null);
	// Once a handle is claimed, that IS the headline — it is the newest and most
	// specific thing true about this user, and repeating "you're in line" under it
	// says nothing the position on the pass does not already say.
	let headerTitle = "You're on the waitlist";
	if (reserved) {
		headerTitle = `@${reserved} is reserved`;
	} else if (userName) {
		headerTitle = `You're in line, ${userName}`;
	}

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
				<WaitlistOverviewStep
					discordHref={discordHref}
					error={error}
					eta={eta}
					hasApplied={hasApplied}
					loaded={loaded}
					metalTheme={metalTheme}
					onApply={onApply}
					onRefresh={onRefresh}
					onSignOut={onSignOut}
					signingOut={signingOut}
					subtitle={subtitle}
					title={headerTitle}
					totalWaiting={totalWaiting}
				/>
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
				<WaitlistHandleStep
					handle={handle}
					handleError={handleError}
					onChangeHandle={onChangeHandle}
					onReserve={onReserve}
					onUnreserve={onUnreserve}
					reserved={reserved}
					reserving={reserving}
				/>
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
							<WaitlistShareStep
								copied={copied}
								metalTheme={metalTheme}
								onCopyReferral={onCopyReferral}
								onShare={onShare}
								referralCount={referralCount}
								referralUrl={referralUrl}
							/>
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
							<WaitlistUpgradeStep
								onLifetimeAccess={onLifetimeAccess}
								onUpgrade={onUpgrade}
							/>
						),
						id: "upgrade",
						label: "Upgrade",
					},
				]
			: []),
		...(leaderboardEnabled && onOpenLeaderboard
			? [
					{
						content: <WaitlistLeaderboardStep />,
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
				<div className="relative mx-auto w-full max-w-sm md:mx-0">
					{passCompanion}
					<WaitlistPass
						avatarSeed={avatarSeed}
						avatarUrl={avatarUrl}
						joinedAt={joinedAt}
						metalTheme={metalTheme}
						name={userName}
						onTearComplete={onPassTearComplete}
						position={position ?? null}
						referralUrl={referralUrl}
						torn={passTorn}
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
