// Usage & Cost: BYOK provider key balance card.

import { formatCurrency } from "@ryu/ui/lib/number-format.ts";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useProviderCredits } from "@/src/hooks/useProviderCredits.ts";

/**
 * Remaining prepaid credit on the BYOK provider keys stored on this node.
 *
 * A separate card rather than a column on the quota table above, because the two
 * are different universes: that table is keyed by GATEWAY provider kinds
 * (`openai`, `anthropic`, `local`, `core`, …) whose credentials are
 * environment-variable-only, while these are Pi/BYOK provider ids whose keys live
 * in Core's own config. Joining them would need an id mapping that doesn't exist
 * and would silently mismatch.
 *
 * Only three providers publish a balance to the key you already hold. The rest is
 * not an oversight worth hiding: the card says so, because "why is OpenAI not
 * listed" is otherwise the first question.
 */
export function ProviderCreditsCard() {
	return (
		<SettingsSection
			caption={
				<CaptionInfo
					detail={
						"This is separate from the active organization's shared Ryu credits. Only vendors that publish a balance to an inference key can be shown."
					}
				>
					{"Prepaid balance left on provider keys stored on this node."}
				</CaptionInfo>
			}
			title="BYOK provider key balance"
		>
			<SettingsGroup>
				{CREDIT_PROVIDER_IDS.map((id) => (
					<ProviderCreditsRow key={id} providerId={id} />
				))}
			</SettingsGroup>
		</SettingsSection>
	);
}

/** The provider ids Core can read a balance for (mirrors `supportsProviderCredits`). */
const CREDIT_PROVIDER_IDS = ["openrouter", "deepseek", "moonshot"] as const;

const CREDIT_PROVIDER_LABELS = new Map<string, string>([
	["openrouter", "OpenRouter"],
	["deepseek", "DeepSeek"],
	["moonshot", "Moonshot / Kimi"],
]);

/**
 * One provider's balance row. Unlike the picker badge (which hides entirely when
 * there is nothing to show), this surface is a deliberate list, so a row always
 * renders and states WHY it has no number — on a settings page "no key stored" is
 * the actionable answer, not noise.
 */
function ProviderCreditsRow({ providerId }: { providerId: string }) {
	// Through the shared hook, not a hand-rolled query: it carries the
	// supported-provider gate and the poll cadence, and re-typing its query key
	// here would make the two surfaces share cache only by coincidence.
	const data = useProviderCredits(providerId);
	const label = CREDIT_PROVIDER_LABELS.get(providerId) ?? providerId;
	const meter = data?.available ? data.meters.at(0) : undefined;
	const amount = meter?.values.at(0);
	let value = "Checking…";
	if (data) {
		if (amount) {
			value = `${formatCurrency(amount.number, "USD", {
				maximumFractionDigits: 2,
				minimumFractionDigits: 2,
			})} left`;
		} else if (data.reason === "not_logged_in") {
			value = "No key stored";
		} else if (data.reason === "token_expired") {
			value = "Key rejected";
		} else if (data.reason === "rate_limited") {
			value = "Rate limited";
		} else {
			value = "Unavailable";
		}
	}
	return (
		<SettingsItem
			actions={
				<span
					className={`text-muted-foreground text-sm tabular-nums ${
						amount ? "tabular-nums" : ""
					}`}
				>
					{value}
				</span>
			}
			title={label}
		/>
	);
}
