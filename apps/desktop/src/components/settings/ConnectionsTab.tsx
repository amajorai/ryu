import {
	GoogleIcon,
	Link01Icon,
	Unlink01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ACCOUNT_LINKING_PROVIDERS,
	type LinkedAccountProvider,
} from "@ryu/blocks/web/linked-account-providers.ts";
import {
	DISCORD_SVGL,
	GITHUB_SVGL,
	SvglIcon,
} from "@ryu/blocks/web/svgl-icon.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@ryu/ui/components/alert-dialog.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@ryu/ui/components/tabs.tsx";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sileo } from "sileo";
import { WEB_URL } from "@/lib/app-urls.ts";
import { authClient } from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { ConnectDeviceQR } from "@/src/components/devices/ConnectDeviceQR.tsx";
import { CloudSyncSection } from "@/src/components/settings/CloudSyncSection.tsx";
import { NodeAccessSettings } from "@/src/components/settings/NodeAccessSettings.tsx";
import { ConnectedDevicesSection } from "./ConnectionsTab-connected-devices.tsx";
import { RemoteNodesSection } from "./ConnectionsTab-remote-nodes.tsx";
import { RowTitle } from "./ConnectionsTab-row-title.tsx";
import { SshConnectionsSection } from "./ConnectionsTab-ssh.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

export { ConnectedDevicesSection } from "./ConnectionsTab-connected-devices.tsx";

type AccountInfo = NonNullable<
	Awaited<ReturnType<typeof authClient.listAccounts>>["data"]
>[number];

