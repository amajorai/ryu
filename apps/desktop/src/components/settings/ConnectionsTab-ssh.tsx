import {
	Add01Icon,
	Cancel01Icon,
	Link01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { SettingsIconTile } from "@ryu/blocks/desktop/settings-nav.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
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
import { useEffect, useState } from "react";
import { sileo } from "sileo";
import {
	loadSshConnections,
	normalizeSshConnection,
	type SshAuthMode,
	type SshConnection,
	saveSshConnections,
} from "@/src/lib/ssh-connections.ts";
import { RowTitle } from "./ConnectionsTab-row-title.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

function SshConnectionDialog({
	connection,
	onOpenChange,
	onSave,
	open,
}: {
	connection: SshConnection | null;
	onOpenChange: (open: boolean) => void;
	onSave: (connection: SshConnection) => void;
	open: boolean;
}) {
	const [name, setName] = useState("");
	const [host, setHost] = useState("");
	const [username, setUsername] = useState("");
	const [port, setPort] = useState("22");
	const [auth, setAuth] = useState<SshAuthMode>("none");
	const [identityFile, setIdentityFile] = useState("");
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) {
			return;
		}
		setName(connection?.name ?? "");
		setHost(connection?.host ?? "");
		setUsername(connection?.username ?? "");
		setPort(String(connection?.port ?? 22));
		setAuth(connection?.auth ?? "none");
		setIdentityFile(connection?.identityFile ?? "");
		setError(null);
	}, [connection, open]);

	const handleSave = () => {
		const rawHost = host.trim();
		let parsedHost = rawHost;
		let parsedUsername = username.trim();
		const at = rawHost.lastIndexOf("@");
		if (at > 0 && !parsedUsername) {
			parsedUsername = rawHost.slice(0, at);
			parsedHost = rawHost.slice(at + 1);
		}
		if (auth === "identity" && !identityFile.trim()) {
			setError("Choose an identity file path");
			return;
		}
		const normalized = normalizeSshConnection({
			auth,
			host: parsedHost,
			id: connection?.id,
			identityFile: auth === "identity" ? identityFile : undefined,
			name,
			port: Number(port),
			username: parsedUsername,
		});
		if (!normalized) {
			setError("Enter a display name, valid host, and port from 1 to 65535");
			return;
		}
		onSave(normalized);
	};

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{connection ? "Edit SSH connection" : "Add SSH connection"}
					</DialogTitle>
					<DialogDescription>
						Save the host details here. Ryu never reads or stores your private
						key.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-3">
					<div className="space-y-1.5">
						<Label htmlFor="ssh-connection-name">Display name</Label>
						<Input
							id="ssh-connection-name"
							onChange={(event) => setName(event.target.value)}
							placeholder="Build server"
							value={name}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="ssh-connection-host">Hostname</Label>
						<Input
							autoCapitalize="off"
							autoCorrect="off"
							id="ssh-connection-host"
							onChange={(event) => setHost(event.target.value)}
							placeholder="host.com or user@host.com"
							value={host}
							variant="code-caption"
						/>
					</div>
					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-1.5">
							<Label htmlFor="ssh-connection-user">Username</Label>
							<Input
								autoCapitalize="off"
								autoCorrect="off"
								id="ssh-connection-user"
								onChange={(event) => setUsername(event.target.value)}
								placeholder="Optional"
								value={username}
								variant="code-caption"
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="ssh-connection-port">SSH port</Label>
							<Input
								id="ssh-connection-port"
								inputMode="numeric"
								onChange={(event) => setPort(event.target.value)}
								placeholder="22"
								value={port}
								variant="code-caption"
							/>
						</div>
					</div>
					<div className="space-y-1.5">
						<p className="font-medium text-sm">Authentication</p>
						<div
							aria-label="SSH authentication"
							className="grid grid-cols-2 gap-1 rounded-lg bg-muted/40 p-1"
							role="group"
						>
							<Button
								aria-pressed={auth === "none"}
								className="w-full"
								onClick={() => setAuth("none")}
								size="sm"
								variant={auth === "none" ? "secondary" : "ghost"}
							>
								No auth
							</Button>
							<Button
								aria-pressed={auth === "identity"}
								className="w-full"
								onClick={() => setAuth("identity")}
								size="sm"
								variant={auth === "identity" ? "secondary" : "ghost"}
							>
								Identity file
							</Button>
						</div>
					</div>
					{auth === "identity" ? (
						<div className="space-y-1.5">
							<Label htmlFor="ssh-connection-identity">
								Identity file path
							</Label>
							<Input
								autoCapitalize="off"
								autoCorrect="off"
								id="ssh-connection-identity"
								onChange={(event) => setIdentityFile(event.target.value)}
								placeholder="~/.ssh/id_ed25519"
								value={identityFile}
								variant="code-caption"
							/>
						</div>
					) : null}
					{error ? (
						<p className="text-status-destructive text-xs" role="alert">
							{error}
						</p>
					) : null}
				</div>
				<DialogFooter>
					<Button onClick={() => onOpenChange(false)} variant="ghost">
						Cancel
					</Button>
					<Button onClick={handleSave} type="button">
						Save connection
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function SshConnectionsSection() {
	const [connections, setConnections] = useState<SshConnection[]>(() =>
		loadSshConnections()
	);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [editing, setEditing] = useState<SshConnection | null>(null);
	const tl = useLiteralMessages();

	const openAdd = () => {
		setEditing(null);
		setDialogOpen(true);
	};

	const openEdit = (connection: SshConnection) => {
		setEditing(connection);
		setDialogOpen(true);
	};

	const handleSave = (connection: SshConnection) => {
		const next = editing
			? connections.map((item) => (item.id === editing.id ? connection : item))
			: [...connections, connection];
		saveSshConnections(next);
		setConnections(next);
		setDialogOpen(false);
		sileo.success({
			title: editing ? "SSH connection updated" : "SSH connection saved",
		});
	};

	const handleRemove = (connection: SshConnection) => {
		const next = connections.filter((item) => item.id !== connection.id);
		saveSshConnections(next);
		setConnections(next);
		sileo.success({ title: `${connection.name} removed` });
	};

	return (
		<>
			<SettingsSection
				caption="These profiles stay on this device and contain only connection metadata. Private keys remain in the identity-file location you choose."
				headerAction={
					<Button onClick={openAdd} size="sm" variant="ghost">
						<HugeiconsIcon className="size-4" icon={Add01Icon} />
						Add manually
					</Button>
				}
				title="SSH connections from this device"
			>
				{connections.length > 0 ? (
					<SettingsGroup>
						{connections.map((connection) => (
							<SettingsItem
								actions={
									<div className="flex items-center gap-1">
										<Button
											onClick={() => openEdit(connection)}
											size="sm"
											variant="ghost"
										>
											Edit
										</Button>
										<Button
											aria-label={tl("Remove {name}", {
												name: connection.name,
											})}
											onClick={() => handleRemove(connection)}
											size="sm"
											variant="ghost"
										>
											<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
										</Button>
									</div>
								}
								description={
									<span className="type-caption flex min-w-0 flex-wrap gap-x-1.5 gap-y-0.5 font-mono">
										<span>
											{connection.username
												? `${connection.username}@${connection.host}`
												: connection.host}
											:{connection.port}
										</span>
										<span aria-hidden>·</span>
										<span>
											{connection.auth === "identity"
												? (connection.identityFile ?? "Identity file")
												: "Default SSH auth"}
										</span>
									</span>
								}
								key={connection.id}
								title={
									<RowTitle
										leading={<SettingsIconTile icon={Link01Icon} tint="gray" />}
										name={connection.name}
									/>
								}
							/>
						))}
					</SettingsGroup>
				) : (
					<SettingsCard>
						<p className="text-center text-muted-foreground text-sm">
							No SSH connections yet. Add a profile for a host you use from this
							device.
						</p>
					</SettingsCard>
				)}
			</SettingsSection>
			<SshConnectionDialog
				connection={editing}
				onOpenChange={setDialogOpen}
				onSave={handleSave}
				open={dialogOpen}
			/>
		</>
	);
}
