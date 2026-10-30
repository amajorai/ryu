import {
	Add01Icon,
	Delete01Icon,
	Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { useCallback, useEffect, useState } from "react";
import { ErrorLine } from "@/src/components/agents/shared/error-line.tsx";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import {
	type AgentRule,
	type AgentRulesConfig,
	type DiscoveredProjectRule,
	fetchDiscoveredProjectRules,
	legacyRulesToConfig,
	loadAgentRulesConfig,
	type RuleApplyMode,
	saveAgentRulesConfig,
} from "@/src/lib/api/agent-rules.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";

const APPLY_MODE_ITEMS = [
	{ label: "Auto", value: "auto" },
	{ label: "Always", value: "always" },
	{ label: "Manual", value: "manual" },
] satisfies readonly { label: string; value: RuleApplyMode }[];

export interface RulesAgentEditPanelProps {
	agentId: string;
	legacyRules?: string[];
	locked?: boolean;
	prefKeyPrefix?: string;
	projectCwd?: string | null;
	target: ApiTarget;
	title?: string;
}

function newRule(index: number): AgentRule {
	return {
		enabled: true,
		id: `rule-${Date.now()}-${index}`,
		mode: "auto",
		text: "",
	};
}

function ruleBadgeMode(mode: string | undefined): string {
	if (mode === "path") {
		return "Path";
	}
	if (mode === "intelligent") {
		return "Intelligent";
	}
	if (mode === "always") {
		return "Always";
	}
	if (mode === "manual") {
		return "Manual";
	}
	return "Auto";
}

function ProjectRules({
	rules,
	cwd,
}: {
	cwd: string | null;
	rules: DiscoveredProjectRule[];
}) {
	const tl = useLiteralMessages();
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center justify-between">
				<div>
					<p className="font-medium text-sm">Project rules</p>
					<p className="text-muted-foreground text-xs">
						Rules detected from Cursor, Claude, and other supported folders.
					</p>
				</div>
				<Badge variant="secondary">{rules.length}</Badge>
			</div>
			{cwd ? (
				<p className="truncate text-muted-foreground text-xs">
					{tl("Project: {cwd}", { cwd })}
				</p>
			) : null}
			{rules.length === 0 ? (
				<p className="text-detail text-muted-foreground">
					No project rules found in this workspace.
				</p>
			) : (
				<div className="flex flex-col gap-2">
					{rules.map((rule) => (
						<div
							className="flex items-center gap-2 rounded-lg border px-3 py-2"
							key={`${rule.provider}:${rule.path}`}
						>
							<div className="min-w-0 flex-1">
								<p className="truncate font-medium text-sm">
									{rule.name ?? rule.path.split("/").at(-1) ?? rule.path}
								</p>
								<p
									className="truncate text-muted-foreground text-xs"
									title={rule.path}
								>
									{rule.path}
								</p>
							</div>
							<Badge variant="outline">{rule.provider}</Badge>
							<Badge variant="secondary">{ruleBadgeMode(rule.applyMode)}</Badge>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

/** Native editor for the rules plugin's Agent Edit contribution. */
export function RulesAgentEditPanel({
	agentId,
	legacyRules = [],
	locked = false,
	prefKeyPrefix = "agent-rules:",
	projectCwd = null,
	target,
	title = "Rules",
}: RulesAgentEditPanelProps) {
	const tl = useLiteralMessages();
	const [config, setConfig] = useState<AgentRulesConfig>(() =>
		legacyRulesToConfig(legacyRules)
	);
	const [projectRules, setProjectRules] = useState<DiscoveredProjectRule[]>([]);
	const [cwd, setCwd] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [dirty, setDirty] = useState(false);
	const prefKey = `${prefKeyPrefix}${encodeURIComponent(agentId)}`;

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const [{ config: loaded, migrated }, discovered] = await Promise.all([
				loadAgentRulesConfig(target, prefKey, legacyRules),
				fetchDiscoveredProjectRules(target, projectCwd),
			]);
			setConfig(loaded);
			setDirty(migrated);
			setCwd(discovered.cwd);
			setProjectRules(discovered.rules);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Rules unavailable");
		} finally {
			setLoading(false);
		}
	}, [legacyRules, prefKey, projectCwd, target]);

	useEffect(() => {
		load();
	}, [load]);

	useEffect(() => {
		if (loading || !dirty || locked) {
			return;
		}
		let cancelled = false;
		setSaving(true);
		saveAgentRulesConfig(target, prefKey, config)
			.then((ok) => {
				if (!cancelled) {
					setDirty(!ok);
					setError(ok ? null : "Could not save rules");
				}
			})
			.catch(() => {
				if (!cancelled) {
					setDirty(true);
					setError("Could not save rules");
				}
			})
			.finally(() => {
				if (!cancelled) {
					setSaving(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [config, dirty, loading, locked, prefKey, target]);

	const update = (patch: Partial<AgentRulesConfig>) => {
		if (locked) {
			return;
		}
		setConfig((current) => ({ ...current, ...patch }));
		setDirty(true);
	};

	const updateRule = (id: string, patch: Partial<AgentRule>) => {
		update({
			rules: config.rules.map((rule) =>
				rule.id === id ? { ...rule, ...patch } : rule
			),
		});
	};

	return (
		<SettingsSection
			caption="Agent rules and detected project rules, injected into context by the selected mode."
			headerAction={
				saving ? (
					<span className="text-muted-foreground text-xs">Saving…</span>
				) : undefined
			}
			title={title}
		>
			<SettingsCard className="flex flex-col gap-4">
				{error ? <ErrorLine message={error} /> : null}
				<div className="grid gap-3 sm:grid-cols-2">
					<div className="flex items-center justify-between gap-3">
						<div>
							<Label htmlFor="rules-enabled">Enable rules</Label>
							<p className="text-muted-foreground text-xs">
								Use rules for this agent.
							</p>
						</div>
						<Checkbox
							checked={config.enabled}
							disabled={locked}
							id="rules-enabled"
							onCheckedChange={(value) => update({ enabled: value === true })}
						/>
					</div>
					<div className="flex items-center justify-between gap-3">
						<div>
							<Label htmlFor="rules-auto-inject">Auto-injected context</Label>
							<p className="text-muted-foreground text-xs">
								Inject matching rules automatically.
							</p>
						</div>
						<Checkbox
							checked={config.autoInject}
							disabled={locked}
							id="rules-auto-inject"
							onCheckedChange={(value) =>
								update({ autoInject: value === true })
							}
						/>
					</div>
				</div>
				<div className="grid gap-3 sm:grid-cols-2">
					<div className="flex flex-col gap-1">
						<Label htmlFor="rules-apply-mode">Apply mode</Label>
						<Select<RuleApplyMode>
							disabled={locked}
							items={APPLY_MODE_ITEMS}
							onValueChange={(value) => update({ applyMode: value ?? "auto" })}
							value={config.applyMode}
						>
							<SelectTrigger id="rules-apply-mode">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{APPLY_MODE_ITEMS.map((item) => (
									<SelectItem key={item.value} value={item.value}>
										{item.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="flex flex-col gap-1">
						<Label htmlFor="rules-turns">Turns per plan</Label>
						<Input
							disabled={locked}
							id="rules-turns"
							min={0}
							onChange={(event) =>
								update({
									turnsPerPlan: Math.max(
										0,
										Number.parseInt(event.target.value, 10) || 0
									),
								})
							}
							type="number"
							value={config.turnsPerPlan}
						/>
						<p className="text-muted-foreground text-xs">
							0 applies on every turn.
						</p>
					</div>
				</div>
				<div className="flex flex-col gap-2 border-t pt-4">
					<div className="flex items-center justify-between">
						<div>
							<p className="font-medium text-sm">Agent base rules</p>
							<p className="text-muted-foreground text-xs">
								These rules belong to this agent and are stored on Ryu.
							</p>
						</div>
						<Button
							disabled={locked}
							onClick={() =>
								update({
									rules: [...config.rules, newRule(config.rules.length)],
								})
							}
							size="sm"
							variant="ghost"
						>
							<HugeiconsIcon className="size-4" icon={Add01Icon} />
							Add rule
						</Button>
					</div>
					{config.rules.length === 0 ? (
						<p className="text-muted-foreground text-xs">No agent rules yet.</p>
					) : null}
					{config.rules.map((rule) => (
						<div
							className="flex flex-col gap-2 rounded-lg border p-3"
							key={rule.id}
						>
							<div className="flex items-center gap-2">
								<Checkbox
									aria-label={tl("Enable rule {id}", { id: rule.id })}
									checked={rule.enabled}
									disabled={locked}
									onCheckedChange={(value) =>
										updateRule(rule.id, { enabled: value === true })
									}
								/>
								<Input
									aria-label="Rule text"
									disabled={locked}
									onChange={(event) =>
										updateRule(rule.id, { text: event.target.value })
									}
									placeholder="e.g. Always cite your sources"
									value={rule.text}
								/>
								<Button
									aria-label="Delete rule"
									disabled={locked}
									onClick={() =>
										update({
											rules: config.rules.filter((item) => item.id !== rule.id),
										})
									}
									size="icon-sm"
									variant="ghost"
								>
									<HugeiconsIcon className="size-4" icon={Delete01Icon} />
								</Button>
							</div>
							<div className="flex items-center gap-2">
								<Label htmlFor={`rule-mode-${rule.id}`} size="compact">
									Mode
								</Label>
								<Select<RuleApplyMode>
									disabled={locked}
									items={APPLY_MODE_ITEMS}
									onValueChange={(value) =>
										updateRule(rule.id, {
											mode: value ?? "auto",
										})
									}
									value={rule.mode}
								>
									<SelectTrigger
										className="h-8 w-32"
										id={`rule-mode-${rule.id}`}
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{APPLY_MODE_ITEMS.map((item) => (
											<SelectItem key={item.value} value={item.value}>
												{item.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						</div>
					))}
				</div>
				<div className="border-t pt-4">
					<ProjectRules cwd={cwd} rules={projectRules} />
				</div>
				{loading ? (
					<div className="flex items-center gap-2 text-muted-foreground text-xs">
						<HugeiconsIcon
							className="size-3 animate-spin"
							icon={Refresh01Icon}
						/>
						Loading rules…
					</div>
				) : null}
			</SettingsCard>
		</SettingsSection>
	);
}
