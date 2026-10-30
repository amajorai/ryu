import {
	DESKTOP_TRIAL_INCLUDES,
	DESKTOP_TRIAL_LABEL,
} from "@ryu/auth/lib/plans";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useEntitlementContext } from "@/src/contexts/entitlement-context.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

/**
 * Desktop trial + license access (epic #496, Unit C1). Surfaces the trial
 * countdown, the resolved access state, and a "manage license/upgrade" action.
 * Reads the reliable bearer-authed entitlement verdict (NOT the cookie-based
 * useSubscription, which silently fails in the Tauri webview).
 */
export function DesktopAccessSection() {
	const tl = useLiteralMessages();
	const { ready, verdict, requestUpgrade } = useEntitlementContext();
	if (!(ready && verdict)) {
		return (
			<SettingsSection title="Desktop access">
				<SkeletonRows rows={1} />
			</SettingsSection>
		);
	}

	const reasonLabel = {
		subscription: "Active subscription",
		license: "Licensed",
		beta: "Free during beta",
		// Not a "Pro trial": the trial grants Band 2 only — see
		// `DESKTOP_TRIAL_LABEL` in `@ryu/auth/lib/plans`.
		trial: tl(
			"{trialLabel} — {daysLeftInTrial, plural, one {# day} other {# days}} left",
			{
				trialLabel: DESKTOP_TRIAL_LABEL,
				daysLeftInTrial: verdict.daysLeftInTrial,
			}
		),
		"offline-grace": "Active (offline)",
		"trial-expired": `${DESKTOP_TRIAL_LABEL} ended`,
		locked: "Free (local only)",
	} satisfies Record<typeof verdict.reason, string>;

	return (
		<SettingsSection title="Desktop access">
			<SettingsGroup>
				<SettingsItem
					actions={
						verdict.paywalled ? (
							<Button onClick={requestUpgrade} size="sm" variant="outline">
								Unlock Pro
							</Button>
						) : undefined
					}
					description={
						verdict.paywalled
							? "Basic local chat stays free. Unlock Pro features and cloud models that run for you."
							: verdict.reason === "trial"
								? DESKTOP_TRIAL_INCLUDES
								: verdict.reason === "beta"
									? "Free and unlimited during the beta. Managed inference and cloud nodes bill separately."
									: "Pro features are unlocked."
					}
					title={reasonLabel[verdict.reason]}
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}
