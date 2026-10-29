"use client";

import { CpuIcon } from "@hugeicons/core-free-icons";
import { SettingsIconTile } from "@ryu/blocks/desktop/settings-nav.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { CommandGroup, CommandSeparator } from "@ryu/ui/components/command.tsx";
import type { ReactNode } from "react";
import { ProviderCommandDialog } from "@/components/agent-elements/input/provider-command-dialog.tsx";
import { CapabilityProvidersSettings } from "@/src/components/settings/CapabilityProvidersSettings.tsx";
import { LlmProvidersSettings } from "@/src/components/settings/LlmProvidersSettings.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";

/**
 * Single entry point for node provider configuration. The capability editors
 * keep their own persistence contracts; this component owns discovery and
 * navigation so every provider surface opens from the same command dialog.
 */
export function ProviderControlCenter({
	canSetGatewayAccount = true,
	credentials,
	integrations,
	managed = false,
	routing,
}: {
	canSetGatewayAccount?: boolean;
	credentials: ReactNode;
	integrations: ReactNode;
	managed?: boolean;
	routing: ReactNode;
}) {
	return (
		<SettingsSection>
			<SettingsGroup>
				<SettingsItem
					actions={
						<ProviderCommandDialog
							renderBody={() => (
								<>
									<CommandGroup heading="Chat providers and models">
										<div className="p-2">
											<LlmProvidersSettings
												canSetGatewayAccount={canSetGatewayAccount && !managed}
											/>
										</div>
									</CommandGroup>
									<CommandSeparator />
									<CommandGroup heading="Image, speech, video, and embeddings">
										<div className="p-2">
											<CapabilityProvidersSettings />
										</div>
									</CommandGroup>
									<CommandSeparator />
									<CommandGroup heading="Credentials and integrations">
										<div className="p-2">{credentials}</div>
										<div className="p-2">{integrations}</div>
									</CommandGroup>
									<CommandSeparator />
									<CommandGroup heading="Routing and defaults">
										<div className="p-2">{routing}</div>
									</CommandGroup>
								</>
							)}
							title="Provider command center"
							trigger={
								// The visible label is just "Open"; the accessible name keeps
								// the full phrase the row's title gives it visually.
								<Button
									aria-label="Open provider command center"
									size="sm"
									type="button"
									variant="secondary"
								>
									Open
								</Button>
							}
						/>
					}
					description="Chat and media providers, credentials, integrations, and routing defaults, in one searchable place."
					title={
						<span className="flex items-center gap-2.5">
							<span className="contents" data-slot="settings-icon-tile">
								<SettingsIconTile icon={CpuIcon} tint="purple" />
							</span>
							<span className="min-w-0 truncate">Provider command center</span>
						</span>
					}
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}
