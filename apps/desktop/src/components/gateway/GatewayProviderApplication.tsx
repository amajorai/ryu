import { Button } from "@ryu/ui/components/button.tsx";
import { useState } from "react";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	applySavedGatewayProviderConnections,
	requireGatewayProviderReload,
} from "@/src/lib/api/gateway.ts";
import { gatewayAccountErrorMessage } from "./GatewayProviderKeyRow.tsx";
import { SettingsNotice } from "./SettingsNotice.tsx";

export function GatewayProviderApplication({
	target,
	revision,
	appliedRevision,
	canConfigure,
	reachable,
	managed,
	onRefresh,
}: {
	target: ApiTarget;
	revision: string | null;
	appliedRevision: string | null | undefined;
	canConfigure: boolean;
	reachable: boolean;
	managed: boolean;
	onRefresh: () => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (managed || !revision || appliedRevision === undefined) {
		return null;
	}
	const active = appliedRevision === revision;
	let status =
		"Stored settings differ from the last applied provider revision.";
	if (active) {
		status = "Saved provider settings are active.";
	} else if (appliedRevision === null) {
		status =
			"The running Gateway has not confirmed the saved provider revision.";
	}
	const apply = async () => {
		setBusy(true);
		setError(null);
		try {
			const result = await applySavedGatewayProviderConnections(
				target,
				revision
			);
			if (result.persisted === false) {
				throw new Error(
					result.gateway_application?.status === "superseded"
						? "The saved revision changed. Refresh and apply the latest saved connections."
						: "The requested saved revision is unavailable. Refresh before applying connections again."
				);
			}
			requireGatewayProviderReload(result);
		} catch (cause) {
			setError(
				gatewayAccountErrorMessage(
					cause,
					"Saved connections could not be applied."
				)
			);
		} finally {
			try {
				await onRefresh();
			} catch (cause) {
				setError(
					gatewayAccountErrorMessage(
						cause,
						"Refresh provider status before applying again."
					)
				);
			} finally {
				setBusy(false);
			}
		}
	};
	return (
		<SettingsSection
			caption={
				active
					? "New requests use the confirmed provider settings. Running requests keep their original connections."
					: "Apply saved provider settings without re-entering credentials. Running requests keep their original connections."
			}
			title="Provider application"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						active ? null : (
							<Button
								disabled={!(canConfigure && reachable)}
								loading={busy}
								onClick={apply}
								size="sm"
							>
								Apply saved connections
							</Button>
						)
					}
					title={<span role="status">{status}</span>}
				/>
			</SettingsGroup>
			{error && !active ? (
				<SettingsNotice role="alert">{error}</SettingsNotice>
			) : null}
		</SettingsSection>
	);
}
