"use client";
import {
	ArrowDown01Icon,
	ComputerTerminal01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import { Label } from "@ryu/ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { Textarea } from "@ryu/ui/components/textarea";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { type ChangeEvent, useMemo, useState } from "react";
import styles from "./tools.module.css";
import type {
	AgentOption,
	McpCallArguments,
	McpToolRow,
	ToolCallResult,
} from "./tools-types.ts";

export function ToolRow({
	tool,
	agents,
	onCallTool,
}: {
	tool: McpToolRow;
	agents: AgentOption[];
	onCallTool?: (
		tool: string,
		agentId: string,
		args: McpCallArguments
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
		return isNativeText(result.output)
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
		let parsed: McpCallArguments;
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
				<CardTitle layout="badge-row" variant="section">
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
					<p
						className={cn(
							"text-muted-foreground text-sm",
							styles.toolDescription
						)}
						data-slot="card-description"
					>
						{tool.description}
					</p>
				) : null}
			</CardHeader>
			{open ? (
				<CardContent layout="stack">
					{agents.length === 0 ? (
						<p className="rounded bg-muted px-3 py-2 text-muted-foreground text-xs">
							Create an agent first, then come back here to try this tool. Tools
							always run as one of your agents.
						</p>
					) : (
						<>
							<div className="flex items-center gap-2">
								<Label htmlFor={`agent-${tool.id}`} size="compact" tone="muted">
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
								<Label htmlFor={`args-${tool.id}`} size="compact" tone="muted">
									Arguments (JSON)
								</Label>
								<Textarea
									id={`args-${tool.id}`}
									onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
										setArgsText(e.target.value)
									}
									rows={3}
									value={argsText}
									variant="code-caption"
								/>
							</div>
							{parseError ? (
								<p className="text-status-destructive text-xs">{parseError}</p>
							) : null}
							<div>
								<Button loading={running} onClick={runCall} size="sm">
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
									: "border-destructive/40 bg-destructive/10 text-status-destructive"
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
