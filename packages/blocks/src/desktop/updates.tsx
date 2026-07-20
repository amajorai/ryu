"use client";

// Presentational layer of the desktop Updates settings tab. The live app
// (`apps/desktop/src/components/settings/UpdatesSettings.tsx`) is a thin
// container that talks to Core's update API; the storyboard renders the same
// component with mock data. One source of truth, so editing this block changes
// the real desktop too.

import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@ryu/blocks/desktop/settings-items";
import { Button } from "@ryu/ui/components/button";
import { Switch } from "@ryu/ui/components/switch";

export interface UpdatesViewProps {
	autoUpdate?: boolean;
	checking?: boolean;
	/** When updates are mandatory, the toggle is forced on and disabled. */
	forceAutoUpdate?: boolean;
	onCheck?: () => void;
	onToggle?: (next: boolean) => void;
	version?: string | null;
}

export function UpdatesView({
	version,
	autoUpdate = true,
	checking,
	forceAutoUpdate,
	onToggle,
	onCheck,
}: UpdatesViewProps) {
	return (
		<div className="space-y-6">
			<SettingsSection
				caption={version ? `Current version: v${version}.` : undefined}
				title="Software updates"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								aria-label="Toggle automatic updates"
								checked={forceAutoUpdate ? true : autoUpdate}
								disabled={forceAutoUpdate}
								onCheckedChange={onToggle}
							/>
						}
						description={
							forceAutoUpdate
								? "Updates are required and install automatically on launch to keep every version current."
								: "Check for updates on launch and install them automatically."
						}
						title="Automatic updates"
					/>
					<SettingsItem
						actions={
							<Button
								disabled={checking}
								onClick={onCheck}
								size="sm"
								variant="outline"
							>
								{checking ? "Checking…" : "Check for updates"}
							</Button>
						}
						description="Manually check for a new release now."
						title="Check for updates"
					/>
				</SettingsGroup>
			</SettingsSection>
		</div>
	);
}
