"use client";

import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Item } from "@ryu/ui/components/item.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { ReferralPass } from "@ryu/ui/components/referral-pass.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import {
	SensitiveDataScope,
	SensitiveValue,
} from "@ryu/ui/components/sensitive-value.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Copy, Gift, Wallet } from "lucide-react";
import { type ReactNode, useState } from "react";
import { sileo } from "sileo";
import { z } from "zod";
import type { CommissionRule } from "../utils/api-client.ts";
import { settingsApi } from "../utils/api-client.ts";
import { ReferralCreditsSection } from "./shared/referral-credits-section.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-rows.tsx";

export interface ReferralsTabProps {
	/**
	 * Name printed on the invite pass. Optional because neither surface's tab
	 * owns a session — the desktop dialog and the web profile page each already
	 * have the signed-in user on hand and pass it down. Absent, the card renders
	 * unpersonalised rather than guessing.
	 */
	holderName?: string | null;
	/**
	 * The pass's metal ring follows the app's RESOLVED theme, not the OS. Both
	 * shells have a manual toggle that can disagree with `prefers-color-scheme`,
	 * and the ring is the one part of the card that cannot read the difference on
	 * its own — see `PassCardShell.metalTheme`.
	 */
	metalTheme?: "auto" | "dark" | "light";
	onOpenExternal?: (url: string) => Promise<void> | void;
	/**
	 * Open the surface's own payouts view for the organization that receives
	 * commission payouts (web: Stripe's embedded Connect components in a
	 * modal). Absent, payout setup opens Stripe's hosted onboarding link
	 * through `onOpenExternal` (or a new tab).
	 */
	onOpenPayouts?: (payoutOrgId: string) => Promise<void> | void;
}

const DASHBOARD_KEY = ["affiliate", "dashboard"] as const;
/**
 * The SAME key `ReferralCreditsSection` reads under. React Query dedupes on it,
 * so the pass's two footer numbers cost no second request — and can never
 * disagree with the list of referees rendered a few hundred pixels below them.
 */
const CREDITS_KEY = ["referrals", "credits"] as const;
const MICRO_USD_PER_USD = 1_000_000;
const DEFAULT_COMMISSION_TITLE_ID = "referrals-default-commission";
const DEFAULT_COMMISSION_TOGGLE_ID = "referrals-default-commission-toggle";
const DEFAULT_COMMISSION_EDITOR_ID = "referrals-default-commission-editor";

/**
 * MICRO-USD, not the minor units `formatMoney` takes. Kept apart for the reason
 * `referral-credits-section.tsx` states: a $15 reward through the cents
 * formatter reads as $0.15, which looks like a much worse reward rather than a
 * bug.
 */
function formatCreditsUsd(microUsd: number): string {
	const dollars = microUsd / MICRO_USD_PER_USD;
	try {
		return new Intl.NumberFormat(undefined, {
			style: "currency",
			currency: "USD",
			maximumFractionDigits: dollars % 1 === 0 ? 0 : 2,
		}).format(dollars);
	} catch {
		return `$${dollars.toFixed(2)}`;
	}
}

function formatMoney(minor: number, currency: string): string {
	const code = (currency || "usd").toUpperCase();
	try {
		return new Intl.NumberFormat(undefined, {
			style: "currency",
			currency: code,
		}).format(minor / 100);
	} catch {
		return `${(minor / 100).toFixed(2)} ${code}`;
	}
}

const STATUS_VARIANTS = {
	pending: "secondary",
	approved: "default",
	paid: "default",
	reversed: "destructive",
	rejected: "destructive",
} satisfies Record<string, "default" | "secondary" | "outline" | "destructive">;

function commissionStatusVariant(
	status: string
): "default" | "secondary" | "outline" | "destructive" {
	return (
		Object.entries(STATUS_VARIANTS).find(([key]) => key === status)?.[1] ??
		"outline"
	);
}

const DEFAULT_RULE: CommissionRule = {
	type: "percent",
	value: 2000,
	recurring: false,
	durationMonths: null,
	fundedBy: "seller",
};

/**
 * The cash program's opt-in. It is a SECTION, not a gate: credit rewards are
 * attributed from the share code at sign-up and pay whether or not this is ever
 * enabled, so an early return here would hide credits the user already earned —
 * and would make the two rewards look like two unrelated programs.
 */
