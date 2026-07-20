// Full "Add widget" picker: choose any of the 10 widget kinds and configure any
// of the 7 data sources from the UI (parity with what the AI builder can create).
// Uses the shared shadcn Select/Input/Textarea so the picker matches the rest of
// the app. The Base UI Select needs an `items` prop for SelectValue to render the
// selected label, and onValueChange is typed `(value: string | null)`.

import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { Textarea } from "@ryu/ui/components/textarea";
import { useMemo, useState } from "react";
import type {
	WidgetInput,
	WidgetKind,
	WidgetSource,
} from "@/src/lib/api/dashboard.ts";
import { WIDGET_DEFINITIONS } from "./widgets/registry.tsx";

// Picker options and default sizes come from the widget catalog, so a new kind
// shows up here (and gets a sensible size) without editing this file.
const KIND_OPTIONS: Array<{ value: WidgetKind; label: string }> =
	WIDGET_DEFINITIONS.map((d) => ({ value: d.kind, label: d.label }));

type SourceType = WidgetSource["type"];

const SOURCE_OPTIONS: Array<{ value: SourceType; label: string }> = [
	{ value: "core_endpoint", label: "Core metric (built-in)" },
	{ value: "monitor", label: "Website monitor" },
	{ value: "workflow", label: "Workflow output" },
	{ value: "composio", label: "Composio action" },
	{ value: "http", label: "External HTTP (https)" },
	{ value: "agent", label: "Agent (re-runs on interval)" },
	{ value: "static", label: "Static / inline data" },
];

/** Default grid size per kind, so a new widget looks right immediately. */
const DEFAULT_SIZE = Object.fromEntries(
	WIDGET_DEFINITIONS.map((d) => [d.kind, d.defaultSize])
) as Record<WidgetKind, { w: number; h: number }>;

function parseJsonOr<T>(text: string, fallback: T): T {
	const trimmed = text.trim();
	if (!trimmed) {
		return fallback;
	}
	try {
		return JSON.parse(trimmed) as T;
	} catch {
		return fallback;
	}
}

