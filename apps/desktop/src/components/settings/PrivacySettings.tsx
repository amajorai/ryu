// apps/desktop/src/components/settings/PrivacySettings.tsx
//
// The Privacy tab (P0 of docs/observability-analytics-support-access.md). It
// surfaces the independent consent toggles from the §6 defaults table, each
// defaulting per that table — closed-UI product analytics + crash reports are
// opt-out (ON by default), while data-plane OTLP diagnostics export and local
// Core support access are opt-in (OFF). The first-run disclosure is completed
// in onboarding; this tab remains the place to review or change it later.
//
// The canonical Core preferences are the source of truth. This tab also seeds
// the live analytics and crash gates immediately, while Core/Gateway read the
// same preferences when their exporters start; collection cannot precede the
// user's persisted choice.

import {
	ChartLineData01Icon,
	SecurityCheckIcon,
	Stethoscope02Icon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { SettingsSubpages } from "@ryu/blocks/desktop/settings-nav.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { useCallback, useState } from "react";
import { FRONTEND_URL } from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { usePendingSubpage } from "@/src/hooks/useSettingSubpage.ts";
import { CustomAppSecuritySettings } from "./CustomAppSecuritySettings.tsx";
import { DevicePermissionsSettings } from "./DevicePermissionsSettings.tsx";
import { NotificationSettings } from "./NotificationSettings.tsx";
import { DiagnosticsPage } from "./PrivacySettings-diagnostics-page.tsx";
import { HealingPage, usePrivacyHealing } from "./PrivacySettings-healing.tsx";
import { usePrivacyPreferences } from "./PrivacySettings-preferences.ts";
import { usePrivacyRuntime } from "./PrivacySettings-runtime.ts";
import { SharingPage } from "./PrivacySettings-sharing-page.tsx";
import {
	acknowledgePrivacyDisclosure,
	PRIVACY_DOCS_PATH as DOCS_PATH,
	isPrivacyDisclosureAcknowledged,
} from "./privacy-disclosure-state.ts";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";
import { TrainingDataNotice } from "./TrainingDataNotice.tsx";

export function PrivacySettings() {
	// Which sub-page a pending settings-search hit is on — a row on a closed page
	// is not in the DOM the reveal polls.
	const pendingSubpage = usePendingSubpage("privacy");
	const runtime = usePrivacyRuntime();
	const { busyKeys, privacyLoadError, privacyReady, setLoadAttempt, target } =
		runtime;
	const healing = usePrivacyHealing(runtime);
	const { healingLoadError } = healing;
	const prefs = usePrivacyPreferences(runtime);

	const [disclosureAck, setDisclosureAck] = useState<boolean>(
		isPrivacyDisclosureAcknowledged
	);
	const acknowledgeDisclosure = useCallback(() => {
		setDisclosureAck(true);
		acknowledgePrivacyDisclosure();
	}, []);

	// Open the published privacy/data page in the browser so the reference is a
	// real, followable link rather than a dead file path.
	const openDocs = useCallback(() => {
		Promise.resolve(openExternal(`${FRONTEND_URL}${DOCS_PATH}`)).catch(
			() => undefined
		);
	}, []);

	// ── Sub-pages ────────────────────────────────────────────────────────────
	// Seven sections, each a switch under a paragraph of explanation, in one
	// scroll — so the answer to "what does Ryu send anywhere" was four screens
	// long. Grouped into three pages the way iOS Privacy & Security is: what we
	// collect, what you can export or grant, and what runs on its own.
	//
	// The disclosure banner and "Learn more" stay on the index: the first is the
	// consent prompt itself, and the second is the plain-English summary that
	// makes the rest legible.
	//
	// Groups → page ids are mirrored in `SUBPAGE_BY_GROUP` (`settings-index.ts`)
	// so settings search can still reveal a row behind a closed page.
	const disclosureIntro = (
		<div className="space-y-6">
			<TrainingDataNotice />
			{disclosureAck ? null : (
				<SettingsGroup>
					<SettingsItem
						actions={
							<Button onClick={acknowledgeDisclosure} size="sm">
								Got it
							</Button>
						}
						title="How Ryu handles your data"
					>
						<p className="pb-1 text-muted-foreground text-xs leading-relaxed">
							Anonymous, content-free product analytics and crash reports are on
							by default so we can fix what breaks and improve the app. They
							never include your prompts, conversations, files, or any agent
							content, and they use a random install ID that is not linked to
							your account. Product analytics is separate from your local
							Core/Gateway traces and diagnostics: those stay on your device
							unless you turn on export to a destination you choose. You can
							change any of these any time. See{" "}
							<button
								className="text-primary underline underline-offset-2"
								onClick={openDocs}
								type="button"
							>
								our privacy &amp; data page
							</button>{" "}
							for the full breakdown.
						</p>
					</SettingsItem>
				</SettingsGroup>
			)}
		</div>
	);

	const sharingPage = (
		<SharingPage
			busyKeys={busyKeys}
			prefs={prefs}
			privacyReady={privacyReady}
		/>
	);

	const diagnosticsPage = (
		<DiagnosticsPage
			busyKeys={busyKeys}
			prefs={prefs}
			privacyReady={privacyReady}
		/>
	);

	const healingPage = <HealingPage busyKeys={busyKeys} healing={healing} />;

	const learnMore = (
		<>
			<SettingsSection title="Learn more">
				<SettingsCard>
					<p className="text-muted-foreground text-xs leading-relaxed">
						Ryu is local-first and encrypted by default. Your prompts and agent
						content never leave your device except for the model call itself;
						content-free analytics and diagnostics are separate controls. For
						the full policy, see{" "}
						<button
							className="text-primary underline underline-offset-2"
							onClick={openDocs}
							type="button"
						>
							our privacy &amp; data page
						</button>
						.
					</p>
				</SettingsCard>
			</SettingsSection>
		</>
	);

	return (
		<div className="flex flex-col gap-6">
			{(privacyLoadError || healingLoadError) && (
				<SettingsCard className="flex items-center justify-between gap-3">
					<p className="text-muted-foreground text-sm" role="alert">
						{privacyLoadError || healingLoadError}
					</p>
					<Button
						onClick={() => setLoadAttempt((attempt) => attempt + 1)}
						size="sm"
						variant="outline"
					>
						Retry privacy settings
					</Button>
				</SettingsCard>
			)}
			<SettingsSubpages
				backLabel="Privacy"
				intro={disclosureIntro}
				label="What leaves this device"
				outro={learnMore}
				pages={[
					{
						id: "device-permissions",
						title: "Device permissions",
						hint: "Notifications, microphone, screen recording, accessibility, and capture shortcuts.",
						icon: Wrench01Icon,
						tint: "teal",
						content: (
							<>
								<NotificationSettings />
								<DevicePermissionsSettings />
							</>
						),
					},
					{
						id: "sharing",
						title: "Usage & crash data",
						hint: "Anonymous analytics and community stats, account-linked profile activity, and crash reports.",
						icon: ChartLineData01Icon,
						tint: "blue",
						content: sharingPage,
					},
					{
						id: "diagnostics",
						title: "Diagnostics & support",
						hint: "Export traces to your own endpoint, or open a read-only support channel.",
						icon: Stethoscope02Icon,
						tint: "teal",
						content: diagnosticsPage,
					},
					{
						id: "healing",
						title: "Self-healing",
						hint: "Let Ryu diagnose a failed run and propose — or apply — a fix.",
						icon: Wrench01Icon,
						tint: "orange",
						content: healingPage,
					},
					{
						id: "security",
						title: "Custom app security",
						hint: "Set the default content security policy for custom apps.",
						icon: SecurityCheckIcon,
						tint: "red",
						content: (
							<CustomAppSecuritySettings key={target.url} target={target} />
						),
					},
				]}
				revealPageId={pendingSubpage}
			/>
		</div>
	);
}
