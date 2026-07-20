"use client";

// Presentational layer of the desktop Tools page. The live app
// (`apps/desktop/src/pages/ToolsPage.tsx`) is a thin container that loads the
// MCP registry via `useMcp()` and renders this view with real handlers; the
// storyboard renders the same component with mock data and no-op handlers. One
// source of truth, so editing this block changes the real desktop too.
//
// Local UI state (the add-server dialog, each tool row's expand/args/result)
// stays inside this component — it is plain UI state, not app/backend/Tauri
// state. Everything that needs the backend (servers, tools, agents, calling a
// tool, creating a server) is passed in as props.

import {
	Add01Icon,
	ArrowDown01Icon,
	ComputerTerminal01Icon,
	ServerStack01Icon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ryu/ui/components/dialog";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { Spinner } from "@ryu/ui/components/spinner";
import { Textarea } from "@ryu/ui/components/textarea";
import { type ChangeEvent, useMemo, useState } from "react";

const ALL_AGENTS = "__all__";

export interface McpServerRow {
	args: string[];
	available?: boolean;
	command: string;
	description?: string | null;
	enabled: boolean;
	name: string;
}

export interface McpToolRow {
	description?: string | null;
	id: string;
	name: string;
	server: string;
}

export interface AgentOption {
	id: string;
	name: string;
}

export interface ToolCallResult {
	error?: string;
	ok: boolean;
	output?: unknown;
}

export interface CreateServerResult {
	error?: string;
	ok: boolean;
}

export interface CreateServerInput {
	args: string[];
	command: string;
	description?: string;
	name: string;
}

export interface ToolsViewProps {
	agentFilter?: string | null;
	agents: AgentOption[];
	error?: string | null;
	loading?: boolean;
	onAgentFilterChange?: (agentId: string | null) => void;
	onCallTool?: (
		tool: string,
		agentId: string,
		args: unknown
	) => Promise<ToolCallResult>;
	onCreateServer?: (input: CreateServerInput) => Promise<CreateServerResult>;
	onRetry?: () => void;
	servers: McpServerRow[];
	tools: McpToolRow[];
}

export function ToolsView({
	loading,
	error,
	servers,
	tools,
	agents,
	agentFilter = null,
	onAgentFilterChange,
	onCreateServer,
	onCallTool,
	onRetry,
}: ToolsViewProps) {
	if (loading) {
		return (
			<div className="flex h-full items-center justify-center">
				<Spinner />
			</div>
		);
	}

	if (error) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={Wrench01Icon} />
					</EmptyMedia>
					<EmptyTitle>Could not load tools</EmptyTitle>
					<EmptyDescription>
						Something went wrong while loading your tools. Check your connection
						and try again.
					</EmptyDescription>
				</EmptyHeader>
				{onRetry ? (
					<EmptyContent>
						<Button onClick={onRetry} size="sm" variant="outline">
							Try again
						</Button>
					</EmptyContent>
				) : null}
			</Empty>
		);
	}

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="flex shrink-0 items-center justify-end border-b px-4 py-3">
				<div className="flex items-center gap-2">
					<Label
						className="text-muted-foreground text-xs"
						htmlFor="agent-filter"
					>
						Allowlist
					</Label>
					<Select
						items={[
							{ value: ALL_AGENTS, label: "All tools" },
							...agents.map((a) => ({ value: a.id, label: a.name })),
						]}
						onValueChange={(v) =>
							onAgentFilterChange?.(!v || v === ALL_AGENTS ? null : v)
						}
						value={agentFilter ?? ALL_AGENTS}
					>
						<SelectTrigger className="w-44" id="agent-filter" size="sm">
							<SelectValue placeholder="All tools" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ALL_AGENTS}>All tools</SelectItem>
							{agents.map((agent) => (
								<SelectItem key={agent.id} value={agent.id}>
									{agent.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<AddServerDialog onCreateServer={onCreateServer} />
				</div>
			</div>

			<div className="scroll-fade-effect-y flex-1 overflow-auto p-4">
				<section className="mb-6">
					<h2 className="mb-2 flex items-center gap-2 font-medium text-sm">
						<HugeiconsIcon
							className="size-4 opacity-70"
							icon={ServerStack01Icon}
						/>
						Servers
						<Badge variant="secondary">{servers.length}</Badge>
					</h2>
					{servers.length === 0 ? (
						<Empty>
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<HugeiconsIcon icon={ServerStack01Icon} />
								</EmptyMedia>
								<EmptyTitle>No servers registered</EmptyTitle>
								<EmptyDescription>
									Add an MCP server to expose tools to your agents.
								</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : (
						<div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
							{servers.map((server) => (
								<Card key={server.name}>
									<CardHeader>
										<CardTitle className="flex items-center gap-2 text-base">
											{server.name}
										</CardTitle>
										<CardDescription className="flex flex-wrap gap-1">
											<Badge variant={server.enabled ? "default" : "secondary"}>
												{server.enabled ? "Enabled" : "Disabled"}
											</Badge>
											{server.available === false ? (
												<Badge variant="secondary">Not installed</Badge>
											) : null}
										</CardDescription>
									</CardHeader>
									<CardContent>
										<p className="line-clamp-2 text-muted-foreground text-sm">
											{server.description ?? "No description"}
										</p>
										<code className="mt-2 block truncate rounded bg-muted px-2 py-1 text-muted-foreground text-xs">
											{[server.command, ...server.args].join(" ")}
										</code>
									</CardContent>
								</Card>
							))}
						</div>
					)}
				</section>

				<section>
					<h2 className="mb-2 flex items-center gap-2 font-medium text-sm">
						<HugeiconsIcon className="size-4 opacity-70" icon={Wrench01Icon} />
						Tools
						<Badge variant="secondary">{tools.length}</Badge>
						{agentFilter ? (
							<span className="text-muted-foreground text-xs">
								filtered by allowlist
							</span>
						) : null}
					</h2>
					{tools.length === 0 ? (
						<Empty>
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<HugeiconsIcon icon={Wrench01Icon} />
								</EmptyMedia>
								<EmptyTitle>No tools</EmptyTitle>
								<EmptyDescription>
									{agentFilter
										? "This agent's allowlist exposes no tools."
										: "No MCP tools are registered yet."}
								</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : (
						<div className="flex flex-col gap-2">
							{tools.map((tool) => (
								<ToolRow
									agents={agents}
									key={tool.id}
									onCallTool={onCallTool}
									tool={tool}
								/>
							))}
						</div>
					)}
				</section>
			</div>
		</div>
	);
}

function AddServerDialog({
	onCreateServer,
}: {
	onCreateServer?: (input: CreateServerInput) => Promise<CreateServerResult>;
}) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [command, setCommand] = useState("");
	const [argsText, setArgsText] = useState("");
	const [description, setDescription] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);

	const reset = () => {
		setName("");
		setCommand("");
		setArgsText("");
		setDescription("");
		setFormError(null);
	};

	const handleSubmit = async () => {
		setFormError(null);

		const trimmedName = name.trim();
		const trimmedCommand = command.trim();

		if (!trimmedName) {
			setFormError("Name is required.");
			return;
		}
		if (trimmedName.includes("__")) {
			setFormError("Name must not contain '__' (reserved separator).");
			return;
		}
		if (!trimmedCommand) {
			setFormError("Command is required.");
			return;
		}

		const args = argsText
			.split(/\s+/)
			.map((s) => s.trim())
			.filter(Boolean);

		setSubmitting(true);
		try {
			const result = await onCreateServer?.({
				name: trimmedName,
				command: trimmedCommand,
				args,
				description: description.trim() || undefined,
			});
			if (result?.ok) {
				reset();
				setOpen(false);
			} else {
				setFormError(result?.error ?? "Failed to add server.");
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
			<DialogTrigger render={<Button size="sm" variant="ghost" />}>
				<HugeiconsIcon className="size-4" icon={Add01Icon} />
				Add server
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Add MCP server</DialogTitle>
					<DialogDescription>
						Register a new MCP server. The entry is saved to{" "}
						<code className="text-xs">~/.ryu/mcp.json</code> and takes effect
						immediately, no restart required.
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

					{formError ? (
						<p className="text-destructive text-sm">{formError}</p>
					) : null}
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
					<Button disabled={submitting} onClick={handleSubmit} type="button">
						{submitting ? <Spinner className="size-4" /> : null}
						Add server
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function ToolRow({
	tool,
	agents,
	onCallTool,
}: {
	tool: McpToolRow;
	agents: AgentOption[];
	onCallTool?: (
		tool: string,
		agentId: string,
		args: unknown
	) => Promise<ToolCallResult>;
}) {
	const [open, setOpen] = useState(false);
	const [argsText, setArgsText] = useState("{}");
	const [agentId, setAgentId] = useState<string>(() => agents[0]?.id ?? "");
	const [running, setRunning] = useState(false);
	const [result, setResult] = useState<ToolCallResult | null>(null);
	const [parseError, setParseError] = useState<string | null>(null);

	const resultText = useMemo(() => {
		if (!result) {
			return null;
		}
		if (!result.ok) {
			return result.error ?? "Tool call failed";
		}
		return typeof result.output === "string"
			? result.output
			: JSON.stringify(result.output, null, 2);
	}, [result]);

	const runCall = async () => {
		setParseError(null);
		setResult(null);
		if (!agentId) {
			setParseError("Choose an agent to run this tool as.");
			return;
		}
		let parsed: unknown;
		try {
			parsed = argsText.trim() ? JSON.parse(argsText) : {};
		} catch {
			setParseError("Arguments must be valid JSON.");
			return;
		}
		setRunning(true);
		try {
			const res = await onCallTool?.(tool.id, agentId, parsed);
			setResult(res ?? { ok: false, error: "No handler" });
		} catch (e) {
			setResult({
				ok: false,
				error: e instanceof Error ? e.message : "Tool call failed",
			});
		} finally {
			setRunning(false);
		}
	};

	return (
		<Card>
			<CardHeader
				aria-expanded={open}
				className="cursor-pointer"
				onClick={() => setOpen((o) => !o)}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						setOpen((o) => !o);
					}
				}}
				role="button"
				tabIndex={0}
			>
				<CardTitle className="flex items-center gap-2 text-sm">
					<HugeiconsIcon
						className="size-4 opacity-70"
						icon={ComputerTerminal01Icon}
					/>
					{tool.name}
					<Badge variant="secondary">{tool.server}</Badge>
					<HugeiconsIcon
						className={`ml-auto size-4 opacity-70 transition-transform ${
							open ? "rotate-180" : ""
						}`}
						icon={ArrowDown01Icon}
					/>
				</CardTitle>
				{tool.description ? (
					<CardDescription className="line-clamp-1">
						{tool.description}
					</CardDescription>
				) : null}
			</CardHeader>
			{open ? (
				<CardContent className="flex flex-col gap-3">
					{agents.length === 0 ? (
						<p className="rounded bg-muted px-3 py-2 text-muted-foreground text-xs">
							Create an agent first, then come back here to try this tool. Tools
							always run as one of your agents.
						</p>
					) : (
						<>
							<div className="flex items-center gap-2">
								<Label
									className="text-muted-foreground text-xs"
									htmlFor={`agent-${tool.id}`}
								>
									Run as
								</Label>
								<Select
									items={agents.map((a) => ({ value: a.id, label: a.name }))}
									onValueChange={(value) => setAgentId(value ?? "")}
									value={agentId}
								>
									<SelectTrigger
										className="w-48"
										id={`agent-${tool.id}`}
										size="sm"
									>
										<SelectValue placeholder="Select an agent" />
									</SelectTrigger>
									<SelectContent>
										{agents.map((agent) => (
											<SelectItem key={agent.id} value={agent.id}>
												{agent.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<div className="flex flex-col gap-1">
								<Label
									className="text-muted-foreground text-xs"
									htmlFor={`args-${tool.id}`}
								>
									Arguments (JSON)
								</Label>
								<Textarea
									className="font-mono text-xs"
									id={`args-${tool.id}`}
									onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
										setArgsText(e.target.value)
									}
									rows={3}
									value={argsText}
								/>
							</div>
							{parseError ? (
								<p className="text-destructive text-xs">{parseError}</p>
							) : null}
							<div>
								<Button disabled={running} onClick={runCall} size="sm">
									{running ? <Spinner className="size-4" /> : null}
									Test call
								</Button>
							</div>
						</>
					)}
					{resultText === null ? null : (
						<pre
							className={`max-h-60 overflow-auto rounded border px-3 py-2 text-xs ${
								result?.ok
									? "bg-muted"
									: "border-destructive/40 bg-destructive/10 text-destructive"
							}`}
						>
							{resultText}
						</pre>
					)}
				</CardContent>
			) : null}
		</Card>
	);
}
