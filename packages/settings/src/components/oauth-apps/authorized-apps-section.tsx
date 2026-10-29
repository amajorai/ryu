import { Button } from "@ryu/ui/components/button.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { sileo } from "sileo";
import { settingsApi } from "../../utils/api-client.ts";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "../shared/settings-rows.tsx";
import { AuthorizedOAuthAppList } from "./authorized-oauth-app-list.tsx";
import { errorMessage } from "./shared.ts";

export function AuthorizedAppsSection() {
	const queryClient = useQueryClient();
	const authorizedQuery = useQuery({
		queryKey: ["oauth-apps", "authorized"],
		queryFn: settingsApi.oauthApps.list,
		staleTime: 5 * 60 * 1000,
	});
	const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
	const revokeMutation = useMutation({
		mutationFn: settingsApi.oauthApps.revoke,
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: ["oauth-apps", "authorized"],
			});
			setConfirmRevoke(null);
			sileo.success({ title: "OAuth access revoked" });
		},
		onError: () => sileo.error({ title: "Failed to revoke OAuth access" }),
	});

	const authorizedApps = authorizedQuery.data?.apps ?? [];
	const ryuApps = authorizedApps.filter((app) => app.kind === "ryu");
	const thirdPartyApps = authorizedApps.filter((app) => app.kind === "oauth");

	return (
		<>
			<AuthorizedAppsListSection
				apps={ryuApps}
				confirmRevoke={confirmRevoke}
				description="First-party Ryu clients that have access to this account."
				error={authorizedQuery.error}
				isLoading={authorizedQuery.isLoading}
				isRevoking={revokeMutation.isPending}
				onConfirmRevoke={() => setConfirmRevoke(null)}
				onRetry={() => void authorizedQuery.refetch()}
				onRevoke={(clientId) => revokeMutation.mutate(clientId)}
				onStartRevoke={setConfirmRevoke}
				title="Authorized Ryu Apps"
			/>
			<AuthorizedAppsListSection
				apps={thirdPartyApps}
				confirmRevoke={confirmRevoke}
				description="Third-party apps that have received your consent. Revoking access also invalidates their Ryu authorization."
				error={authorizedQuery.error}
				isLoading={authorizedQuery.isLoading}
				isRevoking={revokeMutation.isPending}
				onConfirmRevoke={() => setConfirmRevoke(null)}
				onRetry={() => void authorizedQuery.refetch()}
				onRevoke={(clientId) => revokeMutation.mutate(clientId)}
				onStartRevoke={setConfirmRevoke}
				title="Authorized OAuth Apps"
			/>
		</>
	);
}

function AuthorizedAppsListSection({
	apps,
	confirmRevoke,
	description,
	error,
	isLoading,
	isRevoking,
	onConfirmRevoke,
	onRetry,
	onRevoke,
	onStartRevoke,
	title,
}: {
	apps: Parameters<typeof AuthorizedOAuthAppList>[0]["apps"];
	confirmRevoke: string | null;
	description: string;
	error: Error | null;
	isLoading: boolean;
	isRevoking: boolean;
	onConfirmRevoke: () => void;
	onRetry: () => void;
	onRevoke: (clientId: string) => void;
	onStartRevoke: (clientId: string) => void;
	title: string;
}) {
	const titleId = useId();
	return (
		<SettingsSection
			as="section"
			caption={description}
			title={title}
			titleId={titleId}
		>
			{isLoading ? (
				<SettingsCard className="flex justify-center py-6">
					<Spinner className="size-5" />
				</SettingsCard>
			) : error ? (
				// A plain sentence, the server's reason in view, and a retry.
				<SettingsGroup>
					<SettingsItem
						actions={
							<Button
								onClick={onRetry}
								size="sm"
								type="button"
								variant="outline"
							>
								Retry
							</Button>
						}
						title="Couldn't load authorized apps."
					>
						<p className="text-status-destructive text-xs" role="alert">
							{errorMessage(error, "Failed to load authorized apps")}
						</p>
					</SettingsItem>
				</SettingsGroup>
			) : (
				<AuthorizedOAuthAppList
					apps={apps}
					confirmRevoke={confirmRevoke}
					isRevoking={isRevoking}
					onConfirmRevoke={onConfirmRevoke}
					onRevoke={onRevoke}
					onStartRevoke={onStartRevoke}
				/>
			)}
		</SettingsSection>
	);
}
