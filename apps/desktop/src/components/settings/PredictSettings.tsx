// apps/desktop/src/components/settings/PredictSettings.tsx
//
// Settings for SYSTEM-WIDE predictive typing (the `apps-store/predict` overlay): inline
// ghost-text autocomplete in any text field, accepted with Tab. Configures the
// agent / model behind it, the per-app allowlist, and the debounce. All persist
// via Core's `/api/predict/config`; Core enforces the secure-field denylist + the
// app allowlist server-side and routes each prediction through the Gateway —
// nothing is hardcoded (blank model = the system default).
//
// The in-editor copilot ghost text (PlateJS, inside Spaces docs) is a SEPARATE
// surface configured by Settings → Editor & Embeddings ("Inline AI editing").

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
import { Textarea } from "@ryu/ui/components/textarea";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import {
	DEFAULT_PREDICT_CONFIG,
	getPredictConfig,
	type PredictConfig,
	setPredictConfig,
} from "@/src/lib/api/predict.ts";
import type { SideModelConfig } from "@/src/lib/api/preferences.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import { SideModelPicker } from "./shared/SideModelPicker.tsx";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";

// "Default model" sentinel for the agent picker (Base UI Select dislikes "").
const DEFAULT_MODEL_OPTION = "__default_model__";

// Allowlist entries are separated by newlines or commas.
const ALLOWLIST_SEP = /[\n,]/;

function activeTarget(): ApiTarget {
	return toTarget(useNodeStore.getState().getActiveNode());
}

/** A newline/comma-separated textarea ⇄ a clean app-name list. */
function parseAllowlist(text: string): string[] {
	return text
		.split(ALLOWLIST_SEP)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

export function PredictSettings() {
	const [cfg, setCfg] = useState<PredictConfig>(DEFAULT_PREDICT_CONFIG);
	const [allowlistText, setAllowlistText] = useState("");
	const { agents } = useAgents();

	useEffect(() => {
		let cancelled = false;
		getPredictConfig(activeTarget()).then((value) => {
			if (!cancelled) {
				setCfg(value);
				setAllowlistText(value.appAllowlist.join("\n"));
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);

	const persist = useCallback((next: PredictConfig) => {
		setCfg(next);
		void setPredictConfig(activeTarget(), next)
			.then((ok) => {
				if (ok) {
					toast.success("Predictive typing settings saved");
				} else {
					toast.error("Couldn't save predictive typing settings", {
						description: "Your change wasn't saved. Please try again.",
					});
				}
			})
			.catch(() => {
				toast.error("Couldn't save predictive typing settings", {
					description: "Your change wasn't saved. Please try again.",
				});
			});
	}, []);

	const update = useCallback(
		(patch: Partial<PredictConfig>) => {
			persist({ ...cfg, ...patch });
		},
		[cfg, persist]
	);

	const agentOptions = useMemo(
		() => [
			{ value: DEFAULT_MODEL_OPTION, label: "Default model (no agent)" },
			...agents.map((a) => ({ value: a.id, label: a.name })),
		],
		[agents]
	);
	const agentValue =
		cfg.agentId && cfg.agentId.length > 0 ? cfg.agentId : DEFAULT_MODEL_OPTION;

	// The SideModelPicker speaks `{ provider, model, effort }`. Provider is a
	// suggestion helper only (Core routes by model id), so we keep it ephemeral.
	const sideModel: SideModelConfig = {
		provider: "",
		model: cfg.model,
		effort: cfg.effort,
	};
	const onSideModelChange = (next: SideModelConfig) => {
		update({ model: next.model, effort: next.effort });
	};

	const saveAllowlist = () => {
		const list = parseAllowlist(allowlistText);
		update({ appAllowlist: list });
		setAllowlistText(list.join("\n"));
	};

	const saveDebounce = (raw: string) => {
		const n = Number.parseInt(raw, 10);
		const ms = Number.isFinite(n)
			? Math.min(Math.max(n, 0), 5000)
			: DEFAULT_PREDICT_CONFIG.debounceMs;
		update({ debounceMs: ms });
	};

	const target = activeTarget();

	return (
		<div className="space-y-6">
			<SettingsSection
				caption={
					<>
						Inline ghost-text autocomplete in <strong>any</strong> text field —
						press <kbd className="rounded bg-muted px-1">Tab</kbd> to accept.
						The companion reads the text before your cursor, asks the model
						below for a continuation (through the Gateway, like every model
						call), and shows it inline. Password and secure fields are never
						read.
					</>
				}
				title="Predictive typing (everywhere)"
			>
				<SettingsCard>
					<p className="text-muted-foreground text-sm">
						Predictive typing is on because the{" "}
						<strong>Predictive Typing</strong> plugin is enabled. To turn it off
						everywhere, disable the plugin in{" "}
						<strong>Settings → Plugins</strong>. The settings below tune what it
						does once it is on.
					</p>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection
				caption="Choose what writes the suggestions. Pick an agent to use its own model and settings, or choose Default model and set one below. Leave the model blank to use the model built into the app."
				title="Agent / model"
			>
				<SettingsCard className="space-y-4">
					<div className="space-y-1.5">
						<Label htmlFor="predict-agent">Agent</Label>
						<Select
							items={agentOptions}
							onValueChange={(v) =>
								update({
									agentId: v && v !== DEFAULT_MODEL_OPTION ? v : undefined,
								})
							}
							value={agentValue}
						>
							<SelectTrigger className="h-9 w-full text-sm" id="predict-agent">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{agentOptions.map((o) => (
									<SelectItem key={o.value} value={o.value}>
										{o.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<p className="text-muted-foreground text-xs">
							When you pick an agent, it uses the agent's own model instead of
							the model chosen below.
						</p>
					</div>
					<SideModelPicker
						onChange={onSideModelChange}
						target={target}
						value={sideModel}
					/>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection
				caption="Limit predictive typing to specific apps, or leave empty to allow every app. Enter one app name per line (for example, Chrome or Notes). Password and secure fields are always excluded, whatever you list here."
				title="App allowlist"
			>
				<SettingsCard className="space-y-4">
					<div className="space-y-1.5">
						<Label htmlFor="predict-allowlist">Allowed apps</Label>
						<Textarea
							className="min-h-24 font-mono text-sm"
							id="predict-allowlist"
							onBlur={saveAllowlist}
							onChange={(e) => setAllowlistText(e.target.value)}
							placeholder="Leave empty to allow every app. One app name per line."
							value={allowlistText}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="predict-debounce">Debounce (ms)</Label>
						<Input
							className="h-9"
							id="predict-debounce"
							inputMode="numeric"
							onBlur={(e) => saveDebounce(e.target.value)}
							onChange={(e) =>
								setCfg((p) => ({
									...p,
									debounceMs: Number.parseInt(e.target.value, 10) || 0,
								}))
							}
							value={String(cfg.debounceMs)}
						/>
						<p className="text-muted-foreground text-xs">
							How long to wait after you stop typing before suggesting (0–5000).
						</p>
					</div>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection
				caption="The inline ghost text inside Spaces documents is a separate surface."
				title="In-editor autocomplete"
			>
				<SettingsCard>
					<p className="text-muted-foreground text-sm">
						To configure the model behind the editor's own ghost-text
						completion, open{" "}
						<strong>
							Settings → Editor &amp; Embeddings → Inline AI editing
						</strong>
						. That picker drives autocomplete inside Spaces documents; this page
						drives system-wide predictive typing.
					</p>
				</SettingsCard>
			</SettingsSection>
		</div>
	);
}
