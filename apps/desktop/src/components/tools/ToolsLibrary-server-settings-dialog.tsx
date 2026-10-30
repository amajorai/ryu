import { Add01Icon, Delete01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@ryu/ui/components/alert-dialog.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import {
	type ChangeEvent,
	type Dispatch,
	type SetStateAction,
	useState,
} from "react";
import { ErrorLine } from "@/src/components/agents/shared/error-line.tsx";
import type {
	McpServer,
	McpTransport,
	UpdateMcpServerInput,
} from "@/src/lib/api/mcp.ts";
import {
	type McpKeyValueRow,
	McpKeyValueRows,
} from "./ToolsLibrary-key-value-rows.tsx";

export function McpServerSettingsDialog({
	deleteServer,
	onUpdateServer,
	server,
}: {
	deleteServer: (name: string) => Promise<{ error?: string; ok: boolean }>;
	onUpdateServer: (
		name: string,
		input: UpdateMcpServerInput
	) => Promise<{ error?: string; ok: boolean; server?: McpServer }>;
	server: McpServer;
}) {
	const tl = useLiteralMessages();
	const [open, setOpen] = useState(false);
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [command, setCommand] = useState("");
	const [url, setUrl] = useState("");
	const [transport, setTransport] = useState<McpTransport>("stdio");
	const [argsText, setArgsText] = useState("");
	const [description, setDescription] = useState("");
	const [enabled, setEnabled] = useState(true);
	const [envRows, setEnvRows] = useState<McpKeyValueRow[]>([]);
	const [headerRows, setHeaderRows] = useState<McpKeyValueRow[]>([]);
	const [submitting, setSubmitting] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);

	const resetFromServer = () => {
		const nextTransport =
			server.transport === "sse"
				? "sse"
				: server.transport === "streamable-http" || server.url
					? "streamable-http"
					: "stdio";
		setTransport(nextTransport);
		setCommand(server.url ? "" : server.command);
		setUrl(server.url ?? "");
		setArgsText(server.args.join(" "));
		setDescription(server.description ?? "");
		setEnabled(server.enabled);
		setEnvRows(server.envKeys.map((key) => ({ key, value: "••••••" })));
		setHeaderRows(server.headerNames.map((key) => ({ key, value: "••••••" })));
		setFormError(null);
	};

	const mapRows = (rows: McpKeyValueRow[]) =>
		rows.reduce<Record<string, string>>((result, row) => {
			const key = row.key.trim();
			if (key) {
				result[key] = row.value;
			}
			return result;
		}, {});

	const handleSubmit = async () => {
		setFormError(null);
		if (transport === "stdio" && !command.trim()) {
			setFormError("Command is required for stdio servers.");
			return;
		}
		if (transport !== "stdio") {
			if (!url.trim()) {
				setFormError("Endpoint URL is required for remote servers.");
				return;
			}
			try {
				const parsed = new URL(url.trim());
				if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
					setFormError("Endpoint URL must use http:// or https://.");
					return;
				}
			} catch {
				setFormError("Endpoint URL is not valid.");
				return;
			}
		}

		setSubmitting(true);
		try {
			const result = await onUpdateServer(server.name, {
				args: argsText
					.split(/\s+/)
					.map((value) => value.trim())
					.filter(Boolean),
				command: transport === "stdio" ? command.trim() : undefined,
				description: description.trim(),
				enabled,
				env: mapRows(envRows),
				headers: mapRows(headerRows),
				transport,
				url: transport === "stdio" ? undefined : url.trim(),
			});
			if (!result.ok) {
				setFormError(result.error ?? "Failed to save server settings.");
				return;
			}
			toast.success("MCP server settings saved");
			setOpen(false);
		} catch (error) {
			setFormError(
				error instanceof Error
					? error.message
					: "Failed to save server settings."
			);
		} finally {
			setSubmitting(false);
		}
	};

	const handleDelete = async () => {
		setDeleting(true);
		try {
			const result = await deleteServer(server.name);
			if (!result.ok) {
				setFormError(result.error ?? "Failed to remove server.");
				return;
			}
			toast.success("MCP server removed");
			setDeleteOpen(false);
			setOpen(false);
		} catch (error) {
			setFormError(
				error instanceof Error ? error.message : "Failed to remove server."
			);
		} finally {
			setDeleting(false);
		}
	};

	const updateRow = (
		setter: Dispatch<SetStateAction<McpKeyValueRow[]>>,
		index: number,
		field: keyof McpKeyValueRow,
		value: string
	) => {
		setter((current) =>
			current.map((row, rowIndex) =>
				rowIndex === index ? { ...row, [field]: value } : row
			)
		);
	};

	return (
		<Dialog
			onOpenChange={(value) => {
				setOpen(value);
				if (value) {
					resetFromServer();
				}
			}}
			open={open}
		>
			<DialogTrigger
				render={<Button className="w-fit" size="sm" variant="outline" />}
			>
				Settings
			</DialogTrigger>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>
						{tl("Configure {name}", { name: server.name })}
					</DialogTitle>
					<DialogDescription>
						Values stay on the node. Leave masked secrets unchanged to keep
						them.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-4 py-2">
					<div className="flex min-h-12 items-center justify-between gap-6 border-border border-b py-3">
						<label className="min-w-0" htmlFor="mcp-settings-enabled">
							<span className="block text-sm">Server enabled</span>
							<span className="block text-detail text-muted-foreground">
								Disabled servers do not advertise tools to agents.
							</span>
						</label>
						<Switch
							checked={enabled}
							id="mcp-settings-enabled"
							onCheckedChange={(checked) => setEnabled(checked === true)}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="mcp-settings-transport">Transport</Label>
						<Select<McpTransport>
							onValueChange={(value) => {
								if (value) {
									setTransport(value);
								}
							}}
							value={transport}
						>
							<SelectTrigger id="mcp-settings-transport">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="stdio">Local process (stdio)</SelectItem>
								<SelectItem value="streamable-http">Streamable HTTP</SelectItem>
								<SelectItem value="sse">Legacy HTTP + SSE</SelectItem>
							</SelectContent>
						</Select>
					</div>
					{transport === "stdio" ? (
						<>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="mcp-settings-command">Command</Label>
								<Input
									id="mcp-settings-command"
									onChange={(event: ChangeEvent<HTMLInputElement>) =>
										setCommand(event.target.value)
									}
									value={command}
								/>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="mcp-settings-args">Arguments</Label>
								<Input
									id="mcp-settings-args"
									onChange={(event: ChangeEvent<HTMLInputElement>) =>
										setArgsText(event.target.value)
									}
									value={argsText}
								/>
							</div>
						</>
					) : (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="mcp-settings-url">Endpoint URL</Label>
							<Input
								id="mcp-settings-url"
								onChange={(event: ChangeEvent<HTMLInputElement>) =>
									setUrl(event.target.value)
								}
								value={url}
							/>
						</div>
					)}
					<McpKeyValueRows
						label="Environment variables"
						onChange={(index, field, value) =>
							updateRow(setEnvRows, index, field, value)
						}
						onRemove={(index) =>
							setEnvRows((rows) =>
								rows.filter((_, rowIndex) => rowIndex !== index)
							)
						}
						rows={envRows}
						secret
					/>
					<Button
						onClick={() =>
							setEnvRows((rows) => [...rows, { key: "", value: "" }])
						}
						size="sm"
						variant="outline"
					>
						<HugeiconsIcon className="size-4" icon={Add01Icon} />
						Add environment variable
					</Button>
					{transport === "stdio" ? null : (
						<>
							<McpKeyValueRows
								label="Request headers"
								onChange={(index, field, value) =>
									updateRow(setHeaderRows, index, field, value)
								}
								onRemove={(index) =>
									setHeaderRows((rows) =>
										rows.filter((_, rowIndex) => rowIndex !== index)
									)
								}
								rows={headerRows}
								secret
							/>
							<Button
								onClick={() =>
									setHeaderRows((rows) => [...rows, { key: "", value: "" }])
								}
								size="sm"
								variant="outline"
							>
								<HugeiconsIcon className="size-4" icon={Add01Icon} />
								Add request header
							</Button>
						</>
					)}
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="mcp-settings-description">Description</Label>
						<Textarea
							id="mcp-settings-description"
							onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
								setDescription(event.target.value)
							}
							rows={2}
							value={description}
						/>
					</div>
					{formError ? <ErrorLine message={formError} /> : null}
				</div>
				<DialogFooter className="justify-between sm:justify-between">
					<AlertDialog onOpenChange={setDeleteOpen} open={deleteOpen}>
						<AlertDialogTrigger
							render={
								<Button className="text-status-destructive" variant="ghost">
									<HugeiconsIcon className="size-4" icon={Delete01Icon} />
									Remove server
								</Button>
							}
						/>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>
									{tl("Remove {name}?", { name: server.name })}
								</AlertDialogTitle>
								<AlertDialogDescription>
									This removes the server configuration from the Core node. It
									does not delete an installed package.
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>Cancel</AlertDialogCancel>
								<AlertDialogAction
									disabled={deleting}
									onClick={handleDelete}
									variant="destructive"
								>
									Remove server
								</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
					<div className="flex gap-2">
						<Button onClick={() => setOpen(false)} variant="ghost">
							Cancel
						</Button>
						<Button loading={submitting} onClick={handleSubmit} variant="mono">
							Save changes
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
