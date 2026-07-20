import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { toast } from "@ryu/ui/components/sileo";
import { Spinner } from "@ryu/ui/components/spinner";
import { Switch } from "@ryu/ui/components/switch";
import { setEditorAiConfig } from "@ryu/ui/lib/editor-ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { useFriendlyMode } from "@/src/hooks/useFriendlyMode.ts";
import {
	deriveGatewayBase,
	EDITOR_AI_PREF_KEY,
	type EditorAiPref,
} from "@/src/hooks/useRegisterEditorAi.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { getPreference, setPreference } from "@/src/lib/api/preferences.ts";
import {
	fetchEmbeddingModel,
	fetchReindexStatus,
	type ReindexStatus,
	setEmbeddingModel,
	triggerReindex,
} from "@/src/lib/api/spaces.ts";
import { friendlyModelDisplay } from "@/src/lib/catalog/friendly.ts";

/**
 * Settings for the in-app editor's AI (which model routes Cmd+J inline edits via
 * the Gateway) and the default RAG embedding model. Changing the embedding model
 * is a correctness event — every existing vector lives in an incomparable space —
 * so Core auto-reindexes in the background; this panel shows that progress.
 */
export function EditorEmbeddingSettings() {
	const node = useActiveNode();
	const target: ApiTarget = { url: node.url, token: node.token ?? null };

	return (
		<div className="space-y-4">
			<EditorAiCard nodeUrl={node.url} target={target} />
			<EmbeddingCard target={target} />
		</div>
	);
}

/** Sentinel value for the agent picker meaning "no agent — use the model below". */
const CUSTOM_AGENT_VALUE = "__custom__";

