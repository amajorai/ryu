"use client";

import { Ticket01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { BorderBeam } from "border-beam";
import { goalGradient } from "../lib/goal-gradient.ts";
import { formatCount } from "../lib/number-format.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "./button.tsx";
import PageHeader from "./page-header.tsx";
import { Progress, ProgressLabel } from "./progress.tsx";
import { UsernameMarquee } from "./username-marquee.tsx";
import { WaitlistUsernameField } from "./waitlist-username-field.tsx";

/**
 * The action steps of the shared queue screen (`waitlist-queue.tsx`): reserve a
 * handle, share the invite link, upgrade, and the leaderboard pointer. Split out
 * of the screen so each panel reads on its own; the screen decides which of
 * them are present and in what order.
 */

/**
 * Radius of the invite row, in the CSS px `border-beam` wants it in:
 * `rounded-3xl` (24px). Kept in step with that class by hand, because the
 * library measures the ring itself and cannot read a Tailwind token.
 */
const REFERRAL_RADIUS_PX = 24;
const WAITLIST_REFERRAL_GOALS = [1, 3, 5, 10] as const;

/**
 * Split a referral URL into the part nobody reads and the part everybody does.
 * The scheme is dropped — nobody needs to see "https://" on a link they are
 * about to copy. Falls back to the whole string if it will not parse, so a
 * malformed link still renders rather than disappearing.
 */
const splitReferralUrl = (url: string) => {
	try {
		const parsed = new URL(url);
		return { code: parsed.pathname, origin: parsed.host };
	} catch {
		return { code: url, origin: "" };
	}
};

export function WaitlistHandleStep({
	handle,
	handleError,
	onChangeHandle,
	onReserve,
	onUnreserve,
	reserved,
	reserving,
}: {
	handle: string;
	handleError?: string | null;
	onChangeHandle: (value: string) => void;
	onReserve: () => void;
	onUnreserve?: () => void;
	reserved?: string | null;
	reserving: boolean;
}) {
	return (
		<div className="flex flex-col gap-4">
			<PageHeader
				subtitle={
					reserved
						? "It's yours the moment you're in. We'll let you know."
						: "Pick the handle you want. It's held for you from the moment you claim it."
				}
				title={reserved ? `@${reserved} is reserved` : "Reserve your handle"}
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
			{/* The username reel: names other people are claiming right now. It is
			    the nudge for THIS step, so it sits under the field it is nudging
			    toward, and leaves once the handle is yours. */}
			{reserved ? null : (
				<div className="flex items-center gap-3">
					<UsernameMarquee height={80} speed={1.5} />
					<p className="text-muted-foreground text-xs">
						Claim your username before it&apos;s taken.
					</p>
				</div>
			)}
		</div>
	);
}

function referralGoalMessage(goal: ReturnType<typeof goalGradient>): string {
	if (goal.complete) {
		return "You reached the 10-referral checkpoint. Keep sharing as new people join.";
	}
	if (goal.remaining === 1) {
		return "One more friend reaches your next checkpoint.";
	}
	if (goal.current === 0) {
		return "Invite one friend to start moving up the queue.";
	}
	return `${goal.remaining} more friends reach your next checkpoint.`;
}

export function WaitlistShareStep({
	copied,
	metalTheme,
	onCopyReferral,
	onShare,
	referralCount,
	referralUrl,
}: {
	copied: boolean;
	metalTheme: "auto" | "dark" | "light";
	onCopyReferral: () => void;
	onShare: () => void;
	referralCount: number;
	referralUrl: string;
}) {
	const link = splitReferralUrl(referralUrl);
	const referralGoal = goalGradient(referralCount, WAITLIST_REFERRAL_GOALS);
	return (
		<div className="flex flex-col gap-3">
			<PageHeader
				subtitle="Want in faster? Every friend who joins on your link moves you up the queue."
				title="Share your link"
			/>
			<div
				className={cn(
					"rounded-2xl border p-4 transition-colors",
					referralGoal.nearGoal
						? "border-primary/40 bg-primary/10"
						: "border-border bg-muted/30"
				)}
				data-goal-gradient="waitlist-referrals"
			>
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<p className="font-medium text-sm">Your next queue goal</p>
						<p className="mt-1 text-muted-foreground text-sm">
							{referralGoalMessage(referralGoal)}
						</p>
					</div>
					<span className="shrink-0 rounded-full bg-background/70 px-2.5 py-1 font-medium text-primary text-xs">
						{referralGoal.complete
							? "Checkpoint reached"
							: `${referralGoal.remaining} to go`}
					</span>
				</div>
				<Progress className="mt-4 gap-2" value={referralGoal.progressPercent}>
					<ProgressLabel className="text-xs">
						<span>
							{formatCount(referralGoal.current) ?? "—"}{" "}
							{referralGoal.current === 1 ? "referral" : "referrals"}
						</span>
						<span className="text-muted-foreground">
							{referralGoal.target === null
								? " / keep climbing"
								: ` / ${referralGoal.target}`}
						</span>
					</ProgressLabel>
				</Progress>
				<p className="mt-3 text-muted-foreground text-xs">
					Each confirmed signup can move you up the waitlist.
				</p>
			</div>
			{/* The link as an object you press, not a text field you are invited to
			    edit: one big target that does the copying, with the code carrying
			    the weight and the origin dimmed behind it. It wears the BEAM rather
			    than the metal ring because it is the one control on this screen
			    whose whole job is to be pressed. The link is meant to be shared, so
			    it is shown in full rather than masked. */}
			<BorderBeam
				borderRadius={REFERRAL_RADIUS_PX}
				size="md"
				theme={metalTheme === "auto" ? "auto" : metalTheme}
			>
				<button
					className="flex h-16 w-full items-center justify-between gap-3 rounded-[23px] bg-muted px-5 text-left transition-colors hover:bg-[color-mix(in_oklab,var(--muted),var(--foreground)_5%)] focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring"
					onClick={onCopyReferral}
					type="button"
				>
					<span className="min-w-0 truncate">
						<span className="text-muted-foreground">{link.origin}</span>
						<span className="font-medium">{link.code}</span>
					</span>
					<span className="shrink-0 text-muted-foreground text-sm">
						{copied ? "Copied" : "Copy"}
					</span>
				</button>
			</BorderBeam>
			{/* The referral count rides on the button rather than sitting in a tile
			    of its own: it is the score for the action the button performs. */}
			<Button className="w-full" onClick={onShare} size="lg" type="button">
				{/* Rotated 45°: upright the ticket reads as a stub, angled it reads
				    as one being handed over. */}
				<HugeiconsIcon
					className="rotate-45 text-current"
					icon={Ticket01Icon}
					size={18}
					strokeWidth={2}
				/>
				{referralGoal.nearGoal ? "Finish the checkpoint" : "Share your pass"}
				<span className="text-primary-foreground/70 tabular-nums">
					({formatCount(referralCount) ?? "—"}{" "}
					{referralCount === 1 ? "friend" : "friends"} referred)
				</span>
			</Button>
		</div>
	);
}

export function WaitlistUpgradeStep({
	onLifetimeAccess,
	onUpgrade,
}: {
	onLifetimeAccess: () => void;
	onUpgrade: () => void;
}) {
	return (
		<div className="flex flex-col gap-4">
			<PageHeader
				subtitle="Choose any paid plan and get access as soon as your payment is confirmed."
				title="Upgrade now for instant access"
			/>
			<div className="flex flex-col gap-4 rounded-2xl border border-primary/20 bg-primary/5 p-5">
				<div>
					<p className="font-medium">Skip the waitlist</p>
					<p className="mt-1 text-muted-foreground text-sm">
						Your account leaves the waitlist as soon as payment is confirmed.
					</p>
				</div>
				<div className="flex flex-wrap gap-2">
					<Button onClick={onUpgrade} size="lg">
						Upgrade to Pro
					</Button>
					<Button onClick={onLifetimeAccess} size="lg" variant="outline">
						Get Lifetime Access
					</Button>
				</div>
			</div>
		</div>
	);
}

export function WaitlistLeaderboardStep() {
	return (
		<div className="flex flex-col gap-3">
			<PageHeader
				subtitle="The top 100 waitlist members by points."
				title="Leaderboard"
			/>
			<p className="text-muted-foreground text-sm">
				Open the leaderboard to see who is leading the queue.
			</p>
		</div>
	);
}
