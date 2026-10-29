import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { useQueryClient } from "@tanstack/react-query";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { AgentSelectionField } from "@/components/agent-elements/input/agent-selection-field.tsx";
import {
	type PromptCacheConfirmation,
	PromptCacheConfirmDialog,
} from "@/src/components/chat/PromptCacheConfirmDialog.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { nodeDefaultModelQueryKey } from "@/src/hooks/useNodeDefaultModel.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type AgentSelection,
	EMPTY_AGENT_SELECTION,
	getLaneAgentSelection,
	getPreference,
	setLaneAgentSelection,
	setPreference,
} from "@/src/lib/api/preferences.ts";
import { laneDefaultCacheWarning } from "@/src/lib/node-default-cache-warning.ts";
import { BotRealmDefaultCard } from "./BotRealmDefaultCard.tsx";

/**
 * The node-wide default target: what every agent/model setting on this node
 * falls back to when it is left unset — plugin settings fields, chat
 * auto-rename, `/btw`, the advisor, context compaction, chat suggestions, and
 * the agent-auto no-match fallback.
 *
 * Node-scoped rather than per-user because it is inherited by everyone and
 * everything on the node. It writes the same `AgentSelection` shape a plugin
 * field writes, so there is one value vocabulary rather than a special case for
 * "the global one".
 */

// How long the resident local chat model stays loaded after its last request
// before llama-server unloads it from memory (auto-reload on the next request).
// Mirrors Core's `engine.llamacpp.sleep-idle-seconds` preference; the stored
// value is seconds, and `"0"` means "never unload".
const LOCAL_MODEL_IDLE_PREF = "engine.llamacpp.sleep-idle-seconds";
const LOCAL_MODEL_IDLE_OPTIONS = [
	{ value: "0", label: "Never" },
	{ value: "60", label: "1 minute" },
	{ value: "300", label: "5 minutes" },
	{ value: "900", label: "15 minutes" },
	{ value: "1800", label: "30 minutes" },
	{ value: "3600", label: "1 hour" },
];

interface DefaultsProps {
	canConfigure: boolean;
	managed: boolean;
	target: ApiTarget;
}

export function DefaultsSection(props: DefaultsProps) {
	const { url, token } = props.target;
	const userJwt = props.target.userJwt ?? null;
	const target = useMemo(
		() => ({ url, token, userJwt: userJwt ?? null }),
		[url, token, userJwt]
	);
	const instance = useId();
	const sequence = useRef(0);
	const scope = useMemo(
		() => `${instance}:${++sequence.current}`,
		[instance, url, token, userJwt]
	);
	return <ScopedDefaultsSection key={scope} {...props} target={target} />;
}

