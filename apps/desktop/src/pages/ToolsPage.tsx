// The Store's "Tools" section — the MCP servers registered on the active node and
// the tools they expose. Reshaped onto the shared App Store layout
// (StoreCatalogLayout): a centered 2-column card grid of servers + tools on the
// left, a preview aside on the right that carries the server details or the tool's
// test-call form. The agent allowlist filter and "Add server" live in the toolbar
// filter popover.
//
// This is the desktop presentation. The @ryu/blocks `ToolsView` (used by the
// storyboard) is intentionally NOT reused here: store-catalog-layout imports from
// @ryu/blocks, so a blocks→marketplace dependency would be circular. The trade-off
// is that this desktop view no longer shares its markup with the storyboard block.

import {
	Add01Icon,
	ComputerTerminal01Icon,
	ServerStack01Icon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import StoreCatalogCard from "@ryu/marketplace/catalog/chrome/store-catalog-card";
import StoreCatalogLayout, {
	StoreCardGrid,
} from "@ryu/marketplace/catalog/chrome/store-catalog-layout";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
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
import { useMcp } from "@/src/hooks/useMcp.ts";
import type {
	CreateMcpServerInput,
	CreateMcpServerResult,
	McpCallResult,
	McpServer,
	McpTool,
} from "@/src/lib/api/mcp.ts";

const ALL_AGENTS = "__all__";

export default function ToolsPage() {
	const {
		servers,
		tools,
		agents,
		agentFilter,
		setAgentFilter,
		loading,
		error,
		callTool,
		createServer,
		reload,
	} = useMcp();

	const [query, setQuery] = useState("");
	// Selection id is namespaced: `server:<name>` or `tool:<id>`.
	const [selectedId, setSelectedId] = useState<string | null>(null);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		const matchServer = (s: McpServer) =>
			!q ||
			s.name.toLowerCase().includes(q) ||
			(s.description ?? "").toLowerCase().includes(q);
		const matchTool = (t: McpTool) =>
			!q ||
			t.name.toLowerCase().includes(q) ||
			t.server.toLowerCase().includes(q) ||
			(t.description ?? "").toLowerCase().includes(q);
		return {
			servers: servers.filter(matchServer),
			tools: tools.filter(matchTool),
		};
	}, [servers, tools, query]);

	const selectedServer =
		selectedId?.startsWith("server:") === true
			? (servers.find((s) => `server:${s.name}` === selectedId) ?? null)
			: null;
	const selectedTool =
		selectedId?.startsWith("tool:") === true
			? (tools.find((t) => `tool:${t.id}` === selectedId) ?? null)
			: null;

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
				<EmptyContent>
					<Button
						onClick={() => reload().catch(() => undefined)}
						size="sm"
						variant="outline"
					>
						Try again
					</Button>
				</EmptyContent>
			</Empty>
		);
	}

	return (
		<StoreCatalogLayout
			detail={
				selectedServer ? (
					<ServerDetail server={selectedServer} />
				) : selectedTool ? (
					<ToolDetail
						agents={agents}
						onCallTool={callTool}
						tool={selectedTool}
					/>
				) : null
			}
			detailTitle={selectedServer?.name ?? selectedTool?.name ?? "Tool"}
			filter={{
				label: "Filter & add",
				panel: (
					<div className="flex flex-col gap-4 p-4">
						<div className="flex flex-col gap-1.5">
							<Label
								className="font-medium text-muted-foreground text-xs"
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
									setAgentFilter(!v || v === ALL_AGENTS ? null : v)
								}
								value={agentFilter ?? ALL_AGENTS}
							>
								<SelectTrigger className="w-full" id="agent-filter" size="sm">
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
						</div>
						<AddServerDialog onCreateServer={createServer} />
					</div>
				),
			}}
			hasSelection={selectedServer != null || selectedTool != null}
			list={
				<div className="flex flex-col gap-6 pt-2">
					<section>
						<h3 className="mb-2 flex items-center gap-2 px-1 font-medium text-muted-foreground text-xs uppercase tracking-widest">
							<HugeiconsIcon className="size-3.5" icon={ServerStack01Icon} />
							Servers
							<Badge variant="secondary">{filtered.servers.length}</Badge>
						</h3>
						{filtered.servers.length === 0 ? (
							<p className="px-1 text-muted-foreground text-sm">
								No servers registered. Use “Add server” to expose tools to your
								agents.
							</p>
						) : (
							<StoreCardGrid>
								{filtered.servers.map((server) => (
									<StoreCatalogCard
										action={
											<div className="flex items-center gap-1">
												<Badge
													variant={server.enabled ? "default" : "secondary"}
												>
													{server.enabled ? "Enabled" : "Disabled"}
												</Badge>
												{server.available === false ? (
													<Badge variant="secondary">Off</Badge>
												) : null}
											</div>
										}
										description={server.description ?? "No description"}
										icon={
											<HugeiconsIcon
												className="size-5"
												icon={ServerStack01Icon}
											/>
										}
										key={server.name}
										name={server.name}
										onClick={() => setSelectedId(`server:${server.name}`)}
										seedId={server.name}
										selected={selectedId === `server:${server.name}`}
									/>
								))}
							</StoreCardGrid>
						)}
					</section>

					<section>
						<h3 className="mb-2 flex items-center gap-2 px-1 font-medium text-muted-foreground text-xs uppercase tracking-widest">
							<HugeiconsIcon className="size-3.5" icon={Wrench01Icon} />
							Tools
							<Badge variant="secondary">{filtered.tools.length}</Badge>
							{agentFilter ? (
								<span className="normal-case tracking-normal">
									filtered by allowlist
								</span>
							) : null}
						</h3>
						{filtered.tools.length === 0 ? (
							<p className="px-1 text-muted-foreground text-sm">
								{agentFilter
									? "This agent's allowlist exposes no tools."
									: "No MCP tools are registered yet."}
							</p>
						) : (
							<StoreCardGrid>
								{filtered.tools.map((tool) => (
									<StoreCatalogCard
										action={<Badge variant="secondary">{tool.server}</Badge>}
										description={tool.description ?? "No description"}
										icon={
											<HugeiconsIcon
												className="size-5"
												icon={ComputerTerminal01Icon}
											/>
										}
										key={tool.id}
										name={tool.name}
										onClick={() => setSelectedId(`tool:${tool.id}`)}
										seedId={tool.id}
										selected={selectedId === `tool:${tool.id}`}
									/>
								))}
							</StoreCardGrid>
						)}
					</section>
				</div>
			}
			onCloseDetail={() => setSelectedId(null)}
			search={{
				value: query,
				onChange: setQuery,
				placeholder: "Search servers and tools…",
			}}
		/>
	);
}

