import { Button } from "@ryu/ui/components/button.tsx";
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
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { setEditorAiConfig } from "@ryu/ui/lib/editor-ai.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
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
import previewStyles from "./settings-preview.module.css";
import type { PreviewStyle } from "./settings-preview-style.ts";

/**
 * Settings for the in-app editor's AI (which model routes Cmd+J inline edits via
 * the Gateway) and the default RAG embedding model. Changing the embedding model
 * is a correctness event — every existing vector lives in an incomparable space —
 * so Core auto-reindexes in the background; this panel shows that progress.
 */
export function EditorEmbeddingSettings() {
	const node = useActiveNode();
	const target: ApiTarget = {
		url: node.url,
		token: node.token,
		userJwt: node.userJwt ?? null,
	};

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
	const [loadError, setLoadError] = useState(false);
	const [saving, setSaving] = useState(false);

	const loadPreference = useCallback(async () => {
		setLoaded(false);
		setLoadError(false);
		try {
			const raw = await getPreference(target, EDITOR_AI_PREF_KEY);
			if (!raw) {
				setEnabled(false);
				setModel("");
				setBaseUrl("");
				setAgentId("");
				return;
			}
			try {
				const pref = z
					.object({
						enabled: z.boolean().optional(),
						model: z.string().optional(),
						baseUrl: z.string().optional(),
						agentId: z.string().optional(),
					})
					.parse(JSON.parse(raw));
				setEnabled(pref.enabled === true);
				setModel(pref.model ?? "");
				setBaseUrl(pref.baseUrl ?? "");
				setAgentId(pref.agentId ?? "");
			} catch {
				setEnabled(false);
				setModel("");
				setBaseUrl("");
				setAgentId("");
			}
		} catch {
			setLoadError(true);
		} finally {
			setLoaded(true);
		}
	}, [target]);

	useEffect(() => {
		void loadPreference();
	}, [loadPreference]);

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
		try {
			const normalizedBaseUrl = baseUrl.trim();
			const pref: EditorAiPref = {
				enabled,
				model: effectiveModel,
				baseUrl: normalizedBaseUrl,
				agentId: agentId || undefined,
			};
			const ok = await setPreference(
				target,
				EDITOR_AI_PREF_KEY,
				JSON.stringify(pref)
			);
			if (!ok) {
				toast.error("Couldn't save editor AI settings");
				return;
			}
			// Apply immediately so the open editor picks it up without a reload.
			setEditorAiConfig({
				enabled: enabled && effectiveModel.length > 0,
				model: effectiveModel,
				baseUrl: normalizedBaseUrl || deriveGatewayBase(nodeUrl),
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
		} catch {
			toast.error("Couldn't save editor AI settings");
		} finally {
			setSaving(false);
		}
	}, [enabled, effectiveModel, baseUrl, agentId, target, nodeUrl]);

	if (!loaded) {
		return (
			<div aria-label="Inline AI editing" role="region">
				<SkeletonRows spacing="library" />
			</div>
		);
	}
	if (loadError) {
		return (
			<div
				aria-label="Inline AI editing"
				className="flex items-center justify-between rounded-lg bg-muted/40 p-4"
				role="region"
			>
				<p className="text-muted-foreground text-sm" role="alert">
					Couldn't load editor AI settings.
				</p>
				<Button
					onClick={() => void loadPreference()}
					size="sm"
					variant="outline"
				>
					Retry
				</Button>
			</div>
		);
	}

	return (
		<div
			aria-labelledby="editor-ai-settings-title"
			className="space-y-4 rounded-lg bg-muted/40 p-4"
			role="region"
		>
			<div className="flex items-center justify-between">
				<div>
					<p className="font-medium text-sm" id="editor-ai-settings-title">
						Inline AI editing
					</p>
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
					<SelectTrigger className="h-8" id="editor-ai-agent">
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
			<Button loading={saving} onClick={save} size="sm">
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
	const [modelLoadError, setModelLoadError] = useState(false);
	const [statusLoadError, setStatusLoadError] = useState(false);
	const [dimsError, setDimsError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const refresh = useCallback(async () => {
		try {
			const s = await fetchReindexStatus(target);
			setStatus(s);
			setStatusLoadError(false);
			return s;
		} catch {
			setStatusLoadError(true);
			return null;
		}
	}, [target]);

	const loadModel = useCallback(async () => {
		setModelLoadError(false);
		try {
			const model = await fetchEmbeddingModel(target);
			setModelInput(model.modelId);
			setBaseUrlInput(model.baseUrl ?? "");
			setDimsInput(model.dims ? String(model.dims) : "");
		} catch {
			setModelLoadError(true);
		}
	}, [target]);

	useEffect(() => {
		void loadModel();
		void refresh();
	}, [loadModel, refresh]);

	const retryReads = useCallback(() => {
		void loadModel();
		void refresh();
	}, [loadModel, refresh]);

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
		const rawDims = dimsInput.trim();
		const dims = rawDims ? Number(rawDims) : undefined;
		if (
			rawDims &&
			(dims === undefined || !Number.isSafeInteger(dims) || dims <= 0)
		) {
			const error = "Dimensions must be a positive whole number";
			setDimsError(error);
			toast.error(error);
			return;
		}
		setDimsError(null);
		setBusy(true);
		try {
			await setEmbeddingModel(
				target,
				modelInput.trim(),
				baseUrlInput.trim() || undefined,
				Number.isFinite(dims) ? dims : undefined
			);
			toast.success("Embedding model changed; reindexing in the background");
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

	const progressStyle: PreviewStyle = {
		"--settings-preview-progress": `${pct}%`,
	};
	return (
		<div
			aria-labelledby="embedding-settings-title"
			className="space-y-4 rounded-lg bg-muted/40 p-4"
			role="region"
		>
			<div>
				<p className="font-medium text-sm" id="embedding-settings-title">
					Default embedding model
				</p>
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
						aria-describedby={dimsError ? "embed-dims-error" : undefined}
						aria-invalid={dimsError ? true : undefined}
						id="embed-dims"
						onChange={(e) => {
							setDimsInput(e.target.value);
							setDimsError(null);
						}}
						placeholder="768"
						value={dimsInput}
					/>
					{dimsError ? (
						<p
							className="text-status-destructive text-xs"
							id="embed-dims-error"
							role="alert"
						>
							{dimsError}
						</p>
					) : null}
				</div>
			</div>
			{modelLoadError || statusLoadError ? (
				<div className="flex items-center justify-between gap-3">
					<p className="text-status-destructive text-xs" role="alert">
						{modelLoadError && statusLoadError
							? "Couldn't load embedding model or reindex status."
							: modelLoadError
								? "Couldn't load the embedding model."
								: "Couldn't load reindex status."}
					</p>
					<Button onClick={retryReads} size="sm" variant="outline">
						Retry
					</Button>
				</div>
			) : null}
			<div className="flex items-center gap-2">
				<Button loading={busy} onClick={applyModel} size="sm">
					Change & reindex
				</Button>
				<Button
					disabled={busy || status?.running === true || pending === 0}
					onClick={reindexNow}
					size="sm"
					variant="ghost"
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
						<span className="tabular-nums">{pct}%</span>
					</div>
					<div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
						<div
							className={`h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none ${previewStyles.progress}`}
							style={progressStyle}
						/>
					</div>
				</div>
			) : null}
		</div>
	);
}