function ScopedDefaultsSection({
	canConfigure,
	managed,
	target,
}: DefaultsProps) {
	const queryClient = useQueryClient();
	const tl = useLiteralMessages();
	const [localSelection, setLocalSelection] = useState(EMPTY_AGENT_SELECTION);
	const [cloudSelection, setCloudSelection] = useState(EMPTY_AGENT_SELECTION);
	const [loaded, setLoaded] = useState(false);
	const [idleSeconds, setIdleSeconds] = useState("300");
	const [idleLoaded, setIdleLoaded] = useState(false);
	const [loadError, setLoadError] = useState(false);
	const [reload, setReload] = useState(0);
	const [saving, setSaving] = useState({
		local: false,
		cloud: false,
		idle: false,
	});
	const pending = useRef({ local: false, cloud: false, idle: false });
	// A lane change held until the user confirms the cache reset it causes.
	const [pendingChange, setPendingChange] = useState<{
		apply: () => void;
		confirmation: PromptCacheConfirmation;
	} | null>(null);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	useEffect(() => {
		let cancelled = false;
		setLoaded(false);
		setIdleLoaded(false);
		setLoadError(false);
		Promise.all([
			getLaneAgentSelection(target, "local"),
			getLaneAgentSelection(target, "cloud"),
			getPreference(target, LOCAL_MODEL_IDLE_PREF),
		])
			.then(([local, cloud, idle]) => {
				if (cancelled) {
					return;
				}
				setLocalSelection(local);
				setCloudSelection(cloud);
				setIdleSeconds(idle ?? "300");
				setLoaded(true);
				setIdleLoaded(true);
			})
			.catch(() => {
				if (!cancelled) {
					setLoadError(true);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [target, reload]);

	const save = useCallback(
		async (lane: "local" | "cloud", next: AgentSelection) => {
			if (!(canConfigure && loaded) || pending.current[lane]) {
				return;
			}
			pending.current[lane] = true;
			setSaving((current) => ({ ...current, [lane]: true }));
			const previous = lane === "local" ? localSelection : cloudSelection;
			const setSelection =
				lane === "local" ? setLocalSelection : setCloudSelection;
			setSelection(next);
			const rollback = () => {
				if (!mounted.current) {
					return;
				}
				setSelection(previous);
				toast.error("Couldn't save the default", {
					description: "Check your connection and try again.",
				});
			};
			try {
				const ok = await setLaneAgentSelection(target, lane, next);
				if (!ok) {
					rollback();
				} else if (lane === "local") {
					// Preferences belong to this node, even when its consumers have
					// different admission credentials or an inactive cached panel.
					void queryClient.invalidateQueries({
						queryKey: nodeDefaultModelQueryKey(target).slice(0, 2),
					});
				}
			} catch {
				rollback();
			} finally {
				pending.current[lane] = false;
				if (mounted.current) {
					setSaving((current) => ({ ...current, [lane]: false }));
				}
			}
		},
		[target, cloudSelection, localSelection, canConfigure, loaded, queryClient]
	);

	/** Save now when the lane keeps the model chats run on, or after "Apply
	 * now" when it moves them. Cancel leaves the lane as it was. */
	const requestSave = (lane: "local" | "cloud", next: AgentSelection) => {
		if (!(canConfigure && loaded) || pending.current[lane]) {
			return;
		}
		const confirmation = laneDefaultCacheWarning({
			after: next,
			cloudSelection,
			lane,
			localSelection,
			managed,
		});
		const apply = () => {
			save(lane, next).catch(() => undefined);
		};
		if (!confirmation) {
			apply();
			return;
		}
		setPendingChange({ apply, confirmation });
	};

	const saveIdleSeconds = useCallback(
		async (next: string) => {
			if (!idleLoaded || pending.current.idle) {
				return;
			}
			pending.current.idle = true;
			setSaving((current) => ({ ...current, idle: true }));
			const previous = idleSeconds;
			setIdleSeconds(next);
			const rollback = () => {
				if (!mounted.current) {
					return;
				}
				setIdleSeconds(previous);
				toast.error("Couldn't save the auto-unload setting", {
					description: "Check your connection and try again.",
				});
			};
			try {
				const ok = await setPreference(target, LOCAL_MODEL_IDLE_PREF, next);
				if (!ok) {
					rollback();
				}
			} catch {
				rollback();
			} finally {
				pending.current.idle = false;
				if (mounted.current) {
					setSaving((current) => ({ ...current, idle: false }));
				}
			}
		},
		[target, idleSeconds, idleLoaded]
	);

	return (
		<SettingsSection
			caption="Ryu keeps two node-scoped defaults. Normal chats use the cloud lane when it is configured; plugins, side-model calls, and local utilities use the local lane. Ryu can carry its agent, provider, model, and effort together. External ACP agents retain their own controls."
			title="Default agents & models"
		>
			{loadError ? (
				<SettingsCard className="flex items-center justify-between gap-3">
					<p className="text-sm" role="alert">
						Could not load the saved defaults. Retry before making changes.
					</p>
					<Button
						onClick={() => {
							setReload((current) => current + 1);
							void queryClient.invalidateQueries({
								queryKey: nodeDefaultModelQueryKey(target).slice(0, 2),
							});
						}}
						size="sm"
						variant="outline"
					>
						Retry
					</Button>
				</SettingsCard>
			) : null}
			<SettingsGroup>
				<SettingsItem
					description="Local lane for plugins, side-model calls, and utility work. Fresh nodes start at Ryu on the installed Gemma 4 model."
					title="Default local agent"
				>
					{loaded ? (
						<AgentSelectionField
							allowedProviderIds={["local"]}
							ariaLabel="Default local agent or model"
							disabled={!canConfigure || saving.local}
							onChange={(next) => requestSave("local", next)}
							placeholder="Ryu · local · Gemma 4"
							preserveRyuRoute
							target={target}
							value={localSelection}
						/>
					) : (
						<Skeleton className="h-8 w-full" />
					)}
				</SettingsItem>
			</SettingsGroup>

			<BotRealmDefaultCard
				canConfigure={canConfigure && !saving.cloud}
				loaded={loaded}
				managed={managed}
				onChange={(next) => requestSave("cloud", next)}
				target={target}
				value={cloudSelection}
			/>

			{canConfigure ? null : (
				<p className="px-3.5 text-muted-foreground text-xs leading-snug">
					Only organization owners and admins can change the local or Bot realm
					default.
				</p>
			)}

			<SettingsGroup>
				<SettingsItem
					actions={
						idleLoaded ? (
							<Select
								disabled={saving.idle}
								onValueChange={(v: string | null) => {
									if (v) {
										saveIdleSeconds(v).catch(() => undefined);
									}
								}}
								value={idleSeconds}
							>
								<SelectTrigger
									aria-label="Auto-unload local model"
									className="h-8 w-40"
								>
									<SelectValue>
										{LOCAL_MODEL_IDLE_OPTIONS.find(
											(option) => option.value === idleSeconds
										)?.label ?? tl("{idleSeconds} seconds", { idleSeconds })}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									{LOCAL_MODEL_IDLE_OPTIONS.map((opt) => (
										<SelectItem key={opt.value} value={opt.value}>
											{opt.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						) : (
							<Skeleton className="h-8 w-40" />
						)
					}
					description={`Applies to the llama.cpp engine, Ryu's on-device engine. The model stays loaded this long after its last request, then frees its memory; the next message reloads it. "Never" keeps it resident. Other local engines (Ollama, vLLM, SGLang, MLX, Apple Foundation Models) manage their own memory, so this setting has no effect on them.`}
					title="Auto-unload local model"
				/>
			</SettingsGroup>
			<PromptCacheConfirmDialog
				confirmation={pendingChange?.confirmation ?? null}
				onApply={() => {
					const change = pendingChange;
					setPendingChange(null);
					change?.apply();
				}}
				onCancel={() => setPendingChange(null)}
			/>
		</SettingsSection>
	);
}
