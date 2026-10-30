import { Button } from "@ryu/ui/components/button.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { sileo } from "sileo";
import { type OwnedOAuthApp, settingsApi } from "../../utils/api-client.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "../shared/settings-rows.tsx";
import { OAuthAppRegistrationDialog } from "./oauth-app-registration-dialog.tsx";
import { OAuthAppRow } from "./oauth-app-row.tsx";
import { errorMessage, type PendingAction } from "./shared.ts";

export function OwnedAppsSection() {
	const queryClient = useQueryClient();
	const titleId = useId();
	const ownedQuery = useQuery({
		queryKey: ["oauth-apps", "owned"],
		queryFn: settingsApi.oauthApps.owned.list,
		staleTime: 5 * 60 * 1000,
	});
	const [pendingAction, setPendingAction] = useState<PendingAction>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [createdApp, setCreatedApp] = useState<OwnedOAuthApp | null>(null);
	const deleteMutation = useMutation({
		mutationFn: settingsApi.oauthApps.owned.delete,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["oauth-apps", "owned"] });
			setPendingAction(null);
			sileo.success({ title: "OAuth app deleted" });
		},
		onError: () => sileo.error({ title: "Failed to delete OAuth app" }),
	});
	const rotateMutation = useMutation({
		mutationFn: settingsApi.oauthApps.owned.rotateSecret,
		onSuccess: ({ app }) => {
			setCreatedApp(app);
			setDialogOpen(true);
			setPendingAction(null);
			void queryClient.invalidateQueries({ queryKey: ["oauth-apps", "owned"] });
		},
		onError: () => sileo.error({ title: "Failed to rotate OAuth app secret" }),
	});

	function handleAction(action: PendingAction) {
		if (!action) {
			return;
		}
		if (
			action.kind === "delete" &&
			pendingAction?.kind === "delete" &&
			pendingAction.clientId === action.clientId
		) {
			deleteMutation.mutate(action.clientId);
			return;
		}
		if (
			action.kind === "rotate" &&
			pendingAction?.kind === "rotate" &&
			pendingAction.clientId === action.clientId
		) {
			rotateMutation.mutate(action.clientId);
			return;
		}
		setPendingAction(action);
	}

	function openCreate() {
		setCreatedApp(null);
		setDialogOpen(true);
	}

	const ownedApps = ownedQuery.data?.apps ?? [];
	const pending = deleteMutation.isPending || rotateMutation.isPending;

	return (
		<SettingsSection
			as="section"
			caption="Apps that ask Ryu users for scoped access. Secrets show once, when created or rotated."
			headerAction={
				<Button onClick={openCreate} size="sm" variant="outline">
					Create OAuth app
				</Button>
			}
			title="Your OAuth apps"
			titleId={titleId}
		>
			{ownedQuery.isLoading ? (
				<SkeletonRows label="Loading" rows={2} />
			) : ownedQuery.isError ? (
				// A plain sentence, the server's reason in view, and a retry.
				<SettingsGroup>
					<SettingsItem
						actions={
							<Button
								onClick={() => void ownedQuery.refetch()}
								size="sm"
								type="button"
								variant="outline"
							>
								Retry
							</Button>
						}
						description={
							<span role="alert">
								{errorMessage(
									ownedQuery.error,
									"Failed to load your OAuth apps"
								)}
							</span>
						}
						title="Couldn't load your OAuth apps."
					/>
				</SettingsGroup>
			) : ownedApps.length === 0 ? (
				<p className="py-3 text-muted-foreground text-sm">
					You have not registered an OAuth app yet.
				</p>
			) : (
				<SettingsGroup>
					{ownedApps.map((app) => (
						<OAuthAppRow
							app={app}
							key={app.clientId}
							onAction={handleAction}
							onCancelAction={() => setPendingAction(null)}
							pendingAction={pendingAction}
						/>
					))}
				</SettingsGroup>
			)}
			<OAuthAppRegistrationDialog
				createdApp={createdApp}
				onCreated={() => {
					void queryClient.invalidateQueries({
						queryKey: ["oauth-apps", "owned"],
					});
				}}
				onCreatedAppChange={setCreatedApp}
				onOpenChange={setDialogOpen}
				open={dialogOpen}
			/>
			{pending ? <span className="sr-only">Updating OAuth app</span> : null}
		</SettingsSection>
	);
}