function EnableAffiliateSection({
	onEnable,
	pending,
}: {
	onEnable: () => void;
	pending: boolean;
}) {
	return (
		<SettingsSection
			caption="Your credit rewards are already running. Turn on the affiliate program and the same link also pays you a cash commission when a referred friend subscribes — both rewards, one referral."
			title="Add cash commission to the same link"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Button
							loading={pending}
							onClick={onEnable}
							size="sm"
							type="button"
						>
							{!pending && <Gift className="size-4" />}
							Enable cash commission
						</Button>
					}
					title="Affiliate program"
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}

/**
 * One editor field as a settings row: its label on the left (kept a real
 * `label` for the control's accessible name), the control on the right. Not a
 * `SettingsItem` because that title clamps to one line, and these labels carry
 * instructions ("blank = forever") that must stay readable at phone width.
 */
function CommissionFieldRow({
	children,
	htmlFor,
	label,
}: {
	children: ReactNode;
	htmlFor: string;
	label: ReactNode;
}) {
	return (
		<Item purpose="settings-row" size="sm">
			<div className="flex w-full items-center justify-between gap-3">
				<Label className="min-w-0 flex-1 leading-snug" htmlFor={htmlFor}>
					{label}
				</Label>
				<div className="shrink-0">{children}</div>
			</div>
		</Item>
	);
}

export function ReferralsTab(props: ReferralsTabProps) {
	return (
		<SensitiveDataScope>
			<ReferralsTabContent {...props} />
		</SensitiveDataScope>
	);
}

