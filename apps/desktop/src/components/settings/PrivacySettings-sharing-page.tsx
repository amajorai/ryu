// apps/desktop/src/components/settings/PrivacySettings-sharing-page.tsx
//
// The "Usage & crash data" sub-page of the Privacy tab.

import { Switch } from "@ryu/ui/components/switch.tsx";
import { AnalyticsInspector } from "./AnalyticsInspector.tsx";
import type { PrivacyPreferences } from "./PrivacySettings-preferences.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

export function SharingPage({
	busyKeys,
	prefs,
	privacyReady,
}: {
	busyKeys: string[];
	prefs: PrivacyPreferences;
	privacyReady: boolean;
}) {
	const {
		communityStats,
		crashReports,
		handleCommunityStats,
		handleCrashReports,
		handleProductAnalytics,
		handleProfileActivity,
		productAnalytics,
		profileActivity,
	} = prefs;
	return (
		<>
			<SettingsSection
				caption="On by default. Ryu's anonymous, content-free usage events (which screens you open, whether onboarding finished, install success) help us improve Ryu. Managed nodes also send a small content-free heartbeat while this is on. Never includes prompts, conversations, files, or any agent content; identified only by a random install ID, not your account."
				title="Product analytics"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={productAnalytics}
								disabled={!privacyReady || busyKeys.includes("analytics")}
								id="product-analytics"
								onCheckedChange={handleProductAnalytics}
							/>
						}
						title="Share anonymous usage analytics"
					/>
					<SettingsItem
						actions={<AnalyticsInspector />}
						description="See the full list of events the app can send and a local log of what was sent from this install."
						title="What we send"
					/>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection
				caption="On by default, opt-out. Shares anonymous, aggregate token-savings stats (request counts and tokens saved by the Gateway) so the community leaderboard reflects real usage. Never includes prompts, conversations, files, or any agent content; identified only by a random install ID, never your account or hostname. Turn it off anytime."
				title="Community stats"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={communityStats}
								disabled={!privacyReady || busyKeys.includes("community")}
								id="community-stats"
								onCheckedChange={handleCommunityStats}
							/>
						}
						title="Share anonymous community stats"
					/>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection
				caption="On by default, opt-out. Linked to your account, not anonymous. When you're signed in, Ryu tells Ryu Cloud which days this account was active on this device, so they keep your profile streak going. If this device's Gateway doesn't already report usage to Ryu Cloud, it also sends this device's daily usage totals (tokens, requests, sessions, and requests per model) so your profile stats include them. These totals never earn points. Never prompts, conversations, files, or agent content."
				title="Profile activity"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={profileActivity}
								disabled={
									!privacyReady || busyKeys.includes("profile-activity")
								}
								id="profile-activity"
								onCheckedChange={handleProfileActivity}
							/>
						}
						description="Chats and agent runs on this device, including scheduled ones, count toward your streak, and this device's daily usage totals are included in your profile stats. No content is sent."
						title="Sync activity on this device to your profile"
					/>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection
				caption="On by default, separate from analytics. Sends scrubbed crash and error stacks so we can fix what fails. No prompts or content."
				title="Crash reports"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={crashReports}
								disabled={!privacyReady || busyKeys.includes("crashes")}
								id="crash-reports"
								onCheckedChange={handleCrashReports}
							/>
						}
						title="Send crash and error reports"
					/>
				</SettingsGroup>
			</SettingsSection>
		</>
	);
}
