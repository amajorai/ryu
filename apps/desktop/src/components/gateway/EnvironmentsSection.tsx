import { Add01Icon, Folder03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { SettingsNavRow } from "@ryu/blocks/desktop/settings-nav.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { NodeFolderBrowser } from "@/src/components/chat/NodeFolderBrowser.tsx";
import { ProjectSettingsDialog } from "@/src/components/layout/ProjectSettingsDialog.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { fetchGatewayGovernance } from "@/src/lib/api/governance.ts";
import { basename } from "@/src/lib/files.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import {
	GovernanceScopeSwitcher,
	type GovernanceView,
} from "./GovernanceScopeSwitcher.tsx";

const queryKey = (url: string, token: string | null) => [
	"gateway-governance",
	url,
	token,
];

export function EnvironmentsSection() {
	const node = useActiveNode();
	const [browserOpen, setBrowserOpen] = useState(false);
	const [editingPath, setEditingPath] = useState<string | null>(null);
	const [scope, setScope] = useState<GovernanceView>("effective");
	const projects = useWorkspaceStore((state) => state.projects);
	const recentFolders = useWorkspaceStore((state) => state.recentFolders);
	const addProjectFolder = useWorkspaceStore((state) => state.addProjectFolder);
	const paths = useMemo(() => {
		const allPaths = new Set<string>();
		for (const project of projects) {
			for (const folder of project.folders) {
				allPaths.add(folder);
			}
		}
		for (const folder of recentFolders) {
			allPaths.add(folder);
		}
		return [...allPaths].sort((left, right) => left.localeCompare(right));
	}, [projects, recentFolders]);
	const governance = useQuery({
		queryKey: queryKey(node.url, node.token ?? null),
		queryFn: ({ signal }) =>
			fetchGatewayGovernance(
				{ url: node.url, token: node.token, userJwt: node.userJwt ?? null },
				signal
			),
	});

	return (
		<>
			<div className="space-y-6">
				<SettingsSection
					caption="Local environments tell Ryu how to set up worktrees for a project. Scripts and variables stay with the project on this node."
					title="Environments"
				>
					<GovernanceScopeSwitcher
						layers={governance.data?.layers ?? []}
						onValueChange={setScope}
						value={scope}
					/>
				</SettingsSection>
				<SettingsSection
					headerAction={
						<Button
							onClick={() => setBrowserOpen(true)}
							size="sm"
							variant="ghost"
						>
							<HugeiconsIcon className="size-4" icon={Add01Icon} />
							Add project
						</Button>
					}
					title="Select a project"
				>
					{paths.length === 0 ? (
						<SettingsCard>
							<p className="text-center text-muted-foreground text-sm">
								No projects yet
							</p>
						</SettingsCard>
					) : (
						<SettingsGroup>
							{paths.map((path) => (
								<SettingsNavRow
									icon={Folder03Icon}
									key={path}
									onClick={() => setEditingPath(path)}
									tint="blue"
									title={
										<>
											{basename(path)}
											<span className="sr-only"> Edit</span>
										</>
									}
									value={
										<span
											className="block max-w-56 truncate font-mono text-xs"
											title={path}
										>
											{path}
										</span>
									}
								/>
							))}
						</SettingsGroup>
					)}
				</SettingsSection>
			</div>
			<NodeFolderBrowser
				onOpenChange={setBrowserOpen}
				onSelect={(path) => {
					addProjectFolder(path);
					setEditingPath(path);
					setBrowserOpen(false);
				}}
				open={browserOpen}
			/>
			{editingPath ? (
				<ProjectSettingsDialog
					onOpenChange={(open) => {
						if (!open) {
							setEditingPath(null);
						}
					}}
					open
					path={editingPath}
				/>
			) : null}
		</>
	);
}
