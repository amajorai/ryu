"use client";

import PageHeader from "@ryu/ui/components/page-header";
import { Switch } from "@ryu/ui/components/switch";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@ryu/ui/components/tabs";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "../desktop/settings-items.tsx";
import type { LinkedAccountProvider } from "./linked-account-providers.ts";
import { AccountTabPanel } from "./profile-settings-account-tab.tsx";
import { ConnectionsTabPanel } from "./profile-settings-connections-tab.tsx";
import { ProfileTabPanel } from "./profile-settings-profile-tab.tsx";
import type {
	LinkedAccount,
	ProfileSettingsProps,
} from "./profile-settings-types.ts";

export type { LinkedAccountProvider } from "./linked-account-providers.ts";
export { ACCOUNT_LINKING_PROVIDERS } from "./linked-account-providers.ts";
export { ProfileStatsPanel } from "./profile-settings-stats-panel.tsx";
export type {
	LinkedAccount,
	ProfileFeatureUnlock,
	ProfileSettingsProps,
	ProfileStatsInsights,
	ProfileStatsPanelProps,
	ProfileStatsSummary,
	ProfileTab,
	RankedProfileStat,
} from "./profile-settings-types.ts";

const noop = () => {
	// presentational default; the live app injects real handlers
};

/**
 * The real account-settings page body, presentational. The live page
 * (apps/web/src/app/settings/page.tsx) owns every authClient hook and the
 * data-mutating dialogs; it passes resolved data + callbacks and fills the
 * slot props with its app-local widgets. The storyboard renders it with static
 * data and stub slots, one tab per panel via `activeTab`.
 *
 * Every tab body is built from the shared settings primitives
 * (`SettingsSection` / `SettingsGroup` / `SettingsItem` / `SettingsCard`), so
 * the web settings page reads like the desktop app's Settings panes in both
 * navigation modes.
 */
