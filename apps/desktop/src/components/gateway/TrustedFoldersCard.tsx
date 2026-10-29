import { Button } from "@ryu/ui/components/button.tsx";
import { useEffect, useState } from "react";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	getTrustedWorkspaces,
	untrustWorkspace,
} from "@/src/lib/api/preferences.ts";

/**
 * Workspace trust: folders whose agents run with full autonomy. Backed by the
 * `trusted-workspaces` Core preference. Folders are added from the chat
 * ("Trust folder" on the untrusted-folder notice) and removed here. An agent
 * in any other folder keeps asking before it runs commands, cannot switch into
 * a mode that skips those prompts, and runs in Core's OS sandbox.
 */
export function TrustedFoldersCard({
	target,
	canConfigure,
}: {
	target: ApiTarget;
	canConfigure: boolean;
}) {
	const [folders, setFolders] = useState<string[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [removing, setRemoving] = useState<string | null>(null);
	const [status, setStatus] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setLoaded(false);
		getTrustedWorkspaces(target)
			.then((value) => {
				if (!cancelled) {
					setFolders(value);
					setLoaded(true);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setStatus(
						"Could not load trusted folders. Reopen settings to retry."
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [target]);

	const handleRemove = async (folder: string) => {
		if (!(canConfigure && loaded) || removing) {
			return;
		}
		setRemoving(folder);
		setStatus(null);
		try {
			if (!(await untrustWorkspace(target, folder))) {
				setStatus("Failed to update.");
				return;
			}
			setFolders((current) => current.filter((entry) => entry !== folder));
			setStatus(
				"Removed. Agents in that folder are limited from their next message."
			);
		} catch {
			setStatus("Failed to update.");
		} finally {
			setRemoving(null);
		}
	};

	return (
		<SettingsSection
			caption="Agents working in a folder you have not trusted keep asking before they run commands, cannot use modes that skip those prompts, and run in a sandbox that hides your credentials and limits their network to the Ryu Gateway. Trust a folder from the notice in its chat. A trusted folder covers every folder inside it."
			title="Trusted folders"
		>
			<div className="flex flex-col gap-3">
				{loaded && folders.length === 0 ? (
					<p className="px-3 text-muted-foreground text-sm">
						No trusted folders yet.
					</p>
				) : null}
				{folders.length > 0 ? (
					<SettingsGroup>
						{folders.map((folder) => (
							<SettingsItem
								actions={
									<Button
										disabled={!canConfigure || removing !== null}
										onClick={() => handleRemove(folder)}
										size="sm"
										variant="outline"
									>
										Remove
									</Button>
								}
								key={folder}
								title={
									<span className="break-all font-mono text-sm">{folder}</span>
								}
							/>
						))}
					</SettingsGroup>
				) : null}
				{status ? (
					<p className="px-3 text-muted-foreground text-sm">{status}</p>
				) : null}
			</div>
		</SettingsSection>
	);
}
