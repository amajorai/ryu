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
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import {
	DEFAULT_PREDICT_CONFIG,
	getPredictConfig,
	type PredictConfig,
	setPredictConfig,
} from "@/src/lib/api/predict.ts";
import type { SideModelConfig } from "@/src/lib/api/preferences.ts";
import { SideModelPicker } from "./shared/SideModelPicker.tsx";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";

// "Default model" sentinel for the agent picker (Base UI Select dislikes "").
const DEFAULT_MODEL_OPTION = "__default_model__";

// Allowlist entries are separated by newlines or commas.
const ALLOWLIST_SEP = /[\n,]/;

/** A newline/comma-separated textarea ⇄ a clean app-name list. */
function parseAllowlist(text: string): string[] {
	return text
		.split(ALLOWLIST_SEP)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

export function PredictSettings() {
	const { url, token, userJwt } = toTarget(useActiveNode());
	const target = useMemo(
		() => ({ url, token, userJwt }),
		[url, token, userJwt]
	);
	return (
		<LoadedPredictSettings
			key={JSON.stringify([url, token, userJwt ?? null])}
			target={target}
		/>
	);
}

function LoadedPredictSettings({ target }: { target: ApiTarget }) {
	const [cfg, setCfg] = useState<PredictConfig>(DEFAULT_PREDICT_CONFIG);
	const [allowlistText, setAllowlistText] = useState("");
	const [debounceText, setDebounceText] = useState(
		String(DEFAULT_PREDICT_CONFIG.debounceMs)
	);
	const [loaded, setLoaded] = useState(false);
	const [readError, setReadError] = useState(false);
	const [readAttempt, setReadAttempt] = useState(0);
	const [saving, setSaving] = useState(false);
	const [failedChange, setFailedChange] = useState<PredictConfig | null>(null);
	const savedConfig = useRef<PredictConfig | null>(null);
	const savingRef = useRef(false);
	const mounted = useRef(true);
	const { agents } = useAgents();

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	useEffect(() => {
		let cancelled = false;
		setReadError(false);
		getPredictConfig(target, { fallbackOnError: false })
			.then((value) => {
				if (!cancelled) {
					savedConfig.current = value;
					setCfg(value);
					setAllowlistText(value.appAllowlist.join("\n"));
					setDebounceText(String(value.debounceMs));
					setLoaded(true);
				}
			})
			.catch(() => {
				if (!cancelled) setReadError(true);
			});
		return () => {
			cancelled = true;
		};
	}, [target, readAttempt]);

	const persist = useCallback(
		async (next: PredictConfig) => {
			if (!loaded || savingRef.current) return;
			savingRef.current = true;
			setSaving(true);
			setFailedChange(null);
			setCfg(next);
			setAllowlistText(next.appAllowlist.join("\n"));
			setDebounceText(String(next.debounceMs));
			try {
				const ok = await setPredictConfig(target, next);
				if (!mounted.current) return;
				if (!ok) throw new Error("Autocomplete write refused");
				savedConfig.current = next;
				toast.success("Autocomplete settings saved");
			} catch {
				if (!mounted.current) return;
				const previous = savedConfig.current;
				if (previous) {
					setCfg(previous);
					setAllowlistText(previous.appAllowlist.join("\n"));
					setDebounceText(String(previous.debounceMs));
				}
				setFailedChange(next);
				toast.error("Couldn't save autocomplete settings", {
					description: "Your change wasn't saved. Please try again.",
				});
			} finally {
				if (mounted.current) {
					savingRef.current = false;
					setSaving(false);
				}
			}
		},
		[loaded, target]
	);

	const update = useCallback(
		(patch: Partial<PredictConfig>) => {
			void persist({ ...cfg, ...patch });
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

	const disabled = !loaded || saving;

	return (
		<div className="space-y-6">
			{readError ? (
				<div role="alert">
					We couldn't load autocomplete settings.
					<Button onClick={() => setReadAttempt((attempt) => attempt + 1)}>
						Retry
					</Button>
				</div>
			) : null}
			{failedChange ? (
				<div role="alert">
					We couldn't save autocomplete settings. Your saved settings are still
					active.
					<Button
						onClick={() => {
							void persist(failedChange);
						}}
					>
						Retry
					</Button>
				</div>
			) : null}
			<fieldset disabled={disabled} className="space-y-6">
				<SettingsSection
					caption={
						<>
							Inline ghost-text autocomplete in <strong>any</strong> text field.
							press <kbd className="rounded bg-muted px-1">Tab</kbd> to accept.
							The companion reads the text before your cursor, asks the model
							below for a continuation (through the Gateway, like every model
							call), and shows it inline. Password and secure fields are never
							read.
						</>
					}
					title="Autocomplete (everywhere)"
				>
					<SettingsCard>
						<p className="text-muted-foreground text-sm">
							Autocomplete is on because the <strong>Autocomplete</strong>{" "}
							plugin is enabled. To turn it off everywhere, disable the plugin
							in <strong>Settings → Plugins</strong>. The settings below tune
							what it does once it is on.
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
								disabled={disabled}
								items={agentOptions}
								onValueChange={(v) =>
									update({
										agentId: v && v !== DEFAULT_MODEL_OPTION ? v : undefined,
									})
								}
								value={agentValue}
							>
								<SelectTrigger className="h-9 w-full" id="predict-agent">
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
					caption="Limit autocomplete to specific apps, or leave empty to allow every app. Enter one app name per line (for example, Chrome or Notes). Password and secure fields are always excluded, whatever you list here."
					title="App allowlist"
				>
					<SettingsCard className="space-y-4">
						<div className="space-y-1.5">
							<Label htmlFor="predict-allowlist">Allowed apps</Label>
							<Textarea
								disabled={disabled}
								className="min-h-24"
								id="predict-allowlist"
								onBlur={saveAllowlist}
								onChange={(e) => setAllowlistText(e.target.value)}
								placeholder="Leave empty to allow every app. One app name per line."
								typography="small"
								variant="code"
								value={allowlistText}
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="predict-debounce">Debounce (ms)</Label>
							<Input
								disabled={disabled}
								className="h-9"
								id="predict-debounce"
								inputMode="numeric"
								onBlur={(e) => saveDebounce(e.target.value)}
								onChange={(e) => setDebounceText(e.target.value)}
								value={debounceText}
							/>
							<p className="text-muted-foreground text-xs">
								How long to wait after you stop typing before suggesting
								(0–5000).
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
							. That picker drives autocomplete inside Spaces documents; this
							page drives system-wide autocomplete.
						</p>
					</SettingsCard>
				</SettingsSection>
			</fieldset>
		</div>
	);
}
