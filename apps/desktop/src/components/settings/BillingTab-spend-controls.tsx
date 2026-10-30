import { Share08Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { settingsApi } from "@ryu/settings";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useCallback, useEffect, useState } from "react";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { useStepUp } from "@/src/components/StepUpDialog.tsx";
import { useCreditsWallet } from "@/src/hooks/useCreditsWallet.ts";
import {
	type AutoTopupSettings,
	fetchAutoTopup,
	formatMicroUsd,
	MAX_TOPUP_DOLLARS,
	MIN_TOPUP_DOLLARS,
	putAutoTopup,
} from "@/src/lib/api/credits.ts";
import { useActiveOrgId } from "@/src/lib/api/orgs.ts";
import { LowBalanceAlertCard } from "./BillingTab-low-balance-alert.tsx";
import { useSandboxRunBudget } from "./BillingTab-sandbox-budget.ts";
import {
	centsToDollarText,
	DollarField,
	dollarTextToCents,
	errorText,
} from "./BillingTab-spend-shared.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

const AUTOTOPUP_MIN_CENTS = MIN_TOPUP_DOLLARS * 100;
const AUTOTOPUP_MAX_CENTS = MAX_TOPUP_DOLLARS * 100;

/**
 * What an org with NO auto-recharge record reads as — the same values the card
 * mounts with. Named for the same reason as {@link ALERT_DEFAULTS}: the mount
 * and the per-switch reset must land in the identical place.
 */
const AUTOTOPUP_DEFAULTS = {
	capText: "0",
	enabled: false,
	thresholdText: centsToDollarText(AUTOTOPUP_MIN_CENTS),
	topupText: centsToDollarText(AUTOTOPUP_MIN_CENTS * 2),
};

/**
 * Spend controls (sandbox metering & billing rail, area E). Shows the live
 * wallet balance, an "Automatic recharge" card (off-session Polar top-up when the
 * balance runs low, bounded by an optional monthly cap), and the per-run default
 * sandbox budget. Auto-recharge is a control-plane concern (`/api/credits/autotopup`,
 * bearer-authed, admin-only to change); the sandbox budget is a Core node
 * preference ("what runs"), written here and read by Core per run.
 */