function ServerDetail({ server }: { server: McpServer }) {
	return (
		<div className="flex flex-col gap-6 p-4">
			<header className="flex flex-col gap-3">
				<div className="pr-8">
					<h2 className="truncate font-semibold text-xl">{server.name}</h2>
					<p className="text-muted-foreground text-sm">MCP server</p>
				</div>
				<div className="flex flex-wrap items-center gap-1">
					<Badge variant={server.enabled ? "default" : "secondary"}>
						{server.enabled ? "Enabled" : "Disabled"}
					</Badge>
					{server.available === false ? (
						<Badge variant="secondary">Not installed</Badge>
					) : null}
				</div>
			</header>

			<section className="flex flex-col gap-2">
				<h3 className="font-medium text-sm">About</h3>
				<p className="text-muted-foreground text-sm leading-relaxed">
					{server.description ?? "No description provided."}
				</p>
			</section>

			<section className="flex flex-col gap-2">
				<h3 className="font-medium text-sm">Command</h3>
				<code className="block truncate rounded bg-muted px-2 py-1 text-muted-foreground text-xs">
					{[server.command, ...server.args].join(" ")}
				</code>
			</section>
		</div>
	);
}

function ToolDetail({
	tool,
	agents,
	onCallTool,
}: {
	tool: McpTool;
	agents: { id: string; name: string }[];
	onCallTool: (
		tool: string,
		agentId: string,
		args: unknown
	) => Promise<McpCallResult>;
}) {
	const [argsText, setArgsText] = useState("{}");
	const [agentId, setAgentId] = useState<string>(() => agents[0]?.id ?? "");
	const [running, setRunning] = useState(false);
	const [result, setResult] = useState<McpCallResult | null>(null);
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
			const res = await onCallTool(tool.id, agentId, parsed);
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
		<div className="flex flex-col gap-6 p-4">
			<header className="flex flex-col gap-3">
				<div className="pr-8">
					<h2 className="truncate font-semibold text-xl">{tool.name}</h2>
					<p className="text-muted-foreground text-sm">{tool.server}</p>
				</div>
				{tool.description ? (
					<p className="text-muted-foreground text-sm leading-relaxed">
						{tool.description}
					</p>
				) : null}
			</header>

			<section className="flex flex-col gap-3">
				<h3 className="font-medium text-sm">Test call</h3>
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
			</section>
		</div>
	);
}

function AddServerDialog({
	onCreateServer,
}: {
	onCreateServer: (
		input: CreateMcpServerInput
	) => Promise<CreateMcpServerResult>;
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
			const result = await onCreateServer({
				name: trimmedName,
				command: trimmedCommand,
				args,
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
