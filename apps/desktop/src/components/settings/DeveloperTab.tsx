// apps/desktop/src/components/settings/DeveloperTab.tsx
//
// The App Settings "Developer" section. A single master toggle enables
// Developer Mode, which unlocks debug-in-prod tools: the Agentation visual
// annotation toolbar, a console-output ring buffer on the crash screen, one-click
// diagnostics export, and a live view of the captured console. All toggles and
// actions are gated behind the master switch — flipping it off hides everything
// immediately.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useCallback, useEffect, useState } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useDeveloperMode } from "@/src/hooks/useDeveloperMode.ts";
import { useMidnightWipe } from "@/src/hooks/useMidnightWipe.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { channelLabel } from "@/src/lib/channel-brand.ts";
import {
	getConsoleBufferText,
	installConsoleCapture,
	isConsoleCaptureActive,
} from "@/src/lib/console-buffer.ts";
import { refreshDevMetricsGate } from "@/src/lib/dev-metrics.ts";
import { copyDiagnostics } from "@/src/lib/preflight.ts";
import { DevMetricsPanel } from "./DevMetricsPanel.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

export function DeveloperTab() {
	const tl = useLiteralMessages();
	const [devMode, setDevMode] = useDeveloperMode();
	const [consoleActive, setConsoleActive] = useState(isConsoleCaptureActive);
	const activeNode = useActiveNode();
	// Prerelease-only daily wipe. `supported` is decided in Rust from the running
	// build's PROFILE, never from the release-channel preference — that one is a
	// user-settable updater feed, and a stable user pointing it at "Canary" must
	// not be offered a delete of their real data folder.
	const midnightWipe = useMidnightWipe();

	const target: ApiTarget = {
		url: activeNode.url,
		token: activeNode.token ?? null,
		userJwt: activeNode.userJwt ?? null,
	};

	// When the user enables developer mode, activate console capture immediately
	// so the buffer starts filling without a reload.
	const handleToggleDevMode = useCallback(
		(next: boolean) => {
			setDevMode(next);
			// Same reason console capture is installed here: the metrics gate caches
			// its answer so a disabled recorder costs one branch, which means the flip
			// has to invalidate it or recording would not start until a reload.
			refreshDevMetricsGate();
			if (next && !isConsoleCaptureActive()) {
				installConsoleCapture();
				setConsoleActive(true);
			}
		},
		[setDevMode]
	);

	// Keep the console-active status in sync (e.g. after a hot reload).
	useEffect(() => {
		setConsoleActive(isConsoleCaptureActive());
	}, [devMode]);

	const handleCopyDiagnostics = useCallback(async () => {
		try {
			await copyDiagnostics(target);
			toast.success("Diagnostics copied to clipboard");
		} catch {
			toast.error("Couldn't copy diagnostics");
		}
	}, [target]);

	const handleCopyConsole = useCallback(async () => {
		const text = getConsoleBufferText();
		if (!text) {
			toast.error("Console buffer is empty");
			return;
		}
		try {
			await navigator.clipboard.writeText(text);
			toast.success("Console output copied to clipboard");
		} catch {
			toast.error("Couldn't copy to clipboard");
		}
	}, []);

	return (
		<div className="space-y-6">
			<SettingsSection
				caption="Enables debug tools for troubleshooting in production builds: visual annotation toolbar, console capture on crash, and one-click diagnostics. Your choice is remembered on this device."
				title="Developer Mode"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={devMode}
								id="developer-mode"
								onCheckedChange={handleToggleDevMode}
							/>
						}
						description="Show the Agentation annotation toolbar, capture console output for crash reports, and enable debug utilities below."
						title="Enable developer mode"
					/>
				</SettingsGroup>
			</SettingsSection>

			{devMode ? (
				<>
					<SettingsSection
						caption="Click any UI element to annotate it with a note. Notes sync to the local Agentation MCP server (port 4747) so a coding agent can read and act on them."
						title="Agentation toolbar"
					>
						<SettingsGroup>
							<SettingsItem
								actions={<Switch checked disabled id="agentation-toolbar" />}
								description="The floating toolbar is always visible while Developer Mode is on. It connects to a local Agentation MCP server."
								title="Toolbar active"
							/>
						</SettingsGroup>
					</SettingsSection>

					<SettingsSection
						caption="A ring buffer captures recent console output so the crash screen offers a one-click 'Copy console' button. Also included in diagnostics exports."
						title="Console capture"
					>
						<SettingsGroup>
							<SettingsItem
								actions={
									<Switch
										checked={consoleActive}
										disabled
										id="console-capture"
									/>
								}
								description={
									consoleActive
										? "Capturing. Up to 500 entries are kept in memory."
										: "Not yet active. It activates on next reload or when you toggle Developer Mode on."
								}
								title="Console buffer status"
							/>
						</SettingsGroup>
					</SettingsSection>

					<DevMetricsPanel />

					<SettingsSection
						caption="One-click actions for collecting debug information."
						title="Diagnostics"
					>
						<SettingsGroup>
							<SettingsItem
								actions={
									<Button
										onClick={handleCopyDiagnostics}
										size="sm"
										variant="ghost"
									>
										Copy diagnostics
									</Button>
								}
								description="Collects health, versions, sidecar status, and recent console output into one clipboard-ready bundle."
								title="Collect & copy diagnostics"
							/>
							<SettingsItem
								actions={
									<Button onClick={handleCopyConsole} size="sm" variant="ghost">
										Copy console
									</Button>
								}
								description="Copies the recent console output ring buffer (up to 500 entries) to your clipboard."
								title="Copy console output"
							/>
						</SettingsGroup>
					</SettingsSection>
				</>
			) : null}

			{/* Prerelease builds only. OUTSIDE the Developer Mode gate on purpose:
			    this one deletes data, so the switch that turns it OFF must never
			    be reachable only through a second toggle. `supported` is false on
			    stable and dev builds, where the row is hidden rather than disabled
			    because there is no isolated data folder for it to act on. */}
			{midnightWipe.status?.supported ? (
				<SettingsSection
					caption={tl(
						"Returns this {channel} build to a just-installed state on the first launch of each day, so first-run and onboarding paths get exercised the way a new user meets them. Off by default, stored outside the folder it clears, and it never touches your stable install.",
						{ channel: channelLabel(midnightWipe.status.profile) }
					)}
					title="Daily data reset"
				>
					<SettingsGroup>
						<SettingsItem
							actions={
								<Switch
									checked={midnightWipe.status.enabled}
									id="midnight-wipe"
									onCheckedChange={(next) => {
										midnightWipe.setEnabled(next).then((applied) => {
											if (!applied) {
												toast.error("Couldn't save that setting");
												return;
											}
											toast.success(
												next
													? "Daily reset on. This build's data folder clears at the first launch after midnight"
													: "Daily reset off"
											);
										});
									}}
								/>
							}
							description={
								tl(
									"Deletes everything in {dataDir} (chats, agents, spaces, installed apps and downloads) at the first launch after midnight. Your encryption key survives so the node still boots, and several missed days still clear it exactly once.",
									{ dataDir: midnightWipe.status.data_dir }
								) +
								(midnightWipe.status.last_wipe_date
									? ` ${tl("Last cleared {date}.", { date: midnightWipe.status.last_wipe_date })}`
									: "")
							}
							title="Wipe this data folder at midnight"
						/>
						{midnightWipe.error ? (
							<SettingsItem
								description={midnightWipe.error}
								title="Couldn't save that setting"
							/>
						) : null}
					</SettingsGroup>
				</SettingsSection>
			) : null}
		</div>
	);
}