export function SpendControlsSection() {
	const {
		wallet,
		authed,
		loading: walletLoading,
		refresh: refreshWallet,
	} = useCreditsWallet();
	const tl = useLiteralMessages();
	const activeOrgId = useActiveOrgId();

	const [settings, setSettings] = useState<AutoTopupSettings | null>(null);
	const [enabled, setEnabled] = useState(AUTOTOPUP_DEFAULTS.enabled);
	const [thresholdText, setThresholdText] = useState(
		AUTOTOPUP_DEFAULTS.thresholdText
	);
	const [topupText, setTopupText] = useState(AUTOTOPUP_DEFAULTS.topupText);
	const [capText, setCapText] = useState(AUTOTOPUP_DEFAULTS.capText);
	const [saving, setSaving] = useState(false);
	const [loadingSettings, setLoadingSettings] = useState(false);
	const [portalPending, setPortalPending] = useState(false);
	const stepUp = useStepUp();

	// Load the org's auto-recharge settings (control plane). A non-authed user has
	// no wallet to recharge, so skip the fetch and leave the defaults in place.
	//
	// CLEAR FIRST, THEN LOAD. `activeOrgId` is a re-run key for the same reason as
	// the alert card above: auto-recharge is stored per org, resolved from the
	// session, and this card holds it in plain state that no cache invalidation
	// can reach. The reset in front of the fetch is what makes that re-run mean
	// anything — BOTH paths out of the fetch can decline to set state
	// (`fetchAutoTopup` resolves to NULL for an org that never configured
	// auto-recharge, and the `.catch` covers a 403 for a non-admin / offline), so
	// without it the card would assert the previous org's ON switch and amounts
	// over an org that has no record at all. And `handleFieldBlur` would then POST
	// that record — including `settings?.cooldownSec`, which is why `settings`
	// itself must be cleared too — silently ENABLING auto-recharge on the new org.
	useEffect(() => {
		setSettings(null);
		setEnabled(AUTOTOPUP_DEFAULTS.enabled);
		setThresholdText(AUTOTOPUP_DEFAULTS.thresholdText);
		setTopupText(AUTOTOPUP_DEFAULTS.topupText);
		setCapText(AUTOTOPUP_DEFAULTS.capText);
		if (!authed) {
			return;
		}
		let cancelled = false;
		setLoadingSettings(true);
		fetchAutoTopup()
			.then((s) => {
				if (cancelled || !s) {
					return;
				}
				setSettings(s);
				setEnabled(s.enabled);
				setThresholdText(
					centsToDollarText(s.thresholdCents || AUTOTOPUP_MIN_CENTS)
				);
				setTopupText(
					centsToDollarText(s.amountCents || AUTOTOPUP_MIN_CENTS * 2)
				);
				setCapText(centsToDollarText(s.monthlyCapCents));
			})
			.catch(() => {
				// A load failure (offline / no org) just leaves the defaults reset
				// above; the user can still see the card. Saves surface their own toast.
			})
			.finally(() => {
				if (!cancelled) {
					setLoadingSettings(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [authed, activeOrgId]);

	// The balance printed below comes from `useCreditsWallet`, which is also plain
	// state — and its own load effect has no active-org dependency, so it is
	// frozen to whichever org was active when it first ran. Re-pull it here on a
	// switch, or this card keeps showing the previous workspace's money next to
	// the new workspace's recharge settings.
	//
	// Deliberately a LOCAL re-pull and not the single-point fix: the same hook
	// backs the nav-user chip, the credits page, the node selector and onboarding,
	// all of which stay stale until the hook keys its own load on the active org.
	useEffect(() => {
		if (!activeOrgId) {
			return;
		}
		refreshWallet().catch(() => undefined);
	}, [activeOrgId, refreshWallet]);

	const { budgetEdit, budgetText, saveBudget, setBudgetDirty, setBudgetText } =
		useSandboxRunBudget();

	// Persist the auto-recharge settings. Enabling validates the amounts (mirroring
	// the server's $5–$1000 bounds) before the call so bad input never reaches
	// Polar; returns whether the save succeeded so the toggle can roll back.
	const commit = useCallback(
		async (nextEnabled: boolean): Promise<boolean> => {
			const amountCents = dollarTextToCents(topupText);
			const thresholdCents = dollarTextToCents(thresholdText);
			const monthlyCapCents = Math.max(0, dollarTextToCents(capText));
			if (nextEnabled) {
				if (
					amountCents < AUTOTOPUP_MIN_CENTS ||
					amountCents > AUTOTOPUP_MAX_CENTS
				) {
					toast.error(
						// biome-ignore lint/suspicious/noTemplateCurlyInString: ICU message with a literal dollar sign before each amount placeholder.
						tl("Recharge amount must be between ${min} and ${max}.", {
							min: String(MIN_TOPUP_DOLLARS),
							max: String(MAX_TOPUP_DOLLARS),
						})
					);
					return false;
				}
				if (thresholdCents <= 0) {
					toast.error("Set a balance threshold above $0.");
					return false;
				}
			}
			setSaving(true);
			try {
				const result = await stepUp.guard("billing", () =>
					putAutoTopup({
						enabled: nextEnabled,
						amountCents,
						thresholdCents,
						monthlyCapCents,
						cooldownSec: settings?.cooldownSec,
					})
				);
				if (result === null) {
					return false;
				}
				if (result) {
					setSettings(result);
					setEnabled(result.enabled);
				} else {
					setEnabled(nextEnabled);
				}
				return true;
			} catch (e) {
				toast.error(errorText(e));
				return false;
			} finally {
				setSaving(false);
			}
		},
		[topupText, thresholdText, capText, settings, stepUp, tl]
	);

	const handleToggle = useCallback(
		(next: boolean) => {
			const previous = enabled;
			setEnabled(next);
			commit(next)
				.then((ok) => {
					if (!ok) {
						setEnabled(previous);
					}
				})
				.catch(() => setEnabled(previous));
		},
		[enabled, commit]
	);

	// Only persist edits while enabled — the server stores amounts on the enabled
	// record, so a disabled card keeps the edits locally until it is turned on.
	const handleFieldBlur = useCallback(() => {
		if (enabled) {
			commit(true).catch(() => undefined);
		}
	}, [enabled, commit]);

	const handleManagePayment = useCallback(async () => {
		setPortalPending(true);
		try {
			const portal = await stepUp.guard("billing", () =>
				settingsApi.billing.getPortalUrl()
			);
			if (portal === null) {
				return;
			}
			const { url } = portal;
			await openExternal(url);
		} catch {
			toast.error("Couldn't open the billing portal. Please try again.");
		} finally {
			setPortalPending(false);
		}
	}, [stepUp]);

	// WHOSE money is on screen — answered by the wallet the server handed back,
	// not by a local "the re-pull finished" marker. `/api/credits/wallet` always
	// returns the ACTIVE ORG's wallet (`ownerType: "org"`, `ownerId` = that org),
	// so the record carries its own provenance and the check cannot drift from it.
	//
	// A marker would lie on exactly the path this card must not lie on:
	// `useCreditsWallet.refresh` records a failed fetch in its `error` and
	// RESOLVES rather than rejecting, so a `.then()` after the re-pull runs even
	// when the new org's wallet 403'd (non-admin) or never arrived (offline) —
	// leaving the PREVIOUS org's balance on screen while the marker claimed the
	// new one. Comparing ids means a failed re-pull simply leaves the number
	// unclaimed, and the card prints "…".
	//
	// It covers the live stream too: `useWalletStream` opens once per mount and
	// stays scoped to the org it connected as, but its frames are MERGED into the
	// wallet in hand, so a post-switch push keeps the old `ownerId` and stays
	// correctly disowned here.
	//
	// `activeOrgId` null is not that case: a session with no active org resolves
	// server-side to the earliest membership, and the wallet already reflects it.
	// Nor is "no wallet yet" — that is the load/error state below, not another
	// org's money.
	const walletIsOtherOrg =
		Boolean(activeOrgId) && Boolean(wallet) && wallet?.ownerId !== activeOrgId;

	let balanceLabel = "—";
	if (!authed) {
		balanceLabel = "Sign in";
	} else if (walletIsOtherOrg || (walletLoading && !wallet)) {
		balanceLabel = "…";
	} else if (wallet) {
		balanceLabel = formatMicroUsd(wallet.balanceMicroUsd, wallet.currency);
	}

	// Open credit holds (in-flight Messaging sends) count against the balance, so a
	// send can be refused while the full balance is on screen. Say so while any
	// are open, and only for the wallet that belongs to the active org.
	const heldMicroUsd =
		authed && wallet && !walletIsOtherOrg ? (wallet.heldMicroUsd ?? 0) : 0;
	const heldLabel =
		wallet && heldMicroUsd > 0
			? formatMicroUsd(heldMicroUsd, wallet.currency)
			: null;
	const availableLabel =
		wallet && heldLabel
			? formatMicroUsd(
					wallet.availableMicroUsd ?? wallet.balanceMicroUsd - heldMicroUsd,
					wallet.currency
				)
			: null;

	// Locked while this org's record is in flight as well as while saving: the
	// fields are showing defaults then, and a save from them would write those
	// defaults — and an `enabled: true` — onto whichever org is now active.
	const fieldsDisabled = !authed || saving || loadingSettings;

	return (
		<>
			<SettingsSection
				caption="Tops up your balance so managed runs never stall. Charged to your saved card; org admins only."
				title="Automatic recharge"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<span className="text-sm tabular-nums">{balanceLabel}</span>
						}
						title="Current balance"
					/>
					{heldLabel ? (
						<SettingsItem
							actions={
								<span className="text-sm tabular-nums">{heldLabel}</span>
							}
							title="Held for in-flight Messaging"
						/>
					) : null}
					{availableLabel ? (
						<SettingsItem
							actions={
								<span className="text-sm tabular-nums">{availableLabel}</span>
							}
							title="Available to spend"
						/>
					) : null}
					<SettingsItem
						actions={
							<Switch
								aria-label="Automatic recharge"
								checked={enabled}
								disabled={fieldsDisabled}
								onCheckedChange={(v) => handleToggle(Boolean(v))}
							/>
						}
						title="Automatic recharge"
					/>
					<SettingsItem
						actions={
							<DollarField>
								<Input
									className="h-8 w-28"
									disabled={fieldsDisabled}
									id="autotopup-threshold"
									min={0}
									onBlur={handleFieldBlur}
									onChange={(e) => setThresholdText(e.target.value)}
									step="1"
									type="number"
									value={thresholdText}
								/>
							</DollarField>
						}
						title={
							<Label className="font-normal" htmlFor="autotopup-threshold">
								When balance falls below
							</Label>
						}
					/>
					<SettingsItem
						actions={
							<DollarField>
								<Input
									className="h-8 w-28"
									disabled={fieldsDisabled}
									id="autotopup-amount"
									max={MAX_TOPUP_DOLLARS}
									min={MIN_TOPUP_DOLLARS}
									onBlur={handleFieldBlur}
									onChange={(e) => setTopupText(e.target.value)}
									step="1"
									type="number"
									value={topupText}
								/>
							</DollarField>
						}
						title={
							<Label className="font-normal" htmlFor="autotopup-amount">
								Automatically add
							</Label>
						}
					/>
					<SettingsItem
						actions={
							<DollarField>
								<Input
									className="h-8 w-28"
									disabled={fieldsDisabled}
									id="autotopup-cap"
									min={0}
									onBlur={handleFieldBlur}
									onChange={(e) => setCapText(e.target.value)}
									placeholder="0 = no limit"
									step="1"
									type="number"
									value={capText}
								/>
							</DollarField>
						}
						title={
							<Label className="font-normal" htmlFor="autotopup-cap">
								Monthly recharge limit
							</Label>
						}
					/>
					<SettingsItem
						actions={
							<Button
								loading={portalPending}
								onClick={handleManagePayment}
								size="sm"
								variant="outline"
							>
								{!portalPending && (
									<HugeiconsIcon icon={Share08Icon} size={14} />
								)}
								Manage
							</Button>
						}
						description="No saved card yet? Make one manual top-up first."
						title="Payment method"
					/>
				</SettingsGroup>
			</SettingsSection>

			<LowBalanceAlertCard />

			<SettingsSection
				caption="The most one sandboxed run on this node may cost before Ryu stops it. $0 means no limit."
				title="Sandbox spending"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<DollarField>
								<Input
									aria-label="Default sandbox run budget"
									className="h-8 w-28"
									min={0}
									onBlur={saveBudget}
									onChange={(e) => {
										budgetEdit.current += 1;
										setBudgetText(e.target.value);
										setBudgetDirty(true);
									}}
									placeholder="0"
									step="0.01"
									type="number"
									value={budgetText}
								/>
							</DollarField>
						}
						title="Default run budget"
					/>
				</SettingsGroup>
			</SettingsSection>
			{stepUp.dialog}
		</>
	);
}