export function AddWidgetDialog({
	open,
	onOpenChange,
	coreEndpoints,
	onCreate,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Allowed core_endpoint names from the catalog. */
	coreEndpoints: string[];
	onCreate: (input: WidgetInput) => void | Promise<void>;
}) {
	const [kind, setKind] = useState<WidgetKind>("stat");
	const [title, setTitle] = useState("");
	const [sourceType, setSourceType] = useState<SourceType>("core_endpoint");
	const [refreshInterval, setRefreshInterval] = useState("30s");
	const [configJson, setConfigJson] = useState("");

	// Per-source fields (only the active source's fields are read on submit).
	const [endpoint, setEndpoint] = useState(coreEndpoints[0] ?? "connections");
	const [selector, setSelector] = useState("");
	const [monitorId, setMonitorId] = useState("");
	const [workflowId, setWorkflowId] = useState("");
	const [outputKey, setOutputKey] = useState("");
	const [composioAction, setComposioAction] = useState("");
	const [composioArgs, setComposioArgs] = useState("");
	const [httpUrl, setHttpUrl] = useState("https://");
	const [agentId, setAgentId] = useState("");
	const [agentPrompt, setAgentPrompt] = useState("");
	const [staticData, setStaticData] = useState("");

	const endpointItems = useMemo(
		() => coreEndpoints.map((e) => ({ value: e, label: e })),
		[coreEndpoints]
	);

	const buildSource = (): WidgetSource => {
		switch (sourceType) {
			case "core_endpoint":
				return {
					type: "core_endpoint",
					endpoint,
					selector: selector.trim() || null,
				};
			case "monitor":
				return { type: "monitor", monitor_id: monitorId.trim() };
			case "workflow":
				return {
					type: "workflow",
					workflow_id: workflowId.trim(),
					output_key: outputKey.trim() || null,
				};
			case "composio":
				return {
					type: "composio",
					action: composioAction.trim(),
					args: parseJsonOr(composioArgs, {}),
				};
			case "http":
				return {
					type: "http",
					url: httpUrl.trim(),
					selector: selector.trim() || null,
				};
			case "agent":
				return {
					type: "agent",
					agent_id: agentId.trim(),
					prompt: agentPrompt.trim(),
				};
			default:
				return { type: "static", data: parseJsonOr(staticData, null) };
		}
	};

	const handleSubmit = async () => {
		const size = DEFAULT_SIZE[kind];
		await onCreate({
			kind,
			title: title.trim() || KIND_OPTIONS.find((k) => k.value === kind)?.label,
			source: buildSource(),
			refresh_interval: refreshInterval.trim() || null,
			config: parseJsonOr(configJson, {}),
			layout: { x: 0, y: 0, w: size.w, h: size.h },
		});
		onOpenChange(false);
	};

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="max-h-[85vh] overflow-auto sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Add widget</DialogTitle>
				</DialogHeader>

				<div className="space-y-4">
					<div className="space-y-1.5">
						<Label htmlFor="widget-title">Title</Label>
						<Input
							id="widget-title"
							onChange={(e) => setTitle(e.target.value)}
							placeholder="e.g. Connected clients"
							value={title}
						/>
					</div>

					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-1.5">
							<Label>Type</Label>
							<Select
								items={KIND_OPTIONS}
								onValueChange={(v: string | null) =>
									v && setKind(v as WidgetKind)
								}
								value={kind}
							>
								<SelectTrigger className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{KIND_OPTIONS.map((k) => (
										<SelectItem key={k.value} value={k.value}>
											{k.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="space-y-1.5">
							<Label>Data source</Label>
							<Select
								items={SOURCE_OPTIONS}
								onValueChange={(v: string | null) =>
									v && setSourceType(v as SourceType)
								}
								value={sourceType}
							>
								<SelectTrigger className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{SOURCE_OPTIONS.map((s) => (
										<SelectItem key={s.value} value={s.value}>
											{s.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>

					{/* Source-specific fields */}
					{sourceType === "core_endpoint" && (
						<div className="grid grid-cols-2 gap-3">
							<div className="space-y-1.5">
								<Label>Endpoint</Label>
								<Select
									items={endpointItems}
									onValueChange={(v: string | null) => v && setEndpoint(v)}
									value={endpoint}
								>
									<SelectTrigger className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{endpointItems.map((ep) => (
											<SelectItem key={ep.value} value={ep.value}>
												{ep.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="src-selector">Selector (optional)</Label>
								<Input
									id="src-selector"
									onChange={(e) => setSelector(e.target.value)}
									placeholder="e.g. clients"
									value={selector}
								/>
							</div>
						</div>
					)}

					{sourceType === "monitor" && (
						<div className="space-y-1.5">
							<Label htmlFor="src-monitor">Monitor id</Label>
							<Input
								id="src-monitor"
								onChange={(e) => setMonitorId(e.target.value)}
								placeholder="mon_…"
								value={monitorId}
							/>
						</div>
					)}

					{sourceType === "workflow" && (
						<div className="grid grid-cols-2 gap-3">
							<div className="space-y-1.5">
								<Label htmlFor="src-workflow">Workflow id</Label>
								<Input
									id="src-workflow"
									onChange={(e) => setWorkflowId(e.target.value)}
									placeholder="wf_…"
									value={workflowId}
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="src-outkey">Output key (optional)</Label>
								<Input
									id="src-outkey"
									onChange={(e) => setOutputKey(e.target.value)}
									placeholder="result"
									value={outputKey}
								/>
							</div>
						</div>
					)}

					{sourceType === "composio" && (
						<div className="space-y-3">
							<div className="space-y-1.5">
								<Label htmlFor="src-action">Composio action</Label>
								<Input
									id="src-action"
									onChange={(e) => setComposioAction(e.target.value)}
									placeholder="GMAIL_FETCH_EMAILS"
									value={composioAction}
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="src-args">Arguments (JSON, optional)</Label>
								<Textarea
									id="src-args"
									onChange={(e) => setComposioArgs(e.target.value)}
									placeholder='{ "max_results": 5 }'
									rows={3}
									value={composioArgs}
								/>
							</div>
						</div>
					)}

					{sourceType === "http" && (
						<div className="grid grid-cols-2 gap-3">
							<div className="space-y-1.5">
								<Label htmlFor="src-url">URL (https)</Label>
								<Input
									id="src-url"
									onChange={(e) => setHttpUrl(e.target.value)}
									placeholder="https://api.example.com/data"
									value={httpUrl}
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="src-http-selector">Selector (optional)</Label>
								<Input
									id="src-http-selector"
									onChange={(e) => setSelector(e.target.value)}
									placeholder="data.items"
									value={selector}
								/>
							</div>
						</div>
					)}

					{sourceType === "agent" && (
						<div className="space-y-3">
							<div className="space-y-1.5">
								<Label htmlFor="src-agent">Agent id</Label>
								<Input
									id="src-agent"
									onChange={(e) => setAgentId(e.target.value)}
									placeholder="agt_… (blank = default)"
									value={agentId}
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="src-prompt">Prompt</Label>
								<Textarea
									id="src-prompt"
									onChange={(e) => setAgentPrompt(e.target.value)}
									placeholder="Summarize today's calendar as JSON { text }"
									rows={3}
									value={agentPrompt}
								/>
							</div>
						</div>
					)}

					{sourceType === "static" && (
						<div className="space-y-1.5">
							<Label htmlFor="src-static">Inline data (JSON)</Label>
							<Textarea
								id="src-static"
								onChange={(e) => setStaticData(e.target.value)}
								placeholder='"Hello" or { "value": 42 } or [{ "x": "Mon", "y": 3 }]'
								rows={4}
								value={staticData}
							/>
						</div>
					)}

					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-1.5">
							<Label htmlFor="widget-interval">Refresh every</Label>
							<Input
								disabled={sourceType === "static"}
								id="widget-interval"
								onChange={(e) => setRefreshInterval(e.target.value)}
								placeholder="30s"
								value={refreshInterval}
							/>
						</div>
					</div>

					<details className="text-sm">
						<summary className="cursor-pointer text-muted-foreground">
							Advanced: display config (JSON)
						</summary>
						<Textarea
							className="mt-2"
							onChange={(e) => setConfigJson(e.target.value)}
							placeholder='charts: { "x_key": "day", "series": ["signups"] } · stat: { "unit": "users" }'
							rows={3}
							value={configJson}
						/>
					</details>
				</div>

				<DialogFooter>
					<Button onClick={() => onOpenChange(false)} variant="outline">
						Cancel
					</Button>
					<Button
						onClick={() => {
							handleSubmit().catch(() => undefined);
						}}
					>
						Add widget
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