function EditorAiCard({
	target,
	nodeUrl,
}: {
	target: ApiTarget;
	nodeUrl: string;
}) {
	const { agents } = useAgents();
	const [enabled, setEnabled] = useState(false);
	const [model, setModel] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [agentId, setAgentId] = useState("");
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		getPreference(target, EDITOR_AI_PREF_KEY).then((raw) => {
			if (raw) {
				try {
					const pref = JSON.parse(raw) as EditorAiPref;
					setEnabled(pref.enabled);
					setModel(pref.model ?? "");
					setBaseUrl(pref.baseUrl ?? "");
					setAgentId(pref.agentId ?? "");
				} catch {
					// ignore malformed pref
				}
			}
			setLoaded(true);
		});
		// Only on node change.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [target.url, target]);

	const agentOptions = useMemo(
		() => [
			{ value: CUSTOM_AGENT_VALUE, label: "Custom model" },
			...agents.map((a) => ({ value: a.id, label: a.name })),
		],
		[agents]
	);

	const selectedAgent = agentId
		? agents.find((a) => a.id === agentId)
		: undefined;
	const agentModel = selectedAgent?.model?.trim() ?? "";
	// When an agent is chosen, it drives the model; otherwise the manual field does.
	const effectiveModel = agentId ? agentModel : model.trim();
	const [friendly] = useFriendlyMode();
	// Match the rest of the app: in friendly mode show the readable model name +
	// friendly compression (never "Q4_K_M"); the raw id stays available on hover.
	// The raw id is still what's sent — this label is purely informational.
	const agentModelFriendly = agentModel
		? friendlyModelDisplay(agentModel)
		: null;
	const agentModelDisplay =
		friendly && agentModelFriendly ? agentModelFriendly.label : agentModel;
	const agentModelTitle =
		friendly && agentModelFriendly ? agentModelFriendly.tooltip : undefined;

	const save = useCallback(async () => {
		setSaving(true);
		const pref: EditorAiPref = {
			enabled,
			model: effectiveModel,
			baseUrl,
			agentId: agentId || undefined,
		};
		const ok = await setPreference(
			target,
			EDITOR_AI_PREF_KEY,
			JSON.stringify(pref)
		);
		setSaving(false);
		if (ok) {
			// Apply immediately so the open editor picks it up without a reload.
			setEditorAiConfig({
				enabled: enabled && effectiveModel.length > 0,
				model: effectiveModel,
				baseUrl: baseUrl.trim() ? baseUrl : deriveGatewayBase(nodeUrl),
				apiKey: target.token ?? undefined,
				agentId: agentId || undefined,
			});
			if (enabled && effectiveModel.length === 0) {
				// Saved, but the feature can't run without a model, so don't imply it works.
				toast.warning({
					title: "Saved, but inline AI isn't active yet",
					description:
						"Pick an agent with a model, or enter a model id, so the editor knows what to use.",
				});
			} else {
				toast.success("Editor AI settings saved");
			}
		} else {
			toast.error("Couldn't save editor AI settings");
		}
	}, [enabled, effectiveModel, baseUrl, agentId, target, nodeUrl]);

	if (!loaded) {
		return (
			<div className="flex justify-center rounded-lg bg-muted/40 p-6">
				<Spinner />
			</div>
		);
	}

	return (
		<div className="space-y-4 rounded-lg bg-muted/40 p-4">
			<div className="flex items-center justify-between">
				<div>
					<p className="font-medium text-sm">Inline AI editing</p>
					<p className="text-muted-foreground text-xs">
						Powers the editor's Cmd+J menu (continue, improve, fix, summarize),
						routed through the Gateway.
					</p>
				</div>
				<Switch
					aria-label="Enable editor AI"
					checked={enabled}
					onCheckedChange={setEnabled}
				/>
			</div>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="editor-ai-agent">Agent</Label>
				<Select
					items={agentOptions}
					onValueChange={(v) =>
						setAgentId(v && v !== CUSTOM_AGENT_VALUE ? v : "")
					}
					value={agentId || CUSTOM_AGENT_VALUE}
				>
					<SelectTrigger className="h-8 text-sm" id="editor-ai-agent">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{agentOptions.map((opt) => (
							<SelectItem key={opt.value} value={opt.value}>
								{opt.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<p className="text-muted-foreground text-xs">
					Pick an agent to back the editor's AI with that agent's model, or
					choose “Custom model” to set a model id directly. The editor keeps its
					own inline-writing instructions either way.
				</p>
			</div>
			{agentId ? (
				<p className="text-muted-foreground text-xs">
					{agentModel ? (
						<>
							Uses {selectedAgent?.name ?? "the agent"}'s model:{" "}
							<span title={agentModelTitle}>{agentModelDisplay}</span>
						</>
					) : (
						`${selectedAgent?.name ?? "This agent"} has no model set yet, so inline AI won't produce real edits. Set a model on the agent, or choose “Custom model”.`
					)}
				</p>
			) : (
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="editor-ai-model">Model</Label>
					<Input
						id="editor-ai-model"
						onChange={(e) => setModel(e.target.value)}
						placeholder="e.g. the model id your Gateway routes (gemma, gpt-4o-mini…)"
						value={model}
					/>
				</div>
			)}
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="editor-ai-base">Gateway base URL (optional)</Label>
				<Input
					id="editor-ai-base"
					onChange={(e) => setBaseUrl(e.target.value)}
					placeholder={deriveGatewayBase(nodeUrl)}
					value={baseUrl}
				/>
				<p className="text-muted-foreground text-xs">
					Leave blank to use this node's Gateway ({deriveGatewayBase(nodeUrl)}).
				</p>
			</div>
			<Button disabled={saving} onClick={save} size="sm">
				{saving ? <Spinner className="size-4" /> : null}
				Save
			</Button>
		</div>
	);
}

function EmbeddingCard({ target }: { target: ApiTarget }) {
	const [status, setStatus] = useState<ReindexStatus | null>(null);
	const [modelInput, setModelInput] = useState("");
	const [baseUrlInput, setBaseUrlInput] = useState("");
	const [dimsInput, setDimsInput] = useState("");
	const [busy, setBusy] = useState(false);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const refresh = useCallback(async () => {
		try {
			const s = await fetchReindexStatus(target);
			setStatus(s);
			return s;
		} catch {
			return null;
		}
	}, [target]);

	useEffect(() => {
		fetchEmbeddingModel(target)
			.then((m) => {
				setModelInput(m.modelId);
				setBaseUrlInput(m.baseUrl);
				setDimsInput(m.dims ? String(m.dims) : "");
			})
			.catch(() => {
				// ignore
			});
		refresh().catch(() => undefined);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [target.url, target, refresh]);

	// Poll while a reindex is running so the progress bar advances.
	useEffect(() => {
		if (status?.running && !pollRef.current) {
			pollRef.current = setInterval(() => {
				void refresh().then((s) => {
					if (s && !s.running && pollRef.current) {
						clearInterval(pollRef.current);
						pollRef.current = null;
					}
				});
			}, 1500);
		}
		return () => {
			if (pollRef.current) {
				clearInterval(pollRef.current);
				pollRef.current = null;
			}
		};
	}, [status?.running, refresh]);

	const applyModel = useCallback(async () => {
		setBusy(true);
		try {
			const dims = dimsInput.trim() ? Number(dimsInput) : undefined;
			await setEmbeddingModel(
				target,
				modelInput.trim(),
				baseUrlInput.trim() || undefined,
				Number.isFinite(dims) ? dims : undefined
			);
			toast.success("Embedding model changed — reindexing in the background");
			await refresh();
		} catch (e) {
			toast.error(
				e instanceof Error ? e.message : "Failed to change embedding model"
			);
		} finally {
			setBusy(false);
		}
	}, [target, modelInput, baseUrlInput, dimsInput, refresh]);

	const reindexNow = useCallback(async () => {
		setBusy(true);
		try {
			await triggerReindex(target);
			await refresh();
		} catch {
			toast.error("Couldn't start reindex");
		} finally {
			setBusy(false);
		}
	}, [target, refresh]);

	const pending = status?.pendingChunks ?? 0;
	const totalChunks = status?.totalChunks ?? 0;
	const doneChunks = Math.max(0, totalChunks - pending);
	const pct =
		totalChunks > 0 ? Math.round((doneChunks / totalChunks) * 100) : 0;

	return (
		<div className="space-y-4 rounded-lg bg-muted/40 p-4">
			<div>
				<p className="font-medium text-sm">Default embedding model</p>
				<p className="text-muted-foreground text-xs">
					Used to embed Spaces pages for RAG. Changing it re-embeds every
					document (old vectors are not comparable across models).
				</p>
			</div>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="embed-model">Model id</Label>
				<Input
					id="embed-model"
					onChange={(e) => setModelInput(e.target.value)}
					placeholder="nomic-embed-text-v1.5"
					value={modelInput}
				/>
			</div>
			<div className="grid grid-cols-2 gap-3">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="embed-base">Base URL (optional)</Label>
					<Input
						id="embed-base"
						onChange={(e) => setBaseUrlInput(e.target.value)}
						placeholder="http://127.0.0.1:8081"
						value={baseUrlInput}
					/>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="embed-dims">Dimensions (optional)</Label>
					<Input
						id="embed-dims"
						onChange={(e) => setDimsInput(e.target.value)}
						placeholder="768"
						value={dimsInput}
					/>
				</div>
			</div>
			<div className="flex items-center gap-2">
				<Button disabled={busy} onClick={applyModel} size="sm">
					{busy ? <Spinner className="size-4" /> : null}
					Change & reindex
				</Button>
				<Button
					disabled={busy || pending === 0}
					onClick={reindexNow}
					size="sm"
					variant="outline"
				>
					Reindex stale ({pending})
				</Button>
			</div>

			{status ? (
				<div className="space-y-1">
					<div className="flex justify-between text-muted-foreground text-xs">
						<span>
							{status.running
								? "Reindexing…"
								: pending > 0
									? `${pending} of ${totalChunks} chunks stale`
									: "All embeddings up to date"}
						</span>
						<span>{pct}%</span>
					</div>
					<div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
						<div
							className="h-full rounded-full bg-primary transition-all"
							style={{ width: `${pct}%` }}
						/>
					</div>
				</div>
			) : null}
		</div>
	);
}
