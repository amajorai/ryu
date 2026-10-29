"use client";

import { Badge } from "@ryu/ui/components/badge.tsx";
import { Progress } from "@ryu/ui/components/progress.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useQuery } from "@tanstack/react-query";
import type {
	CreditReferralDashboard,
	CreditReferralReferee,
	CreditReferralState,
} from "../../utils/api-client.ts";
import { settingsApi } from "../../utils/api-client.ts";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./settings-rows.tsx";

/**
 * The CREDIT half of the referral program, rendered alongside the cash
 * commissions in `ReferralsTab` — one link, one attribution, two payouts.
 *
 * It is deliberately NOT gated on the affiliate opt-in. Credit attribution is
 * stamped at sign-up from the share code and pays without anyone enabling
 * anything, so hiding this behind the cash program's toggle would hide credits a
 * user has already earned.
 */

const CREDITS_KEY = ["referrals", "credits"] as const;
const MICRO_USD_PER_USD = 1_000_000;

/**
 * MICRO-USD, not the minor units `formatMoney` takes. Named apart from it on
 * purpose: run a $15.00 credit reward through the cents formatter and it reads
 * as $0.15, which looks like a real (and much worse) reward rather than a bug.
 */
function formatCredits(microUsd: number): string {
	const dollars = microUsd / MICRO_USD_PER_USD;
	try {
		return new Intl.NumberFormat(undefined, {
			style: "currency",
			currency: "USD",
		}).format(dollars);
	} catch {
		return `$${dollars.toFixed(2)}`;
	}
}

function formatDate(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return "";
	}
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
	}).format(date);
}

/**
 * THREE OF THESE FOUR ARE NOT REFUSALS, and the labels have to carry that.
 * `pending` and `activated` are both still owed the reward — the first waits on
 * the friend to pay, the second waits on Ryu to mint — so neither may read like
 * `denied`, which is the only state that will never pay. The old "Not paid" for
 * denied against "Waiting on them" for pending put the two a hair apart in a
 * list where they sit next to each other; the wording (and the badge variant)
 * now match the web dashboard's, so the same referral reads the same on both
 * surfaces.
 */
const STATE_LABELS = {
	pending: "In progress",
	activated: "On the way",
	paid: "Earned",
	denied: "Closed",
} satisfies Record<CreditReferralState, string>;

const STATE_VARIANTS = {
	pending: "secondary",
	activated: "secondary",
	// `outline` and not `destructive`: a closed referral is a payout that will
	// not happen, not a verdict on the person who used the link.
	denied: "outline",
	paid: "default",
} satisfies Record<CreditReferralState, "default" | "secondary" | "outline">;

/**
 * `deniedReason` is an internal code and one of its values is "fraud". A user
 * reading that about their own friend gets an accusation we are not making, so
 * only the reason they can act on is spelled out; everything else degrades to a
 * neutral sentence.
 */
function deniedText(reason: string | null): string {
	if (reason === "cap_reached") {
		return "You'd already earned the maximum referral credits.";
	}
	return "This referral wasn't eligible for credits.";
}

function stateDetail(referee: CreditReferralReferee): string {
	switch (referee.state) {
		case "paid":
			return referee.paidAt
				? `Paid ${formatDate(referee.paidAt)}`
				: "Credits added to your balance";
		case "activated":
			return "They're a paying customer — your credits are being added.";
		case "denied":
			return deniedText(referee.deniedReason);
		default:
			return "Credits arrive once they become a paying customer.";
	}
}

function RefereeRow({ referee }: { referee: CreditReferralReferee }) {
	return (
		<SettingsItem
			actions={
				<>
					{referee.amountMicroUsd === null ? null : (
						<span className="font-heading font-medium text-sm tabular-nums">
							{formatCredits(referee.amountMicroUsd)}
						</span>
					)}
					<Badge variant={STATE_VARIANTS[referee.state]}>
						{STATE_LABELS[referee.state]}
					</Badge>
				</>
			}
			title={<span title={referee.label}>{referee.label}</span>}
		>
			<p className="text-muted-foreground text-xs">
				{stateDetail(referee)}
				{referee.joinedAt ? ` · Joined ${formatDate(referee.joinedAt)}` : ""}
			</p>
		</SettingsItem>
	);
}

