import type { LiteralMessage } from "@ryu/i18n/react";
import { sileo } from "sileo";
import type { ProviderAccountTarget } from "@/components/agent-elements/input/provider-account-section.tsx";
import type { PiProvider } from "@/src/lib/api/pi-config.ts";
import {
	errMessage,
	type ProviderCardProps,
} from "./LlmProvidersSettings-shared.ts";

/** Switch, remove, and rename handlers for a provider card's saved accounts. */
export function providerAccountHandlers({
	isChatgptPlan,
	onRemoveAccount,
	onRenameAccount,
	onSwitchAccount,
	provider,
	tl,
}: Pick<
	ProviderCardProps,
	"onRemoveAccount" | "onRenameAccount" | "onSwitchAccount"
> & {
	isChatgptPlan: boolean;
	provider: PiProvider;
	tl: LiteralMessage;
}) {
	const handleSwitchAccount = async (
		accountId: string,
		target: ProviderAccountTarget
	) => {
		try {
			await onSwitchAccount(provider.id, accountId, target);
			sileo.success({
				title:
					target === "gateway"
						? tl("{label} account is active for Gateway", {
								label: provider.label,
							})
						: tl("{label} account switched for you", { label: provider.label }),
			});
		} catch (error) {
			sileo.error({
				title: "Could not switch account",
				description: errMessage(error, "Core rejected the request."),
			});
		}
	};

	const handleRemoveAccount = async (accountId: string) => {
		try {
			const result = await onRemoveAccount(provider.id, accountId);
			if (isChatgptPlan && result?.sessionRevocationStatus === "unconfirmed") {
				sileo.warning({
					title: "Local account removed",
					description:
						"Remote revocation was not confirmed. Disconnect the app in ChatGPT settings to end its access.",
				});
				return;
			}
			sileo.success({
				title: tl("{label} account removed", { label: provider.label }),
			});
		} catch (error) {
			sileo.error({
				title: "Could not remove account",
				description: errMessage(error, "Core rejected the request."),
			});
		}
	};

	const handleRenameAccount = async (
		accountId: string,
		label: string
	): Promise<boolean> => {
		try {
			await onRenameAccount(provider.id, accountId, label);
			sileo.success({
				title: tl("{label} account renamed", { label: provider.label }),
			});
			return true;
		} catch (error) {
			sileo.error({
				title: "Could not rename account",
				description: errMessage(error, "Core rejected the request."),
			});
			return false;
		}
	};

	return { handleRemoveAccount, handleRenameAccount, handleSwitchAccount };
}
