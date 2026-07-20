// apps/desktop/src/components/settings/ExperimentalSettings.tsx
//
// The App Settings "Experimental" section: the operator opt-in for surfaces that
// are built but not yet on by default. Today that is exactly one flag — the
// third-party plugin RUNTIME (`PLUGIN_RUNTIME_FLAG`), i.e. the code-execution
// path that fetches a plugin's bundled UI and mounts it in the sandboxed
// null-origin ExtensionHost iframe.
//
// Why opt-IN and not opt-OUT: the shipping default stays OFF until the browser
// security certificate (`e2e/plugin-runtime.spec.ts`, run by the
// `plugin-runtime-cert` CI job) is a REQUIRED, GREEN check — see the gate spelled
// out on PLUGIN_RUNTIME_FLAG in `src/lib/experimental.ts`. The spec passes locally
// against the real `@ryu/app-host` boundary, but "green on my machine" is not the
// gate. Until CI certifies it, a plugin with a verified `ui_code` bundle keeps
// rendering the benign data-driven summary for normal users, and only an operator
// who knowingly flips this switch runs the sandboxed code.
//
// The flag fans out live: flipping it dispatches EXPERIMENTAL_CHANGED_EVENT, which
// PluginCompanionPage, AppWidget, and ChatPage all re-sync from — no reload.

import { Alert01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Switch } from "@ryu/ui/components/switch";
import {
	PLUGIN_RUNTIME_FLAG,
	useExperimentalFlag,
} from "@/src/lib/experimental.ts";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

export function ExperimentalSettings() {
	const { enabled: pluginRuntime, setEnabled: setPluginRuntime } =
		useExperimentalFlag(PLUGIN_RUNTIME_FLAG);

	return (
		<div className="space-y-6">
			<SettingsSection
				caption="Off by default. These surfaces are built but not yet on for everyone. Turning one on changes how this app behaves — read what each one does first. Your choice is remembered on this device."
				title="Experimental"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={pluginRuntime}
								id="experimental-plugin-runtime"
								onCheckedChange={setPluginRuntime}
							/>
						}
						description="Lets an installed plugin run its own code in this app. The code runs inside a locked-down frame that has no network access and cannot read this window, and it can only use the permissions you granted the plugin — but it is still third-party code running on your machine. With this off, a plugin only shows a read-only summary of its data and never runs its own code."
						title="Run plugin interfaces"
					/>
				</SettingsGroup>
			</SettingsSection>

			{pluginRuntime ? (
				<SettingsCard className="flex items-start gap-2.5 border-warning/40">
					<HugeiconsIcon
						className="mt-0.5 size-4 shrink-0 opacity-70"
						icon={Alert01Icon}
					/>
					<p className="text-muted-foreground text-xs leading-relaxed">
						Plugin interfaces are running. Only enable plugins you trust — a
						plugin's interface can use the permissions you granted it (for
						example, listing your agents or sending a prompt). Turn this back
						off at any time and plugins immediately fall back to their read-only
						summary.
					</p>
				</SettingsCard>
			) : null}
		</div>
	);
}