export default function ProfileSettings({
	activeTab = "profile",
	navigation = "tabs",
	onTabChange = noop,
	name = "",
	onNameChange = noop,
	email = "",
	isSaving = false,
	isSavingProfileVisibility = false,
	isSavingUsername = false,
	onSaveName = noop,
	username = "",
	onUsernameChange = noop,
	onSaveUsername = noop,
	isProfilePublic = true,
	onProfilePublicToggle = noop,
	publicProfileHref,
	publicProfileSlot,
	avatarSlot,
	authMethod = "password",
	isPasswordStatusLoading = false,
	twoFactorEnabled = false,
	changeEmailSlot,
	emailChangeStatusSlot,
	mergeAccountsSlot,
	mergeStatusSlot,
	changePasswordSlot,
	twoFactorSlot,
	onDeleteAccount,
	referralsSlot,
	isSubscribed = true,
	isLoadingSubscription = false,
	onSubscriptionToggle = noop,
	transactionalNotificationsSlot,
	googleConnected = false,
	connectingProvider = null,
	onConnectGoogle = noop,
	onConnectAccount,
	linkedAccounts,
	onUnlinkAccount,
	onUnlinkGoogle = noop,
	sessionsSlot,
	passkeysSlot,
	statsSlot,
	authorizedAppsSlot,
	supportAccessSlot,
	emailsSlot,
	securityBannerSlot,
}: ProfileSettingsProps) {
	const connections =
		linkedAccounts ??
		(googleConnected ? [{ accountId: "google", providerId: "google" }] : []);
	const unlinkAccount = (account: LinkedAccount) => {
		if (onUnlinkAccount) {
			onUnlinkAccount(account);
			return;
		}
		onUnlinkGoogle();
	};
	const connectAccount = (providerId: LinkedAccountProvider) => {
		if (onConnectAccount) {
			onConnectAccount(providerId);
			return;
		}
		if (providerId === "google") {
			onConnectGoogle();
		}
	};

	// The pills sit above the tab bodies; a host's own heading does not.
	const tabContentClass = navigation === "tabs" ? "mt-6" : undefined;

	return (
		<div
			className={
				navigation === "tabs"
					? "container mx-auto flex min-h-screen max-w-4xl flex-col gap-8 px-4 py-8"
					: "flex flex-col gap-6"
			}
		>
			{navigation === "tabs" ? (
				<PageHeader
					subtitle="Update your profile and manage your account"
					title="Account settings"
				/>
			) : null}
			{securityBannerSlot}

			<Tabs onValueChange={onTabChange} value={activeTab}>
				{navigation === "tabs" ? (
					<TabsList sticky variant="pills-lg">
						<TabsTrigger value="profile">Profile</TabsTrigger>
						{statsSlot ? <TabsTrigger value="stats">Stats</TabsTrigger> : null}
						<TabsTrigger value="account">Account</TabsTrigger>
						<TabsTrigger value="referrals">Referrals</TabsTrigger>
						<TabsTrigger value="notifications">Notifications</TabsTrigger>
						<TabsTrigger value="connections">Connections</TabsTrigger>
						<TabsTrigger value="sessions">Sessions &amp; devices</TabsTrigger>
						<TabsTrigger value="authorized-apps">OAuth apps</TabsTrigger>
						<TabsTrigger value="support-access">Support access</TabsTrigger>
						{emailsSlot ? (
							<TabsTrigger value="emails">Emails</TabsTrigger>
						) : null}
					</TabsList>
				) : null}

				<TabsContent
					className={tabContentClass}
					spacing="comfortable"
					value="profile"
				>
					<ProfileTabPanel
						avatarSlot={avatarSlot}
						email={email}
						isProfilePublic={isProfilePublic}
						isSaving={isSaving}
						isSavingProfileVisibility={isSavingProfileVisibility}
						isSavingUsername={isSavingUsername}
						name={name}
						onNameChange={onNameChange}
						onProfilePublicToggle={onProfilePublicToggle}
						onSaveName={onSaveName}
						onSaveUsername={onSaveUsername}
						onUsernameChange={onUsernameChange}
						publicProfileHref={publicProfileHref}
						publicProfileSlot={publicProfileSlot}
						username={username}
					/>
				</TabsContent>

				<TabsContent
					className={tabContentClass}
					spacing="comfortable"
					value="stats"
				>
					{statsSlot}
				</TabsContent>

				<TabsContent
					className={tabContentClass}
					spacing="comfortable"
					value="account"
				>
					<AccountTabPanel
						authMethod={authMethod}
						changeEmailSlot={changeEmailSlot}
						changePasswordSlot={changePasswordSlot}
						email={email}
						emailChangeStatusSlot={emailChangeStatusSlot}
						isPasswordStatusLoading={isPasswordStatusLoading}
						mergeAccountsSlot={mergeAccountsSlot}
						mergeStatusSlot={mergeStatusSlot}
						onDeleteAccount={onDeleteAccount}
						passkeysSlot={passkeysSlot}
						twoFactorEnabled={twoFactorEnabled}
						twoFactorSlot={twoFactorSlot}
					/>
				</TabsContent>

				<TabsContent
					className={tabContentClass}
					spacing="comfortable"
					value="referrals"
				>
					{referralsSlot}
				</TabsContent>

				<TabsContent
					className={tabContentClass}
					spacing="comfortable"
					value="notifications"
				>
					<SettingsSection title="Product updates">
						<SettingsGroup>
							<SettingsItem
								actions={
									<Switch
										aria-label="Marketing Emails"
										checked={isSubscribed}
										disabled={isLoadingSubscription}
										onCheckedChange={onSubscriptionToggle}
									/>
								}
								description="Receive updates about product releases, new features, and company news"
								title="Marketing Emails"
							/>
						</SettingsGroup>
					</SettingsSection>
					{transactionalNotificationsSlot}
				</TabsContent>

				<TabsContent
					className={tabContentClass}
					spacing="comfortable"
					value="connections"
				>
					<ConnectionsTabPanel
						connectAccount={connectAccount}
						connectingProvider={connectingProvider}
						connections={connections}
						unlinkAccount={unlinkAccount}
					/>
				</TabsContent>

				<TabsContent
					className={tabContentClass}
					spacing="comfortable"
					value="sessions"
				>
					{sessionsSlot}
				</TabsContent>

				<TabsContent
					className={tabContentClass}
					spacing="comfortable"
					value="authorized-apps"
				>
					{authorizedAppsSlot}
				</TabsContent>

				<TabsContent
					className={tabContentClass}
					spacing="comfortable"
					value="support-access"
				>
					{supportAccessSlot}
				</TabsContent>

				{emailsSlot ? (
					<TabsContent
						className={tabContentClass}
						spacing="comfortable"
						value="emails"
					>
						{emailsSlot}
					</TabsContent>
				) : null}
			</Tabs>
		</div>
	);
}
