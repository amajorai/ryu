// apps/desktop/src/components/agents/AcpAgentSettingsPanel.tsx
//
// Per-agent ACP launch and session settings, in the shape ACP editors expose
// them (Zed `agent_servers.<id>`, JetBrains `acp.json`): command, launch
// arguments, environment, plus the agent-specific knobs Core maps for it
// (config dir, CLI path, auto-compact) and session defaults (allowed models,
// default model / mode / config options).
//
// Core owns the semantics (`apps/core/src/acp_agent_settings.rs`) and serves
// this editor through `/api/agents/:id/acp-settings` (requires `agent.edit`):
// the effective settings, whether they are inherited from the agent's engine or
// registry entry, and which agent-specific knobs apply (classified from the
// default launcher, so they stay editable when the agent fails to start). Core
// never lets a value here replace environment it declares itself (Gateway
// routing, managed homes) and keeps a model pick inside the allowlist. The
// panel renders only when that read succeeds: non-ACP agents answer 404 and
// callers without edit access 403.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { sileo } from "sileo";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	fetchUnfilteredAcpConfig,
	getAcpAgentSettings,
	setAcpAgentSettings,
} from "@/src/lib/api/acp-agent-settings.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	type Choice,
	type Draft,
	defaultableOptions,
	flatOptions,
	fromDraft,
	isAbsolutePath,
	modelChoices,
	modelConfigOption,
	toDraft,
} from "./AcpAgentSettingsPanel-draft.ts";
import { ChoiceSelect, TextRow } from "./AcpAgentSettingsPanel-fields.tsx";

