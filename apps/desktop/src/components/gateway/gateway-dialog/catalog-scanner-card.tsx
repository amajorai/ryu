import { Button } from "@ryu/ui/components/button.tsx";
import { useEffect, useState } from "react";
import { AgentModelPickerField } from "@/components/agent-elements/input/agent-model-picker-field.tsx";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { CATALOG_SCAN_AGENT_PREF } from "@/src/lib/api/catalog-scan.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { getPreference, setPreference } from "@/src/lib/api/preferences.ts";

/** Gateway-owned choice of which registered, read-only agent reviews catalog
 *  listings after the deterministic scorecard. Stored as a node preference so
 *  every catalog surface and the Security Scanner command share one choice. */
export function CatalogScannerCard({
	target,
	canConfigure,
}: {
	target: ApiTarget;
	canConfigure: boolean;
}) {
	const [agentId, setAgentId] = useState("");
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [status, setStatus] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setLoaded(false);
		getPreference(target, CATALOG_SCAN_AGENT_PREF)
			.then((value) => {
				if (cancelled) {
					return;
				}
				setAgentId(value?.trim() || "");
				setLoaded(true);
			})
			.catch(() => {
				if (!cancelled) {
					setStatus(
						"Could not load the audit agent. Reopen settings to retry."
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [target]);

	const updateAgent = async (next: string) => {
		if (saving) {
			return;
		}
		const trimmed = next.trim();
		const previous = agentId;
		setSaving(true);
		setAgentId(trimmed);
		setStatus(null);
		try {
			await setPreference(target, CATALOG_SCAN_AGENT_PREF, trimmed);
			setStatus("Saved for this node.");
		} catch {
			setAgentId(previous);
			setStatus("Could not save the audit agent. Try again.");
		} finally {
			setSaving(false);
		}
	};

	return (
		<div data-testid="catalog-scanner-settings">
			<SettingsSection
				caption={
					<CaptionInfo
						detail={
							"On-demand audits run the health audit skill with your default chat agent. Optionally choose a reviewer for Marketplace, agent health, and Doctor. Normal runtime permissions and approvals apply; static checks remain the default."
						}
					>
						{"On-demand audits run with your default chat agent."}
					</CaptionInfo>
				}
				title="Health audit agent"
			>
				<div className="flex flex-col gap-3">
					<SettingsGroup>
						<SettingsItem
							actions={
								<div className="flex items-center gap-1">
									<AgentModelPickerField
										ariaLabel="Catalog scanning agent"
										className="min-w-[220px]"
										disabled={!(canConfigure && loaded) || saving}
										mode="agent"
										onChange={(next) => {
											void updateAgent(next);
										}}
										placeholder="Use default agent"
										target={target}
										value={agentId}
									/>
									<Button
										disabled={!(canConfigure && loaded && agentId) || saving}
										onClick={() => void updateAgent("")}
										size="sm"
										variant="ghost"
									>
										Use default agent
									</Button>
								</div>
							}
							description="Used by Audit with agent across all Health views. Leave unset to follow the default chat agent."
							settingsId="catalog-scan-agent"
							title="Scanning agent"
						/>
					</SettingsGroup>
					{status ? (
						<p className="px-3 text-muted-foreground text-sm">{status}</p>
					) : null}
				</div>
			</SettingsSection>
		</div>
	);
}
