import { useLiteralMessages, useRichLiteralMessages } from "@ryu/i18n/react";
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
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { friendlyModelDisplay } from "@/src/lib/catalog/friendly.ts";
import { EmbeddingCard } from "./EditorEmbeddingSettings-embedding-card.tsx";

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
	const tl = useLiteralMessages();
	const tlRich = useRichLiteralMessages();
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
					{agentModel
						? tlRich(
								"Uses {name}'s model: <span>{model}</span>",
								{
									name: selectedAgent?.name ?? "the agent",
									model: agentModelDisplay,
								},
								{ span: (c) => <span title={agentModelTitle}>{c}</span> }
							)
						: tl(
								"{name} has no model set yet, so inline AI won't produce real edits. Set a model on the agent, or choose “Custom model”.",
								{ name: selectedAgent?.name ?? "This agent" }
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
					{tl("Leave blank to use this node's Gateway ({url}).", {
						url: deriveGatewayBase(nodeUrl),
					})}
				</p>
			</div>
			<Button loading={saving} onClick={save} size="sm">
				Save
			</Button>
		</div>
	);
}
