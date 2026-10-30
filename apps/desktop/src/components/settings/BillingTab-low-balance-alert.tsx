import { useLiteralMessages } from "@ryu/i18n/react";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useCallback, useEffect, useState } from "react";
import { useCreditsWallet } from "@/src/hooks/useCreditsWallet.ts";
import {
	type CreditAlertRecipients,
	fetchCreditAlert,
	putCreditAlert,
} from "@/src/lib/api/credits.ts";
import { useActiveOrgId } from "@/src/lib/api/orgs.ts";
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

const ALERT_RECIPIENT_OPTIONS: {
	value: CreditAlertRecipients;
	label: string;
}[] = [
	{ value: "none", label: "No one (off)" },
	{ value: "owners", label: "Owners only" },
	{ value: "owners_admins", label: "Owners and admins" },
];

/**
 * What an org with NO saved low-balance alert reads as. Named rather than
 * inlined twice because it is used for the initial mount AND for the reset that
 * every workspace switch performs — the two must not drift, or a switch would
 * land somewhere the first paint never does.
 */
const ALERT_DEFAULTS = {
	recipients:
		/* SAFETY: The locally authored none literal is an explicit member of CreditAlertRecipients and the ALERT_RECIPIENT_OPTIONS table above. */ "none" as CreditAlertRecipients,
	thresholdText: "5",
};

/**
 * Low-balance email alert card. Emails the org's owners (or owners+admins) when
 * the managed wallet balance drops below a threshold. Independent of auto-recharge
 * (no saved card needed): `recipients: "none"` is the off state. Admin-only on
 * the server; a non-admin's save surfaces a 403 toast.
 */
export function LowBalanceAlertCard() {
	const tl = useLiteralMessages();
	const { authed } = useCreditsWallet();
	const activeOrgId = useActiveOrgId();
	const [recipients, setRecipients] = useState<CreditAlertRecipients>(
		ALERT_DEFAULTS.recipients
	);
	const [thresholdText, setThresholdText] = useState(
		ALERT_DEFAULTS.thresholdText
	);
	const [lastError, setLastError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [loadingSettings, setLoadingSettings] = useState(false);

	useEffect(() => {
		// CLEAR FIRST, THEN LOAD. `activeOrgId` is a RE-RUN key, not an argument:
		// the alert config is stored per org and `/api/credits/alert` resolves that
		// org from the session, so switching workspace changes the answer without
		// changing the request. This card is plain state rather than a query, so
		// the switcher's cache invalidation cannot reach it — the dependency is
		// what reloads it.
		//
		// The reset is the load-bearing half. Every path out of the fetch below can
		// decline to set state — `fetchCreditAlert` resolves to NULL when the org
		// has no alert row, and the `.catch` covers a 403 in an org where the user
		// is not an admin — and without this the card would keep rendering the
		// PREVIOUS org's recipients and threshold as if they were this org's. Worse
		// than a stale read: `handleThresholdBlur` would then commit that mixture,
		// writing the old org's threshold onto the new org's alert.
		setRecipients(ALERT_DEFAULTS.recipients);
		setThresholdText(ALERT_DEFAULTS.thresholdText);
		setLastError(null);
		if (!authed) {
			return;
		}
		let cancelled = false;
		setLoadingSettings(true);
		fetchCreditAlert()
			.then((s) => {
				if (cancelled || !s) {
					return;
				}
				setRecipients(s.recipients);
				// A stored 0 means "never configured", so the DEFAULT above stands —
				// deliberately not the value that was on screen a moment ago.
				if (s.thresholdCents > 0) {
					setThresholdText(centsToDollarText(s.thresholdCents));
				}
				setLastError(s.lastError);
			})
			.catch(() => undefined)
			.finally(() => {
				if (!cancelled) {
					setLoadingSettings(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [authed, activeOrgId]);

	const commit = useCallback(
		async (nextRecipients: CreditAlertRecipients): Promise<boolean> => {
			const thresholdCents = dollarTextToCents(thresholdText);
			if (nextRecipients !== "none" && thresholdCents <= 0) {
				toast.error("Set a balance threshold above $0.");
				return false;
			}
			setSaving(true);
			try {
				const result = await putCreditAlert({
					recipients: nextRecipients,
					thresholdCents,
				});
				if (result) {
					setRecipients(result.recipients);
					setLastError(result.lastError);
				}
				return true;
			} catch (e) {
				toast.error(errorText(e));
				return false;
			} finally {
				setSaving(false);
			}
		},
		[thresholdText]
	);

	const handleRecipientsChange = useCallback(
		(next: CreditAlertRecipients) => {
			const previous = recipients;
			setRecipients(next);
			commit(next)
				.then((ok) => {
					if (!ok) {
						setRecipients(previous);
					}
				})
				.catch(() => setRecipients(previous));
		},
		[recipients, commit]
	);

	const handleThresholdBlur = useCallback(() => {
		if (recipients !== "none") {
			commit(recipients).catch(() => undefined);
		}
	}, [recipients, commit]);

	// Locked while the new org's row is in flight as well as while saving: the
	// fields are showing defaults at that moment, and a save from them would
	// write those defaults onto whichever org is now active.
	const fieldsDisabled = !authed || saving || loadingSettings;
	const off = recipients === "none";

	return (
		<SettingsSection
			caption="Email org owners or admins when the managed balance runs low. Org admins only."
			title="Low balance alert"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Select
							disabled={fieldsDisabled}
							items={ALERT_RECIPIENT_OPTIONS}
							onValueChange={(v) => handleRecipientsChange(v)}
							value={recipients}
						>
							<SelectTrigger className="h-8 w-40" id="credit-alert-recipients">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{ALERT_RECIPIENT_OPTIONS.map((opt) => (
									<SelectItem key={opt.value} value={opt.value}>
										{opt.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					}
					title={
						<Label className="font-normal" htmlFor="credit-alert-recipients">
							Email
						</Label>
					}
				/>
				<SettingsItem
					actions={
						<DollarField>
							<Input
								className="h-8 w-28"
								disabled={fieldsDisabled || off}
								id="credit-alert-threshold"
								min={0}
								onBlur={handleThresholdBlur}
								onChange={(e) => setThresholdText(e.target.value)}
								step="1"
								type="number"
								value={thresholdText}
							/>
						</DollarField>
					}
					description={
						lastError ? (
							<span className="text-status-destructive">
								{tl("Last alert email failed: {lastError}", { lastError })}
							</span>
						) : undefined
					}
					title={
						<Label className="font-normal" htmlFor="credit-alert-threshold">
							When balance falls below
						</Label>
					}
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}