/** The reward terms, phrased from the campaign rows so a closed side goes quiet. */
function rewardTermsText(reward: CreditReferralDashboard["reward"]): string {
	const parts: string[] = [];
	if (reward.referrerMicroUsd !== null) {
		parts.push(
			`You earn ${formatCredits(reward.referrerMicroUsd)} in Ryu credits each time someone who signed up with your link becomes a paying customer.`
		);
	}
	if (reward.refereeMicroUsd !== null) {
		parts.push(
			`Their new account starts with ${formatCredits(reward.refereeMicroUsd)} in credits.`
		);
	}
	return parts.length > 0
		? parts.join(" ")
		: "Credit rewards are paused right now. Anyone already waiting keeps their place.";
}

function CapSummary({ cap }: { cap: CreditReferralDashboard["cap"] }) {
	// BRANCH on the uncapped case — a `0` ceiling means no limit, and both
	// subtracting and dividing against it are wrong (negative headroom, NaN).
	const usedPercent =
		cap.uncapped || cap.capMicroUsd <= 0
			? 0
			: Math.min(Math.round((cap.earnedMicroUsd / cap.capMicroUsd) * 100), 100);

	return (
		<SettingsCard className="space-y-3">
			<dl className="grid gap-4 sm:grid-cols-2">
				<div className="space-y-1">
					<dt className="text-muted-foreground text-xs">Credits earned</dt>
					<dd className="font-heading font-semibold text-lg tabular-nums">
						{formatCredits(cap.earnedMicroUsd)}
					</dd>
					<dd className="text-muted-foreground text-xs">
						{cap.paidCount === 1
							? "1 referral paid out"
							: `${cap.paidCount} referrals paid out`}
					</dd>
				</div>
				<div className="space-y-1">
					<dt className="text-muted-foreground text-xs">Still available</dt>
					<dd className="font-heading font-semibold text-lg tabular-nums">
						{cap.remainingMicroUsd === null
							? "Unlimited"
							: formatCredits(cap.remainingMicroUsd)}
					</dd>
					<dd className="text-muted-foreground text-xs">
						{cap.remainingMicroUsd === null
							? "No limit on your account"
							: `of ${formatCredits(cap.capMicroUsd)} lifetime limit`}
					</dd>
				</div>
			</dl>
			{cap.remainingMicroUsd === null ? null : (
				<Progress
					aria-label="Referral credits earned against your lifetime limit"
					className="h-2"
					value={usedPercent}
				/>
			)}
		</SettingsCard>
	);
}

export function ReferralCreditsSection() {
	const { data, isError, isLoading } = useQuery({
		queryKey: CREDITS_KEY,
		queryFn: settingsApi.referrals.credits,
	});

	return (
		<SettingsSection
			caption={
				isLoading || isError || !data
					? "Ryu credits for the friends you bring, on the same link as your cash commission."
					: rewardTermsText(data.reward)
			}
			title="Credit rewards"
		>
			{isLoading ? (
				<SettingsCard>
					<div className="flex items-center justify-center py-6">
						<Spinner className="size-5" />
					</div>
				</SettingsCard>
			) : null}

			{isError || !(isLoading || data) ? (
				<SettingsCard>
					<p className="text-muted-foreground text-sm">
						Couldn't load your credit rewards. Nothing is lost — try again in a
						moment.
					</p>
				</SettingsCard>
			) : null}

			{data ? (
				<div className="space-y-3">
					<CapSummary cap={data.cap} />
					{data.referrals.length === 0 ? (
						<SettingsCard>
							<p className="text-muted-foreground text-sm">
								Nobody has signed up with your link yet. Share it above and
								they'll show up here.
							</p>
						</SettingsCard>
					) : (
						<SettingsGroup>
							{data.referrals.map((referee) => (
								<RefereeRow key={referee.id} referee={referee} />
							))}
						</SettingsGroup>
					)}
				</div>
			) : null}
		</SettingsSection>
	);
}