function ReferralsTabContent({
	holderName,
	metalTheme = "auto",
	onOpenExternal,
	onOpenPayouts,
}: ReferralsTabProps) {
	const queryClient = useQueryClient();
	const [copied, setCopied] = useState(false);
	const [editorOpen, setEditorOpen] = useState(false);
	const [rule, setRule] = useState<CommissionRule>(DEFAULT_RULE);

	const { data, isError, isLoading, refetch } = useQuery({
		queryKey: DASHBOARD_KEY,
		queryFn: settingsApi.affiliate.get,
	});
	// The pass's footer facts. Deliberately NOT gated on the affiliate opt-in:
	// credit attribution runs from sign-up whether or not the cash program is on,
	// so a card that showed nothing until someone enabled commissions would be
	// hiding referrals they already have.
	const { data: credits } = useQuery({
		queryKey: CREDITS_KEY,
		queryFn: settingsApi.referrals.credits,
	});

	const invalidate = () =>
		queryClient.invalidateQueries({ queryKey: DASHBOARD_KEY });

	const openExternal = async (url: string) => {
		if (onOpenExternal) {
			await onOpenExternal(url);
			return;
		}
		window.open(url, "_blank", "noopener,noreferrer");
	};

	const enableMutation = useMutation({
		mutationFn: settingsApi.affiliate.enable,
		onSuccess: () => {
			invalidate();
			sileo.success({ title: "Affiliate program enabled" });
		},
		onError: (e) =>
			sileo.error({
				title: e instanceof Error ? e.message : "Failed to enable program",
			}),
	});

	const onboardMutation = useMutation({
		mutationFn: () =>
			settingsApi.affiliate.onboard({
				returnUrl: window.location.href,
				refreshUrl: window.location.href,
			}),
		// The onboard call also binds the active organization as the payout org,
		// so it runs on both paths; an in-app surface then opens its own payouts
		// view for that org instead of Stripe's hosted link.
		onSuccess: async (result) => {
			invalidate();
			if (onOpenPayouts) {
				await onOpenPayouts(result.payoutOrgId);
				return;
			}
			await openExternal(result.url);
		},
		onError: (e) =>
			sileo.error({
				title: e instanceof Error ? e.message : "Failed to start onboarding",
			}),
	});

	const payoutMutation = useMutation({
		mutationFn: settingsApi.affiliate.payout,
		onSuccess: () => {
			invalidate();
			sileo.success({ title: "Payout started" });
		},
		onError: (e) =>
			sileo.error({
				title: e instanceof Error ? e.message : "Failed to start payout",
			}),
	});

	const commissionMutation = useMutation({
		mutationFn: (next: CommissionRule | null) =>
			settingsApi.affiliate.setDefaultCommission(next),
		onSuccess: () => {
			invalidate();
			sileo.success({ title: "Default commission saved" });
		},
		onError: (e) =>
			sileo.error({
				title: e instanceof Error ? e.message : "Failed to save commission",
			}),
	});

	const handleCopy = async () => {
		if (!data?.referralLink) {
			return;
		}
		await navigator.clipboard.writeText(data.referralLink);
		setCopied(true);
		setTimeout(() => setCopied(false), 1800);
	};

	const openEditor = () => {
		setRule(data?.defaultCommission ?? DEFAULT_RULE);
		setEditorOpen((prev) => !prev);
	};

	if (isLoading) {
		return (
			<SettingsCard>
				<div className="flex items-center justify-center py-6">
					<Spinner className="size-5" />
				</div>
			</SettingsCard>
		);
	}

	if (isError || !data) {
		return (
			<SettingsCard className="flex items-center justify-between gap-3">
				<p className="text-muted-foreground text-sm">
					Couldn't load your affiliate dashboard. Please try again.
				</p>
				<Button
					className="shrink-0"
					onClick={() => void refetch()}
					size="sm"
					type="button"
					variant="outline"
				>
					Retry
				</Button>
			</SettingsCard>
		);
	}

	const { stats, payout } = data;
	const payoutsActive = payout.onboardingStatus === "active";
	const canManagePayouts = Boolean(onOpenPayouts && data.payoutOrgId);

	return (
		<div className="space-y-6">
			{/* THE INVITE IS AN OBJECT, NOT A FORM FIELD. This was a read-only input
		    with a Copy button — the same control the app uses for an API key,
		    which is a thing you hide, where a referral is the one artefact whose
		    whole job is to be shown to another person. It is now the same
		    laminated, turning pass the waitlist queue hands out, printed with the
		    member's own code. The full LINK is still what Copy puts on the
		    clipboard; the card carries the code, which is the part a person
		    repeats out loud. */}
			<SettingsSection
				caption={
					<>
						One link, two rewards. You earn Ryu credits when a friend who signed
						up through it becomes a paying customer
						{data.enabled
							? ", plus a cash commission on what they subscribe to."
							: "."}
						{/* Credit rewards land in the earner's PERSONAL org, always — never
					    in whichever org is active when the payout fires, which may be a
					    client's. Said here because it is surprising the first time and
					    because the Credits tab is where the money can then be moved. */}
						<span className="mt-1 block">
							Referral credits are always paid into your personal workspace.
							Move them to a company workspace any time from Credits.
						</span>
					</>
				}
				title="Your invite pass"
			>
				{/* No `overflow-hidden` anywhere on this surface (SettingsCard has
			    none): the pass is a 3D object that turns, tilts and lifts 5% under
			    the pointer, so its painted box is LARGER than the layout box it
			    occupies. Clipped, a hover sheared the corners off it and a drag to
			    turn it sliced the card in half at the panel edge. The cell below is
			    padded so the grown card has somewhere to grow into rather than only
			    unclipping into its neighbour's text. */}
				<SettingsCard>
					<div className="grid gap-6 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] md:items-center">
						{/* The gap goes on the CELL, not on the card: the pass's own className
					    lands on the perspective host that scales, so padding there would
					    inflate the transform box rather than leave room around it. */}
						<div className="py-3">
							<ReferralPass
								className="mx-auto w-full max-w-[20rem]"
								code={data.referralCode}
								earned={
									credits ? formatCreditsUsd(credits.cap.earnedMicroUsd) : null
								}
								holder={holderName}
								joined={credits?.referrals.length ?? null}
								metalTheme={metalTheme}
								referralUrl={data.referralLink}
							/>
						</div>

						<div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
							<SensitiveValue
								className="flex-1 text-sm"
								label="referral link"
								value={data.referralLink}
							/>
							<Button
								disabled={!data.referralLink}
								onClick={handleCopy}
								size="sm"
								type="button"
								variant="outline"
							>
								<Copy className="size-4" />
								{copied ? "Copied" : "Copy"}
							</Button>
						</div>
					</div>
				</SettingsCard>
			</SettingsSection>

			<ReferralCreditsSection />

			{data.enabled ? null : (
				<EnableAffiliateSection
					onEnable={() => enableMutation.mutate()}
					pending={enableMutation.isPending}
				/>
			)}

			{data.enabled ? (
				<>
					<SettingsSection
						caption="The second half of the same referral: paid in money, not credits, once a referred friend subscribes."
						title="Cash commission"
					>
						<SettingsCard>
							<dl className="grid gap-4 sm:grid-cols-3">
								<div className="space-y-1">
									<dt className="text-muted-foreground text-xs">Pending</dt>
									<dd className="font-semibold text-lg tabular-nums">
										{formatMoney(stats.pendingMinor, stats.currency)}
									</dd>
								</div>
								<div className="space-y-1">
									<dt className="text-muted-foreground text-xs">Approved</dt>
									<dd className="font-semibold text-lg tabular-nums">
										{formatMoney(stats.approvedMinor, stats.currency)}
									</dd>
								</div>
								<div className="space-y-1">
									<dt className="text-muted-foreground text-xs">Paid</dt>
									<dd className="font-semibold text-lg tabular-nums">
										{formatMoney(stats.paidMinor, stats.currency)}
									</dd>
								</div>
							</dl>
						</SettingsCard>
					</SettingsSection>

					<SettingsSection
						caption={
							payoutsActive
								? "Your Stripe account is connected and ready to receive payouts."
								: "Connect a Stripe account to receive your commission payouts."
						}
						title="Payout account"
					>
						<SettingsGroup>
							<SettingsItem
								actions={
									payoutsActive ? (
										<Badge variant="secondary">Payouts enabled</Badge>
									) : (
										<Button
											loading={onboardMutation.isPending}
											onClick={() => onboardMutation.mutate()}
											size="sm"
											type="button"
										>
											{!onboardMutation.isPending && (
												<Wallet className="size-4" />
											)}
											Set up payouts
										</Button>
									)
								}
								key="status"
								title="Status"
							/>
							{payoutsActive && canManagePayouts ? (
								<SettingsItem
									actions={
										<Button
											onClick={() => {
												if (onOpenPayouts && data.payoutOrgId) {
													void onOpenPayouts(data.payoutOrgId);
												}
											}}
											size="sm"
											type="button"
											variant="outline"
										>
											Manage payout account
										</Button>
									}
									key="manage"
									title="Stripe account"
								/>
							) : null}
							{payoutsActive ? (
								<SettingsItem
									actions={
										<Button
											disabled={stats.approvedMinor <= 0}
											loading={payoutMutation.isPending}
											onClick={() => payoutMutation.mutate()}
											size="sm"
											type="button"
										>
											{!payoutMutation.isPending && (
												<Wallet className="size-4" />
											)}
											Pay out approved balance
										</Button>
									}
									key="payout"
									title="Approved balance"
								/>
							) : null}
						</SettingsGroup>
					</SettingsSection>

					<SettingsSection
						as="section"
						caption="The commission applied to your marketplace listings unless overridden per item."
						headerAction={
							// Labelled by the section heading AND its own text, so the
							// toggle is announced as "Marketplace default commission
							// Edit" rather than a bare "Edit".
							<Button
								aria-controls={
									editorOpen ? DEFAULT_COMMISSION_EDITOR_ID : undefined
								}
								aria-expanded={editorOpen}
								aria-labelledby={`${DEFAULT_COMMISSION_TITLE_ID} ${DEFAULT_COMMISSION_TOGGLE_ID}`}
								id={DEFAULT_COMMISSION_TOGGLE_ID}
								onClick={openEditor}
								size="sm"
								type="button"
								variant="ghost"
							>
								Edit
								<ChevronDown
									className={`size-4 text-muted-foreground transition-transform ${
										editorOpen ? "rotate-180" : ""
									}`}
								/>
							</Button>
						}
						title="Marketplace default commission"
						titleId={DEFAULT_COMMISSION_TITLE_ID}
					>
						{editorOpen ? (
							<div id={DEFAULT_COMMISSION_EDITOR_ID}>
								<SettingsGroup>
									<CommissionFieldRow
										htmlFor="commission-type"
										key="type"
										label="Type"
									>
										<Select
											onValueChange={(value) =>
												setRule((prev) => ({
													...prev,
													type: z.enum(["percent", "flat"]).parse(value),
												}))
											}
											value={rule.type}
										>
											<SelectTrigger
												className="w-36"
												id="commission-type"
												size="sm"
											>
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="percent">Percent</SelectItem>
												<SelectItem value="flat">Flat</SelectItem>
											</SelectContent>
										</Select>
									</CommissionFieldRow>

									<CommissionFieldRow
										htmlFor="commission-value"
										key="value"
										label={
											rule.type === "percent"
												? "Value (basis points)"
												: "Value (cents)"
										}
									>
										<Input
											className="h-8 w-36"
											id="commission-value"
											inputMode="numeric"
											min={0}
											onChange={(e) =>
												setRule((prev) => ({
													...prev,
													value: Number(e.target.value) || 0,
												}))
											}
											type="number"
											value={rule.value}
										/>
									</CommissionFieldRow>

									<CommissionFieldRow
										htmlFor="commission-funded"
										key="funded"
										label="Funded by"
									>
										<Select
											onValueChange={(value) =>
												setRule((prev) => ({
													...prev,
													fundedBy: z.enum(["platform", "seller"]).parse(value),
												}))
											}
											value={rule.fundedBy}
										>
											<SelectTrigger
												className="w-36"
												id="commission-funded"
												size="sm"
											>
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="platform">Platform</SelectItem>
												<SelectItem value="seller">Seller</SelectItem>
											</SelectContent>
										</Select>
									</CommissionFieldRow>

									<Item
										className="cursor-pointer"
										key="recurring"
										purpose="settings-row"
										render={<label htmlFor="commission-recurring" />}
										size="sm"
									>
										<div className="flex w-full items-center justify-between gap-3">
											<span className="min-w-0 flex-1 font-medium text-sm leading-snug">
												Recurring commission
											</span>
											<Checkbox
												checked={rule.recurring}
												id="commission-recurring"
												onCheckedChange={(checked) =>
													setRule((prev) => ({
														...prev,
														recurring: checked === true,
														durationMonths:
															checked === true ? prev.durationMonths : null,
													}))
												}
											/>
										</div>
									</Item>

									<CommissionFieldRow
										htmlFor="commission-duration"
										key="duration"
										label="Duration (months, blank = forever)"
									>
										<Input
											className="h-8 w-36"
											disabled={!rule.recurring}
											id="commission-duration"
											inputMode="numeric"
											min={1}
											onChange={(e) =>
												setRule((prev) => ({
													...prev,
													durationMonths:
														e.target.value === ""
															? null
															: Number(e.target.value) || null,
												}))
											}
											placeholder="Forever"
											type="number"
											value={rule.durationMonths ?? ""}
										/>
									</CommissionFieldRow>

									{/* The editor's actions close its own card rather than
									    floating under it on the pane. */}
									<Item key="actions" purpose="settings-row" size="sm">
										<div className="flex w-full flex-wrap justify-end gap-2">
											<Button
												disabled={
													commissionMutation.isPending ||
													!data.defaultCommission
												}
												onClick={() => commissionMutation.mutate(null)}
												size="sm"
												type="button"
												variant="ghost"
											>
												Clear
											</Button>
											<Button
												loading={commissionMutation.isPending}
												onClick={() => commissionMutation.mutate(rule)}
												size="sm"
												type="button"
											>
												Save
											</Button>
										</div>
									</Item>
								</SettingsGroup>
							</div>
						) : null}
					</SettingsSection>

					<SettingsSection title="Recent commissions">
						{data.recentCommissions.length === 0 ? (
							<SettingsCard>
								<p className="text-muted-foreground text-sm">
									No commissions yet. Share your link to start earning.
								</p>
							</SettingsCard>
						) : (
							<SettingsGroup>
								{data.recentCommissions.map((commission) => (
									<SettingsItem
										actions={
											<Badge
												variant={commissionStatusVariant(commission.status)}
											>
												{commission.status}
											</Badge>
										}
										key={commission.id}
										title={commission.sourceType}
									>
										<p className="text-muted-foreground text-xs">
											{formatMoney(
												commission.commissionAmountMinor,
												commission.currency
											)}
										</p>
									</SettingsItem>
								))}
							</SettingsGroup>
						)}
					</SettingsSection>
				</>
			) : null}
		</div>
	);
}
