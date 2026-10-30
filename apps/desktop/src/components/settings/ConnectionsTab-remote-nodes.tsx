import {
	Add01Icon,
	Cancel01Icon,
	CloudServerIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { SettingsIconTile } from "@ryu/blocks/desktop/settings-nav.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { useEffect, useMemo, useState } from "react";
import { sileo } from "sileo";
import {
	isLocalNode,
	type Node,
	useNodeStore,
} from "@/src/store/useNodeStore.ts";
import { RowTitle } from "./ConnectionsTab-row-title.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

function RemoteNodeDialog({
	onOpenChange,
	open,
}: {
	onOpenChange: (open: boolean) => void;
	open: boolean;
}) {
	const addNode = useNodeStore((state) => state.addNode);
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [token, setToken] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (open) {
			setName("");
			setUrl("");
			setToken("");
			setError(null);
		}
	}, [open]);

	const handleAdd = async () => {
		if (!(name.trim() && url.trim()) || saving) {
			return;
		}
		setSaving(true);
		setError(null);
		try {
			await addNode(name.trim(), url.trim(), token.trim() || undefined);
			onOpenChange(false);
			sileo.success({ title: "Remote node added" });
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Add remote node</DialogTitle>
					<DialogDescription>
						Connect a Ryu node so its folders can be used as remote projects.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-3">
					<div className="space-y-1.5">
						<Label htmlFor="remote-node-name">Display name</Label>
						<Input
							disabled={saving}
							id="remote-node-name"
							onChange={(event) => setName(event.target.value)}
							placeholder="Build server"
							value={name}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="remote-node-url">Node URL</Label>
						<Input
							autoCapitalize="off"
							autoCorrect="off"
							disabled={saving}
							id="remote-node-url"
							onChange={(event) => setUrl(event.target.value)}
							placeholder="https://server.example.com:7980"
							value={url}
							variant="code-caption"
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="remote-node-token">Access token (optional)</Label>
						<Input
							autoCapitalize="off"
							autoCorrect="off"
							disabled={saving}
							id="remote-node-token"
							onChange={(event) => setToken(event.target.value)}
							placeholder="Paste a node token when required"
							type="password"
							value={token}
							variant="code-caption"
						/>
					</div>
					{error ? (
						<p className="text-status-destructive text-xs" role="alert">
							{error}
						</p>
					) : null}
				</div>
				<DialogFooter>
					<Button
						disabled={saving}
						onClick={() => onOpenChange(false)}
						variant="ghost"
					>
						Cancel
					</Button>
					<Button
						disabled={!(name.trim() && url.trim())}
						loading={saving}
						onClick={() => void handleAdd()}
						type="button"
					>
						Add remote
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function RemoteNodesSection() {
	const nodes = useNodeStore((state) => state.nodes);
	const defaultNode = useNodeStore((state) => state.defaultNode);
	const setDefault = useNodeStore((state) => state.setDefault);
	const removeNode = useNodeStore((state) => state.removeNode);
	const remoteNodes = useMemo(
		() => nodes.filter((node) => !isLocalNode(node)),
		[nodes]
	);
	const [addOpen, setAddOpen] = useState(false);
	const tl = useLiteralMessages();

	const useNode = async (node: Node) => {
		try {
			await setDefault(node.name);
			sileo.success({
				title: tl("{name} is now active", { name: node.name }),
			});
		} catch (cause) {
			sileo.error({
				title: "Could not switch nodes",
				description: cause instanceof Error ? cause.message : String(cause),
			});
		}
	};

	const remove = async (node: Node) => {
		try {
			await removeNode(node.name);
			sileo.success({ title: `${node.name} removed` });
		} catch (cause) {
			sileo.error({
				title: "Could not remove node",
				description: cause instanceof Error ? cause.message : String(cause),
			});
		}
	};

	return (
		<>
			<SettingsSection
				caption="Remote projects run on a connected Ryu node. The node keeps its files, Git credentials, and agent runtime; this device stores only its connection details."
				headerAction={
					<Button onClick={() => setAddOpen(true)} size="sm" variant="ghost">
						<HugeiconsIcon className="size-4" icon={Add01Icon} />
						Add remote
					</Button>
				}
				title="Remote nodes"
			>
				{remoteNodes.length > 0 ? (
					<SettingsGroup>
						{remoteNodes.map((node) => {
							const active = node.name === defaultNode;
							return (
								<SettingsItem
									actions={
										<div className="flex items-center gap-1">
											{active ? (
												<Badge variant="secondary">Active</Badge>
											) : (
												<Button
													onClick={() => void useNode(node)}
													size="sm"
													variant="ghost"
												>
													Use
												</Button>
											)}
											<Button
												aria-label={tl("Remove {name}", { name: node.name })}
												onClick={() => void remove(node)}
												size="sm"
												variant="ghost"
											>
												<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
											</Button>
										</div>
									}
									description={
										<span className="type-caption font-mono">{node.url}</span>
									}
									key={node.name}
									title={
										<RowTitle
											leading={
												<SettingsIconTile
													icon={CloudServerIcon}
													tint="indigo"
												/>
											}
											name={node.name}
										/>
									}
								/>
							);
						})}
					</SettingsGroup>
				) : (
					<SettingsCard>
						<p className="text-center text-muted-foreground text-sm">
							No remote nodes yet. Add a node to browse and work on another
							machine.
						</p>
					</SettingsCard>
				)}
			</SettingsSection>
			<RemoteNodeDialog onOpenChange={setAddOpen} open={addOpen} />
		</>
	);
}
