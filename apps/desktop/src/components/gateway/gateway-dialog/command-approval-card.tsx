import { Switch } from "@ryu/ui/components/switch.tsx";
import { useEffect, useState } from "react";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	getExecApprovalEnabled,
	setExecApprovalEnabled,
} from "@/src/lib/api/preferences.ts";

/**
 * Command-approval gate: scan every ACP agent's native tool calls (Claude/Codex
 * `Bash`/`Write`/`Edit`, …) through the gateway command-approval scanner at the
 * `request_permission` seam before they run. Backed by the `exec-approval-mode`
 * Core preference; Core applies preference writes to the live scanner unless an
 * operator environment override takes precedence. When on, the scan is fail-closed and defers to the
 * firewall / allow-deny rules configured in the cards above.
 */
export function CommandApprovalCard({
	target,
	canConfigure,
}: {
	target: ApiTarget;
	canConfigure: boolean;
}) {
	// Armed by default (matches Core: unset pref scans; explicit off disarms).
	const [enabled, setEnabled] = useState(true);
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [status, setStatus] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setLoaded(false);
		getExecApprovalEnabled(target)
			.then((value) => {
				if (!cancelled) {
					setEnabled(value);
					setLoaded(true);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setStatus(
						"Could not load command approval. Reopen settings to retry."
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [target]);

	const handleToggle = async (next: boolean) => {
		if (!(canConfigure && loaded) || saving) {
			return;
		}
		const previous = enabled;
		setSaving(true);
		setEnabled(next);
		setStatus(null);
		try {
			await setExecApprovalEnabled(target, next);
			setStatus(
				next
					? "Enabled. Saved for this node."
					: "Disabled. Saved for this node."
			);
		} catch {
			setEnabled(previous);
			setStatus("Failed to update.");
		} finally {
			setSaving(false);
		}
	};

	return (
		<SettingsSection
			caption={
				<CaptionInfo
					detail={
						"Pre-scan every agent's native tool calls (Claude/Codex Bash, Write, Edit, and the rest) through the command-approval scanner before they run, closing the gap where an agent's own file/shell tools bypassed the gateway. On by default and fail-closed: it defers to the firewall and allow/deny rules above, headless runs reject commands that need human approval. Changes apply immediately unless an operator environment override takes precedence."
					}
				>
					{"Scan agents' own shell and file tool calls before they run."}
				</CaptionInfo>
			}
			title="Command approval"
		>
			<div className="flex flex-col gap-3">
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={enabled}
								disabled={!(canConfigure && loaded) || saving}
								id="exec-approval-enabled"
								onCheckedChange={handleToggle}
							/>
						}
						description="Scan native agent tool calls at the ACP permission seam"
						title="Scan agent tool commands"
					/>
				</SettingsGroup>
				{status ? (
					<p className="px-3 text-muted-foreground text-sm">{status}</p>
				) : null}
			</div>
		</SettingsSection>
	);
}