export function ConnectionsTab() {
	const queryClient = useQueryClient();
	const [linkingProvider, setLinkingProvider] =
		useState<LinkedAccountProvider | null>(null);
	const tl = useLiteralMessages();
	const [unlinkingProvider, setUnlinkingProvider] =
		useState<LinkedAccountProvider | null>(null);

	const { data: accounts, isLoading } = useQuery({
		queryKey: ["linked-accounts"],
		queryFn: async () => {
			const result = await authClient.listAccounts();
			if (result.error) {
				throw new Error(result.error.message);
			}
			return result.data ?? [];
		},
	});

	const handleLinkAccount = async (provider: LinkedAccountProvider) => {
		setLinkingProvider(provider);
		const label =
			ACCOUNT_LINKING_PROVIDERS.find((item) => item.id === provider)?.label ??
			provider;
		try {
			const callbackUrl = `${WEB_URL}/settings?tab=connections`;
			const result = await authClient.linkSocial({
				provider,
				callbackURL: callbackUrl,
				disableRedirect: true,
			});
			if (result.error) {
				throw new Error(result.error.message);
			}
			// Open in browser for OAuth flow
			const url = result.data?.url;
			if (url) {
				await openExternal(url);
				sileo.success({
					title: tl("Complete {label} account linking in your browser", {
						label,
					}),
				});
			} else {
				sileo.error({
					title: tl("Couldn't start {label} account linking", { label }),
					description: "Please try again in a moment.",
				});
			}
		} catch (error) {
			sileo.error({
				title:
					error instanceof Error
						? error.message
						: tl("Failed to link {label} account", { label }),
			});
		} finally {
			setLinkingProvider(null);
		}
	};

	const handleUnlinkAccount = async (account: AccountInfo) => {
		const provider = ACCOUNT_LINKING_PROVIDERS.find(
			(item) => item.id === account.providerId
		);
		if (!provider) {
			return;
		}
		setUnlinkingProvider(provider.id);
		try {
			const result = await authClient.unlinkAccount({
				accountId: account.accountId,
			});
			if (result.error) {
				throw new Error(result.error.message);
			}
			sileo.success({
				title: tl("{label} account unlinked", { label: provider.label }),
			});
			queryClient.invalidateQueries({ queryKey: ["linked-accounts"] });
		} catch (error) {
			sileo.error({
				title:
					error instanceof Error
						? error.message
						: tl("Failed to unlink {label} account", {
								label: provider.label,
							}),
			});
		} finally {
			setUnlinkingProvider(null);
		}
	};

	if (isLoading) {
		return <SkeletonRows spacing="section" />;
	}

	return (
		<div
			aria-label="Connections"
			className="space-y-6"
			data-testid="connections-hub"
		>
			<Tabs defaultValue="this-device">
				<TabsList
					aria-label="Connection scope"
					className="grid w-full grid-cols-3"
					manageLayout={false}
					persistLayout={false}
					variant="segmented"
				>
					<TabsTrigger value="this-device">Control this device</TabsTrigger>
					<TabsTrigger value="other-devices">Control other devices</TabsTrigger>
					<TabsTrigger value="ssh">SSH</TabsTrigger>
				</TabsList>
				<TabsContent spacing="comfortable" value="this-device">
					<NodeAccessSettings />
					<ConnectedDevicesSection />
					<SettingsSection
						caption="Link individual social identities to this Ryu account. Social sign-in remains Google-only. Telegram Login is organization/channel-level, so it is not included here."
						title="Linked accounts"
					>
						<SettingsGroup>
							{ACCOUNT_LINKING_PROVIDERS.map((provider) => {
								const account = accounts?.find(
									(candidate) => candidate.providerId === provider.id
								);
								const isLinking = linkingProvider === provider.id;
								const isUnlinking = unlinkingProvider === provider.id;
								return (
									<SettingsItem
										actions={
											account ? (
												<AlertDialog>
													<AlertDialogTrigger
														render={
															<Button
																aria-label={tl("Unlink {label} account", {
																	label: provider.label,
																})}
																disabled={unlinkingProvider !== null}
																size="sm"
																variant="ghost"
															/>
														}
													>
														<HugeiconsIcon
															className="mr-2 size-4"
															icon={Unlink01Icon}
														/>
														{isUnlinking ? "Unlinking…" : "Unlink"}
													</AlertDialogTrigger>
													<AlertDialogContent>
														<AlertDialogHeader>
															<AlertDialogTitle>
																{tl("Unlink {label} account?", {
																	label: provider.label,
																})}
															</AlertDialogTitle>
															<AlertDialogDescription>
																This removes the account link from your Ryu
																user. Your existing Ryu sign-in methods stay
																unchanged.
															</AlertDialogDescription>
														</AlertDialogHeader>
														<AlertDialogFooter>
															<AlertDialogCancel>Cancel</AlertDialogCancel>
															<AlertDialogAction
																disabled={isUnlinking}
																onClick={() => {
																	void handleUnlinkAccount(account);
																}}
															>
																Unlink
															</AlertDialogAction>
														</AlertDialogFooter>
													</AlertDialogContent>
												</AlertDialog>
											) : (
												<Button
													aria-label={tl("Link {label} account", {
														label: provider.label,
													})}
													disabled={
														linkingProvider !== null ||
														unlinkingProvider !== null
													}
													onClick={() => {
														void handleLinkAccount(provider.id);
													}}
													size="sm"
													variant="ghost"
												>
													<HugeiconsIcon
														className="mr-2 size-4"
														icon={Link01Icon}
													/>
													{isLinking ? "Opening browser…" : "Link"}
												</Button>
											)
										}
										key={provider.id}
										title={
											<RowTitle
												detail={account ? "Connected" : provider.description}
												leading={
													<span
														aria-hidden="true"
														className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-background"
													>
														{provider.id === "google" ? (
															<HugeiconsIcon
																className="size-4"
																icon={GoogleIcon}
															/>
														) : provider.id === "github" ? (
															<SvglIcon size={16} spec={GITHUB_SVGL} />
														) : (
															<SvglIcon size={16} spec={DISCORD_SVGL} />
														)}
													</span>
												}
												name={provider.label}
											/>
										}
									/>
								);
							})}
						</SettingsGroup>
					</SettingsSection>
					<SettingsSection
						caption="Scan the QR code with the Ryu mobile app to connect your phone to this device."
						title="Connect a phone"
					>
						<SettingsCard>
							<ConnectDeviceQR />
						</SettingsCard>
					</SettingsSection>
					<CloudSyncSection />
				</TabsContent>
				<TabsContent spacing="comfortable" value="other-devices">
					<RemoteNodesSection />
				</TabsContent>
				<TabsContent spacing="comfortable" value="ssh">
					<SshConnectionsSection />
				</TabsContent>
			</Tabs>
		</div>
	);
}
