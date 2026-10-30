import { Wrench01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ListingAsideCard,
	ListingDetailShell,
	ListingHero,
	ListingInfoGrid,
	ListingSection,
	ListingStatStrip,
} from "@ryu/marketplace/catalog/detail/listing-detail-shell";
import { Button } from "@ryu/ui/components/button.tsx";
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
import { type ChangeEvent, useMemo, useState } from "react";
import { ErrorLine } from "@/src/components/agents/shared/error-line.tsx";
import type { useMcp } from "@/src/hooks/useMcp.ts";
import type { McpCallResult, McpTool } from "@/src/lib/api/mcp.ts";

export function ToolDetail({
	tool,
	agents,
	onCallTool,
}: {
	tool: McpTool;
	agents: { id: string; name: string }[];
	onCallTool: ReturnType<typeof useMcp>["callTool"];
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
		<ListingDetailShell
			aside={
				<ListingAsideCard title="Information">
					<ListingInfoGrid
						rows={[
							{ label: "Tool ID", value: tool.id },
							{ label: "Server", value: tool.server },
						]}
					/>
				</ListingAsideCard>
			}
			hero={
				<ListingHero
					badges={[tool.server]}
					icon={<HugeiconsIcon className="size-8" icon={Wrench01Icon} />}
					name={tool.name}
					tagline={tool.description}
				/>
			}
			stats={
				<ListingStatStrip
					items={[
						{ label: "Server", value: tool.server },
						{ label: "Runs as", value: agents.length > 0 ? "Agent" : "—" },
					]}
				/>
			}
		>
			<ListingSection title="Test call">
				{agents.length === 0 ? (
					<p className="text-detail text-muted-foreground">
						Tools run as one of your agents. Create an agent to try this one.
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
						{parseError ? <ErrorLine message={parseError} /> : null}
						<div>
							<Button
								loading={running}
								onClick={runCall}
								size="sm"
								variant="outline"
							>
								Test call
							</Button>
						</div>
					</>
				)}
				{resultText === null ? null : (
					<pre
						className={`max-h-60 overflow-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs ${
							result?.ok ? "" : "text-status-destructive"
						}`}
					>
						{resultText}
					</pre>
				)}
			</ListingSection>
		</ListingDetailShell>
	);
}
