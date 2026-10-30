import { useLiteralMessages } from "@ryu/i18n/react";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

export interface ComposioBillingPolicy {
	baa: boolean;
	ipAllowlist: boolean;
	zeroDataRetention: boolean;
}

export function ComposioBillingView({
	policy,
	loading,
}: {
	policy: ComposioBillingPolicy;
	loading: boolean;
}) {
	const tl = useLiteralMessages();
	let status = "off";
	if (loading) {
		status = "checking";
	} else if (policy.zeroDataRetention) {
		status = "on";
	}
	return (
		<SettingsSection
			caption="Provider usage debits your organization's shared credits. The same privacy policy and usage rates apply to every plan."
			title="Composio usage & privacy"
		>
			<SettingsGroup>
				<SettingsItem
					description="$0.50 per 1,000 calls. Direct execution outside a Session adds $0.10 per 1,000 calls."
					title="Managed tool calls"
				/>
				<SettingsItem
					description="$5.00 per 1,000 events. Polling and the number of agents started do not multiply the event charge."
					title="Delivered trigger events"
				/>
				<SettingsItem
					description="The actual Composio charge is passed through. It already includes their provider fee; Ryu does not add another 5%."
					title="Premium tools"
				/>

				<SettingsItem
					description="Required for every plan. Requests use ZDR endpoints and exclude data-collecting providers. Credits use the actual reported provider cost."
					title="OpenRouter zero data retention · On"
				/>
				<SettingsItem
					description={
						loading
							? "Checking the shared project's rollout status."
							: policy.zeroDataRetention
								? "Enabled globally. Adds $0.10 per 1,000 tool calls for every organization. Direct managed calls total $0.70 per 1,000 before premium charges."
								: "Pending platform activation. No ZDR surcharge is billed. Direct managed calls total $0.60 per 1,000 before premium charges."
					}
					title={tl(
						"Composio zero data retention · {status, select, checking {Checking} on {On} other {Off}}",
						{ status }
					)}
				/>
			</SettingsGroup>
			<div className="mt-2 space-y-2 text-detail text-muted-foreground">
				<p className="text-foreground">Shared project privacy</p>
				<p>
					The platform controls Composio ZDR for the shared project. Activation
					requires the upstream add-on and applies to every organization
					together.
				</p>
				<p>
					Composio coverage excludes triggers, sandbox, staged files, and
					managed OAuth apps on Pro. Instant tool providers may retain data.
					OpenRouter ZDR covers inference endpoints; tools and plugins have
					separate policies.
				</p>
				<a
					className="text-primary underline-offset-4 hover:underline"
					href="https://docs.composio.dev/docs/security/zero-data-retention"
					rel="noopener noreferrer"
					target="_blank"
				>
					Review Composio ZDR coverage
				</a>
			</div>
		</SettingsSection>
	);
}
