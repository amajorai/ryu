import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
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
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { type ChangeEvent, useState } from "react";
import { z } from "zod";
import { ErrorLine } from "@/src/components/agents/shared/error-line.tsx";
import type {
	CreateMcpServerInput,
	CreateMcpServerResult,
	McpTransport,
} from "@/src/lib/api/mcp.ts";
import {
	type McpKeyValueRow,
	McpKeyValueRows,
} from "./ToolsLibrary-key-value-rows.tsx";

export function AddServerDialog({
	onCreateServer,
}: {
	onCreateServer: (
		input: CreateMcpServerInput
	) => Promise<CreateMcpServerResult>;
}) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [transport, setTransport] = useState<McpTransport>("stdio");
	const [command, setCommand] = useState("");
	const [url, setUrl] = useState("");
	const [argsText, setArgsText] = useState("");
	const [headersText, setHeadersText] = useState("");
	const [envRows, setEnvRows] = useState<McpKeyValueRow[]>([]);
	const [description, setDescription] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);

	const reset = () => {
		setName("");
		setTransport("stdio");
		setCommand("");
		setUrl("");
		setArgsText("");
		setHeadersText("");
		setEnvRows([]);
		setDescription("");
		setFormError(null);
	};

	const updateRow = (
		index: number,
		field: keyof McpKeyValueRow,
		value: string
	) => {
		setEnvRows((rows) =>
			rows.map((row, rowIndex) =>
				rowIndex === index ? { ...row, [field]: value } : row
			)
		);
	};

	const handleSubmit = async () => {
		setFormError(null);

		const trimmedName = name.trim();
		const trimmedCommand = command.trim();
		const trimmedUrl = url.trim();

		if (!trimmedName) {
			setFormError("Name is required.");
			return;
		}
		if (trimmedName.includes("__")) {
			setFormError("Name must not contain '__' (reserved legacy separator).");
			return;
		}
		if (transport === "stdio") {
			if (!trimmedCommand) {
				setFormError("Command is required for stdio servers.");
				return;
			}
		} else {
			if (!trimmedUrl) {
				setFormError("Endpoint URL is required for remote servers.");
				return;
			}
			try {
				const parsed = new URL(trimmedUrl);
				if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
					setFormError("Endpoint URL must use http:// or https://.");
					return;
				}
			} catch {
				setFormError("Endpoint URL is not valid.");
				return;
			}
		}

		const headers: Record<string, string> = {};
		if (transport !== "stdio" && headersText.trim()) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(headersText);
			} catch {
				setFormError("Headers must be valid JSON.");
				return;
			}
			const decoded = z
				.record(
					z.string().refine((key) => Boolean(key.trim())),
					z.string()
				)
				.safeParse(parsed);
			if (!decoded.success) {
				setFormError("Headers must be a JSON object of string values.");
				return;
			}
			const headerObject = decoded.data;
			for (const key of Object.keys(headerObject)) {
				const value = headerObject[key];
				if (!(key.trim() && isNativeText(value))) {
					setFormError("Headers must be a JSON object of string values.");
					return;
				}
				headers[key] = value;
			}
		}

		const args = argsText
			.split(/\s+/)
			.map((s) => s.trim())
			.filter(Boolean);
		const env = envRows.reduce<Record<string, string>>((result, row) => {
			const key = row.key.trim();
			if (key) {
				result[key] = row.value;
			}
			return result;
		}, {});

		setSubmitting(true);
		try {
			const result = await onCreateServer({
				name: trimmedName,
				transport,
				...(transport === "stdio"
					? { command: trimmedCommand, args }
					: { url: trimmedUrl, headers }),
				env,
				description: description.trim() || undefined,
			});
			if (result.ok) {
				reset();
				setOpen(false);
			} else {
				setFormError(result.error ?? "Failed to add server.");
			}
		} catch (e) {
			setFormError(e instanceof Error ? e.message : "Failed to add server.");
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Dialog
			onOpenChange={(v) => {
				setOpen(v);
				if (!v) {
					reset();
				}
			}}
			open={open}
		>
			<DialogTrigger render={<Button className="w-full" size="sm" />}>
				<HugeiconsIcon className="size-4" icon={Add01Icon} />
				Add server
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Add MCP server</DialogTitle>
					<DialogDescription>
						Register a new MCP server. The entry is saved to{" "}
						<code className="text-xs">~/.ryu/state/mcp.json</code> and takes
						effect immediately, no restart required.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-4 py-2">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="mcp-name">Name</Label>
						<Input
							id="mcp-name"
							onChange={(e: ChangeEvent<HTMLInputElement>) =>
								setName(e.target.value)
							}
							placeholder="e.g. filesystem"
							value={name}
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="mcp-transport">Transport</Label>
						<Select<McpTransport>
							onValueChange={(value) => {
								if (value) {
									setTransport(value);
								}
							}}
							value={transport}
						>
							<SelectTrigger id="mcp-transport">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="stdio">Local process (stdio)</SelectItem>
								<SelectItem value="streamable-http">Streamable HTTP</SelectItem>
								<SelectItem value="sse">Legacy HTTP + SSE</SelectItem>
							</SelectContent>
						</Select>
						<p className="text-muted-foreground text-xs">
							{transport === "stdio"
								? "Spawn a local MCP process."
								: transport === "sse"
									? "Connect to the legacy SSE endpoint and its announced POST route."
									: "Connect to a current MCP Streamable HTTP endpoint."}
						</p>
					</div>

					{transport === "stdio" ? (
						<>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="mcp-command">Command</Label>
								<Input
									id="mcp-command"
									onChange={(e: ChangeEvent<HTMLInputElement>) =>
										setCommand(e.target.value)
									}
									placeholder="e.g. npx"
									value={command}
								/>
							</div>

							<div className="flex flex-col gap-1.5">
								<Label htmlFor="mcp-args">
									Arguments{" "}
									<span className="text-muted-foreground text-xs">
										(space-separated)
									</span>
								</Label>
								<Input
									id="mcp-args"
									onChange={(e: ChangeEvent<HTMLInputElement>) =>
										setArgsText(e.target.value)
									}
									placeholder="e.g. -y @modelcontextprotocol/server-filesystem /tmp"
									value={argsText}
								/>
							</div>
						</>
					) : (
						<>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="mcp-url">Endpoint URL</Label>
								<Input
									id="mcp-url"
									onChange={(e: ChangeEvent<HTMLInputElement>) =>
										setUrl(e.target.value)
									}
									placeholder="https://example.com/mcp"
									value={url}
								/>
							</div>

							<div className="flex flex-col gap-1.5">
								<Label htmlFor="mcp-headers">
									Headers{" "}
									<span className="text-muted-foreground text-xs">
										(optional JSON)
									</span>
								</Label>
								<Textarea
									id="mcp-headers"
									onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
										setHeadersText(e.target.value)
									}
									placeholder={'{"Authorization":"Bearer …"}'}
									rows={2}
									value={headersText}
								/>
							</div>
						</>
					)}

					<McpKeyValueRows
						label="Environment variables"
						onChange={(index, field, value) => updateRow(index, field, value)}
						onRemove={(index) =>
							setEnvRows((rows) =>
								rows.filter((_, rowIndex) => rowIndex !== index)
							)
						}
						rows={envRows}
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

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="mcp-description">
							Description{" "}
							<span className="text-muted-foreground text-xs">(optional)</span>
						</Label>
						<Textarea
							id="mcp-description"
							onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
								setDescription(e.target.value)
							}
							placeholder="What does this server do?"
							rows={2}
							value={description}
						/>
					</div>

					{formError ? <ErrorLine message={formError} /> : null}
				</div>

				<DialogFooter>
					<Button
						disabled={submitting}
						onClick={() => {
							setOpen(false);
							reset();
						}}
						type="button"
						variant="ghost"
					>
						Cancel
					</Button>
					<Button loading={submitting} onClick={handleSubmit} type="button">
						Add server
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