export function AcpAgentSettingsPanel({
	agentId,
	disabled,
	limitedOnManagedPi = false,
}: {
	agentId: string;
	disabled: boolean;
	/** The agent runs on Ryu's built-in engine while its accounts are limited,
	 * so Core serves it no launch settings (the read answers 404). */
	limitedOnManagedPi?: boolean;
}) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	// One reactive target for reads and writes: the same (per-tab aware) node
	// the surrounding page and its `acp-config` reads use.
	const node = useActiveNode();
	const target = useMemo(() => toTarget(node), [node]);
	const settingsKey = ["acp-agent-settings", node.url, agentId] as const;
	const settingsQuery = useQuery({
		queryKey: settingsKey,
		queryFn: () => getAcpAgentSettings(target, agentId),
		retry: false,
		refetchOnWindowFocus: false,
	});
	// The full advertisement (allowlist and defaults not applied), so a model
	// this form excluded can be re-enabled. Shares the `acp-config` key prefix,
	// so a save that invalidates the composer's config refreshes it too.
	const configQuery = useQuery({
		queryKey: ["acp-config", node.url, agentId, "all-models"],
		queryFn: () => fetchUnfilteredAcpConfig(target, agentId),
		enabled: settingsQuery.isSuccess,
		staleTime: 5 * 60 * 1000,
		refetchOnWindowFocus: false,
		retry: 1,
	});
	const config = configQuery.data ?? null;
	const error = configQuery.error?.message ?? null;
	const view = settingsQuery.data ?? null;
	const [saved, setSaved] = useState<Draft | null>(null);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (!view) {
			setSaved(null);
			setDraft(null);
			return;
		}
		const next = toDraft(view.settings);
		setSaved(next);
		setDraft(next);
	}, [view]);

	const models = useMemo(() => modelChoices(config), [config]);
	const modelOption = useMemo(() => modelConfigOption(config), [config]);
	const options = useMemo(() => defaultableOptions(config), [config]);
	const modes = useMemo<Choice[]>(
		() =>
			(config?.modes?.availableModes ?? []).map((mode) => ({
				id: mode.id,
				name: mode.name,
			})),
		[config]
	);

	// Support comes from the settings read, not the probe, so a broken launch
	// (say, a moved CLI path) can still be corrected here.
	if (!(view && draft && saved)) {
		if (settingsQuery.isLoading) {
			return (
				<SettingsSection title="Agent launch">
					<p className="text-muted-foreground text-xs">
						Reading agent settings…
					</p>
				</SettingsSection>
			);
		}
		// A limited agent on the "Ryu" engine runs on Ryu's built-in engine,
		// which takes no launch settings; the ones saved for it come back
		// when the limit is off.
		return limitedOnManagedPi && settingsQuery.isError ? (
			<SettingsSection title="Agent launch">
				<p className="text-muted-foreground text-xs">
					Saved launch settings apply again when the limit is off.
				</p>
			</SettingsSection>
		) : null;
	}

	const support = view.support;
	const busy = disabled || saving;
	const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
	const patch = (next: Partial<Draft>) => setDraft({ ...draft, ...next });
	const offeredModels =
		draft.allowedModels.length > 0
			? models.filter((model) => draft.allowedModels.includes(model.id))
			: models;
	// An agent that exposes the model only as a config option takes its default
	// through that option rather than the ACP model API.
	const modelViaOption =
		modelOption && (config?.models?.availableModels.length ?? 0) === 0
			? modelOption
			: null;
	const defaultModelValue = modelViaOption
		? (draft.defaultConfigOptions[modelViaOption.id] ?? "")
		: draft.defaultModel;
	const setDefaultModel = (value: string) => {
		if (!modelViaOption) {
			patch({ defaultModel: value });
			return;
		}
		const { [modelViaOption.id]: _previous, ...rest } =
			draft.defaultConfigOptions;
		patch({
			defaultModel: "",
			defaultConfigOptions: value
				? { ...rest, [modelViaOption.id]: value }
				: rest,
		});
	};
	const toggleModel = (id: string, allowed: boolean) => {
		const current =
			draft.allowedModels.length > 0
				? draft.allowedModels
				: models.map((model) => model.id);
		const next = allowed
			? [...new Set([...current, id])]
			: current.filter((model) => model !== id);
		// A default the allowlist no longer includes would never apply; clear it
		// rather than keep a hidden value Core ignores.
		const clearsDefault = !allowed && defaultModelValue === id;
		const defaultConfigOptions =
			clearsDefault && modelViaOption
				? Object.fromEntries(
						Object.entries(draft.defaultConfigOptions).filter(
							([optionId]) => optionId !== modelViaOption.id
						)
					)
				: draft.defaultConfigOptions;
		patch({
			// Every model allowed is the same as no allowlist.
			allowedModels: next.length === models.length ? [] : next,
			defaultConfigOptions,
			defaultModel: clearsDefault && !modelViaOption ? "" : draft.defaultModel,
		});
	};

	const save = async () => {
		const relative = [draft.configDir, draft.cliPath].find(
			(path) => path.trim() && !isAbsolutePath(path.trim())
		);
		if (relative) {
			sileo.error({
				title: "Use an absolute path",
				description: tl('"{path}" is relative; agent paths must be absolute.', {
					path: relative.trim(),
				}),
			});
			return;
		}
		setSaving(true);
		try {
			const next = await setAcpAgentSettings(target, agentId, fromDraft(draft));
			queryClient.setQueryData(settingsKey, next);
			await queryClient.invalidateQueries({ queryKey: ["acp-config"] });
			sileo.success({
				title: "Agent settings saved",
				description: "New sessions of this agent use them.",
			});
		} catch (saveError) {
			sileo.error({
				title: "Could not save agent settings",
				description:
					saveError instanceof Error ? saveError.message : String(saveError),
			});
		} finally {
			setSaving(false);
		}
	};

	return (
		<SettingsSection
			caption="How Ryu launches this ACP agent. Gateway routing and managed folders take precedence."
			headerAction={
				<div className="flex gap-2">
					<Button
						disabled={busy || !dirty}
						onClick={() => setDraft(saved)}
						size="sm"
						variant="ghost"
					>
						Reset
					</Button>
					<Button disabled={busy || !dirty} onClick={save} size="sm">
						Save
					</Button>
				</div>
			}
			title="Agent launch"
		>
			{error ? (
				<p className="text-status-warning text-xs dark:text-status-warning">
					{tl(
						"The agent did not start ({error}). Launch settings are still editable; model and mode choices appear once it starts.",
						{ error }
					)}
				</p>
			) : null}
			{view.inheritedFrom ? (
				<p className="text-muted-foreground text-xs">
					{tl(
						"These settings are inherited from {inheritedFrom}. Saving stores them for this agent, and later changes to {inheritedFrom} no longer apply here.",
						{ inheritedFrom: view.inheritedFrom }
					)}
				</p>
			) : null}
			<SettingsGroup>
				<TextRow
					description="A program to run instead of the default launcher. Replaces the default arguments."
					disabled={busy}
					label="Command"
					onChange={(command) => patch({ command })}
					placeholder="Default launcher"
					value={draft.command}
				/>
				<TextRow
					description="One argument per line, passed verbatim."
					disabled={busy}
					label="Launch arguments"
					multiline
					onChange={(argsText) => patch({ argsText })}
					value={draft.argsText}
				/>
				<TextRow
					description="One NAME=value per line."
					disabled={busy}
					label="Environment variables"
					multiline
					onChange={(envText) => patch({ envText })}
					placeholder="NAME=value"
					value={draft.envText}
				/>
			</SettingsGroup>

			{support.configDir ||
			support.configDirManaged ||
			support.cliPath ||
			support.autoCompactToggle ||
			support.autoCompactTokens ? (
				<SettingsGroup>
					{support.configDir ? (
						<TextRow
							description="Absolute path to the agent's own settings, history and plugins."
							disabled={busy}
							label="Config directory"
							onChange={(configDir) => patch({ configDir })}
							placeholder="Agent default"
							value={draft.configDir}
						/>
					) : null}
					{support.configDirManaged ? (
						<SettingsItem
							description="Ryu runs this agent with its own managed config directory to keep file deletion recoverable."
							title="Config directory"
						/>
					) : null}
					{support.cliPath ? (
						<TextRow
							description="Absolute path to the agent CLI the adapter drives."
							disabled={busy}
							label="CLI executable"
							onChange={(cliPath) => patch({ cliPath })}
							placeholder="Bundled"
							value={draft.cliPath}
						/>
					) : null}
					{support.autoCompactToggle ? (
						<SettingsItem
							actions={
								<Switch
									aria-label="Auto-compact"
									checked={draft.autoCompact !== false}
									disabled={busy}
									onCheckedChange={(checked) =>
										patch({ autoCompact: checked ? null : false })
									}
								/>
							}
							description="Compact the conversation automatically near the context limit. Manual compaction stays available."
							title="Auto-compact"
						/>
					) : null}
					{support.autoCompactTokens ? (
						<TextRow
							description="Token count at which automatic compaction runs."
							disabled={busy || draft.autoCompact === false}
							label="Auto-compact threshold"
							onChange={(autoCompactTokens) =>
								patch({
									autoCompactTokens: autoCompactTokens.replace(/\D/g, ""),
								})
							}
							placeholder="Agent default"
							value={draft.autoCompactTokens}
						/>
					) : null}
				</SettingsGroup>
			) : null}

			{models.length > 0 || modes.length > 0 || options.length > 0 ? (
				<SettingsGroup>
					{models.length > 0 ? (
						<SettingsItem
							description="Models offered in the composer for this agent. All are offered when every box is checked."
							title="Available models"
						>
							<div className="flex flex-col gap-1.5">
								{models.map((model) => (
									<label
										className="flex items-center gap-2 text-sm"
										key={model.id}
									>
										<Checkbox
											checked={
												draft.allowedModels.length === 0 ||
												draft.allowedModels.includes(model.id)
											}
											disabled={busy}
											onCheckedChange={(checked) =>
												toggleModel(model.id, checked === true)
											}
										/>
										{model.name}
									</label>
								))}
							</div>
						</SettingsItem>
					) : null}
					{models.length > 0 ? (
						<SettingsItem
							actions={
								<ChoiceSelect
									ariaLabel="Default model"
									choices={offeredModels}
									disabled={busy}
									onChange={setDefaultModel}
									value={defaultModelValue}
								/>
							}
							title="Default model"
						/>
					) : null}
					{modes.length > 0 ? (
						<SettingsItem
							actions={
								<ChoiceSelect
									ariaLabel="Default mode"
									choices={modes}
									disabled={busy}
									onChange={(defaultMode) => patch({ defaultMode })}
									value={draft.defaultMode}
								/>
							}
							title="Default mode"
						/>
					) : null}
					{options.map((option) => (
						<SettingsItem
							actions={
								<ChoiceSelect
									ariaLabel={tl("Default {name}", { name: option.name })}
									choices={flatOptions(option).map((value) => ({
										id: value.value,
										name: value.name,
									}))}
									disabled={busy}
									onChange={(value) => {
										const { [option.id]: _previous, ...rest } =
											draft.defaultConfigOptions;
										patch({
											defaultConfigOptions: value
												? { ...rest, [option.id]: value }
												: rest,
										});
									}}
									value={draft.defaultConfigOptions[option.id] ?? ""}
								/>
							}
							key={option.id}
							title={tl("Default {name}", { name: option.name.toLowerCase() })}
						/>
					))}
				</SettingsGroup>
			) : null}
		</SettingsSection>
	);
}
