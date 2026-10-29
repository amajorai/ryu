import { useLocalizedString } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { NativeSelect } from "@ryu/ui/components/native-select.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import {
	isNativeBoolean,
	isNativeNumber,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { z } from "zod";
import { McpFormFields } from "@/src/components/chat/McpForms.tsx";
import {
	type FormField,
	validateFormValues,
} from "@/src/components/chat/mcp-form-schema.ts";
import { type AgentSummary, fetchAgents } from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { callMcpTool, fetchMcpTools } from "@/src/lib/api/mcp.ts";
import type { PluginCompanion } from "@/src/lib/api/plugins.ts";
import {
	changedMcpSettings,
	confirmedMcpSettingsChanges,
	type McpSettingsData,
	type McpSettingValue,
	mcpSettingsActionText,
	mcpSettingsResultStatus,
	parseMcpSettings,
} from "@/src/lib/mcp-settings.ts";

const McpAppPanel = lazy(async () => ({
	default: (await import("@/src/contributions/host/McpAppPanel.tsx"))
		.McpAppPanel,
}));

export function McpSettingsPanel({
	target,
	settings,
	plugin,
}: {
	target: ApiTarget;
	settings: { readTool: string; updateTool: string; serverId?: string };
	plugin: string;
}) {
	const copy = {
		agent: useLocalizedString("Agent for plugin access"),
		chooseAgent: useLocalizedString("Select an agent"),
		loadingAgents: useLocalizedString("Loading agents…"),
		noAgents: useLocalizedString(
			"Add an agent with access to this plugin to configure its settings."
		),
		loadingSettings: useLocalizedString("Loading settings…"),
		save: useLocalizedString("Save settings"),
		saved: useLocalizedString("Settings saved"),
		modalDescription: useLocalizedString(
			"Configure this plugin using its own interface."
		),
		loadAgentsError: useLocalizedString("Unable to load agents"),
		readError: useLocalizedString("Unable to read plugin settings"),
		saveError: useLocalizedString("Unable to save plugin settings"),
		actionError: useLocalizedString("Unable to run settings action"),
		actionUnavailable: useLocalizedString(
			"This settings action is unavailable to the selected agent"
		),
		actionFailed: useLocalizedString(
			"The plugin reported that its settings action failed"
		),
		saveFailed: useLocalizedString(
			"The plugin reported that saving its settings failed"
		),
		actionCompleted: useLocalizedString("Action completed"),
		loadingInterface: useLocalizedString("Loading plugin interface…"),
		settingsLabel: useLocalizedString("Settings"),
		otherSettings: useLocalizedString("Other settings"),
		authorizationRequired: useLocalizedString(
			"Additional approval or authentication is required before this action can complete."
		),
		unconfirmedSave: useLocalizedString(
			"The plugin has not applied the requested changes. Try again."
		),
	};
	const copyRef = useRef(copy);
	copyRef.current = copy;
	const [agents, setAgents] = useState<AgentSummary[]>([]);
	const [agentsLoading, setAgentsLoading] = useState(true);
	const [agentId, setAgentId] = useState("");
	const [data, setData] = useState<McpSettingsData>();
	const [values, setValues] = useState<Record<string, McpSettingValue>>({});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const [saved, setSaved] = useState(false);
	const [actionOutput, setActionOutput] = useState<string>();
	const [actionCompanion, setActionCompanion] = useState<PluginCompanion>();
	const scope = JSON.stringify([
		target.url,
		target.token,
		target.userJwt,
		plugin,
		settings.readTool,
		settings.updateTool,
		agentId,
	]);
	const scopeRef = useRef(scope);
	scopeRef.current = scope;
	useEffect(() => {
		const controller = new AbortController();
		setAgents([]);
		setAgentsLoading(true);
		setAgentId("");
		setData(undefined);
		setError(undefined);
		setActionCompanion(undefined);
		setActionOutput(undefined);
		fetchAgents(target, controller.signal)
			.then((rows) => {
				if (!controller.signal.aborted) {
					setAgents(rows);
				}
			})
			.catch((failure) => {
				if (!controller.signal.aborted) {
					setError(
						failure instanceof Error
							? failure.message
							: copyRef.current.loadAgentsError
					);
				}
			})
			.finally(() => {
				if (!controller.signal.aborted) {
					setAgentsLoading(false);
				}
			});
		return () => controller.abort();
	}, [target.url, target.token, target.userJwt]);
	const load = useCallback(async () => {
		if (!agentId) {
			return;
		}
		const response = await callMcpTool(target, {
			tool: settings.readTool,
			agentId,
			arguments: {},
		});
		if (!response.ok) {
			throw new Error(response.error ?? copyRef.current.readError);
		}
		const status = mcpSettingsResultStatus(response.output);
		if (status === "pending") {
			throw new Error(copyRef.current.authorizationRequired);
		}
		if (status === "failed") {
			throw new Error(
				mcpSettingsActionText(response.output) ?? copyRef.current.readError
			);
		}
		const next = parseMcpSettings(response.output);
		return next;
	}, [agentId, target.url, target.token, target.userJwt, settings.readTool]);
	useEffect(() => {
		setData(undefined);
		setSaved(false);
		setError(undefined);
		if (!agentId) {
			setBusy(false);
			return;
		}
		let current = true;
		setBusy(true);
		void load()
			.then((next) => {
				if (current && next) {
					setData(next);
					setValues(next.values);
				}
			})
			.catch((failure) => {
				if (current) {
					setError(
						failure instanceof Error
							? failure.message
							: copyRef.current.readError
					);
				}
			})
			.finally(() => {
				if (current) {
					setBusy(false);
				}
			});
		return () => {
			current = false;
		};
	}, [load, agentId]);
	const fields = useMemo<FormField[]>(
		() =>
			(data?.fields ?? []).map((field) => ({
				...field,
				name: field.key,
				required: false,
				choices: (field.enum ?? []).map((value) => ({ value, label: value })),
			})),
		[data]
	);
	const changes = data ? changedMcpSettings(data, values) : {};
	const changeValues = (next: Record<string, McpSettingValue | string[]>) => {
		const primitives: Record<string, McpSettingValue> = {};
		for (const [key, value] of Object.entries(next)) {
			if (
				isNativeText(value) ||
				isNativeNumber(value) ||
				isNativeBoolean(value)
			) {
				primitives[key] = value;
			}
		}
		setValues(primitives);
		setSaved(false);
	};
	const runAction = async (toolName: string, title: string) => {
		if (!agentId || busy) {
			return;
		}
		setBusy(true);
		const actionScope = scopeRef.current;
		setError(undefined);
		setActionOutput(undefined);
		try {
			const tools = await fetchMcpTools(target, agentId);
			if (scopeRef.current !== actionScope) {
				return;
			}
			const tool = tools.find(
				(entry) =>
					entry.server === (settings.serverId ?? plugin) &&
					entry.name === toolName
			);
			if (!tool) {
				throw new Error(copyRef.current.actionUnavailable);
			}
			const parsedMeta = z
				.object({ ui: z.object({ resourceUri: z.string() }) })
				.safeParse(tool.meta);
			if (parsedMeta.success) {
				setActionCompanion({
					id: `mcp__${tool.id}`,
					mcpToolId: tool.id,
					pluginId: plugin,
					label: title,
					name: title,
					approvedGrants: [],
					hasUi: true,
					defaultCspEnforced: true,
				});
				return;
			}
			const response = await callMcpTool(target, {
				tool: tool.id,
				agentId,
				arguments: {},
			});
			if (scopeRef.current !== actionScope) {
				return;
			}
			if (!response.ok) {
				throw new Error(response.error ?? copyRef.current.actionError);
			}
			const status = mcpSettingsResultStatus(response.output);
			if (status === "pending") {
				throw new Error(copyRef.current.authorizationRequired);
			}
			if (status === "failed") {
				throw new Error(
					mcpSettingsActionText(response.output) ?? copyRef.current.actionFailed
				);
			}
			setActionOutput(
				mcpSettingsActionText(response.output) ??
					copyRef.current.actionCompleted
			);
		} catch (failure) {
			if (scopeRef.current !== actionScope) {
				return;
			}
			setError(
				failure instanceof Error ? failure.message : copyRef.current.actionError
			);
		} finally {
			if (scopeRef.current === actionScope) {
				setBusy(false);
			}
		}
	};
	const save = async () => {
		if (!data || busy || Object.keys(changes).length === 0) {
			return;
		}
		const invalid = validateFormValues(fields, values);
		if (invalid) {
			setError(invalid);
			return;
		}
		setBusy(true);
		const saveScope = scopeRef.current;
		setError(undefined);
		setSaved(false);
		try {
			const response = await callMcpTool(target, {
				tool: settings.updateTool,
				agentId,
				arguments: { set: changes },
			});
			if (scopeRef.current !== saveScope) {
				return;
			}
			if (!response.ok) {
				throw new Error(response.error ?? copyRef.current.saveError);
			}
			const status = mcpSettingsResultStatus(response.output);
			if (status === "pending") {
				throw new Error(copyRef.current.authorizationRequired);
			}
			if (status === "failed") {
				throw new Error(
					mcpSettingsActionText(response.output) ?? copyRef.current.saveFailed
				);
			}
			const next = await load();
			if (scopeRef.current !== saveScope) {
				return;
			}
			if (!(next && confirmedMcpSettingsChanges(next, changes))) {
				throw new Error(copyRef.current.unconfirmedSave);
			}
			if (next) {
				setData(next);
				setValues(next.values);
			}
			setSaved(true);
		} catch (failure) {
			if (scopeRef.current !== saveScope) {
				return;
			}
			setError(
				failure instanceof Error ? failure.message : copyRef.current.saveError
			);
		} finally {
			if (scopeRef.current === saveScope) {
				setBusy(false);
			}
		}
	};
	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-2">
				<Label htmlFor={`mcp-settings-agent-${plugin}`}>{copy.agent}</Label>
				<NativeSelect
					disabled={busy || agentsLoading || agents.length === 0}
					id={`mcp-settings-agent-${plugin}`}
					onChange={(event) => setAgentId(event.target.value)}
					value={agentId}
				>
					<option value="">{copy.chooseAgent}</option>
					{agents.map((agent) => (
						<option key={agent.id} value={agent.id}>
							{agent.name}
						</option>
					))}
				</NativeSelect>
			</div>
			{agentsLoading ? (
				<p
					className="flex items-center gap-2 text-muted-foreground text-sm"
					role="status"
				>
					<Spinner />
					{copy.loadingAgents}
				</p>
			) : agents.length === 0 && !error ? (
				<p className="text-muted-foreground text-sm" role="status">
					{copy.noAgents}
				</p>
			) : null}
			{error ? (
				<p className="text-sm text-status-destructive" role="alert">
					{error}
				</p>
			) : null}
			{busy && !data ? (
				<p className="text-muted-foreground text-sm" role="status">
					{copy.loadingSettings}
				</p>
			) : null}
			{data ? (
				<form
					className="flex flex-col gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						void save();
					}}
				>
					{data.groups.map((group, index) => (
						<div
							className="flex flex-col gap-4"
							key={`${index}:${group.title}`}
						>
							<h3 className="font-medium text-sm">
								{group.generated === "other"
									? copy.otherSettings
									: group.generated === "settings"
										? copy.settingsLabel
										: group.title}
							</h3>
							{group.items.map((item) =>
								item.kind === "property" ? (
									<McpFormFields
										disabled={busy}
										fields={fields.filter(
											(field) => field.name === item.property
										)}
										id={`settings-${plugin}`}
										key={item.property}
										onChange={changeValues}
										values={values}
									/>
								) : (
									<div
										className="flex flex-col gap-2"
										key={`tool:${item.tool}`}
									>
										<Button
											disabled={busy}
											onClick={() => void runAction(item.tool, item.title)}
											type="button"
											variant="outline"
										>
											{item.title}
										</Button>
										{item.description ? (
											<p className="text-muted-foreground text-xs">
												{item.description}
											</p>
										) : null}
									</div>
								)
							)}
						</div>
					))}
					<div className="flex items-center gap-3">
						<Button
							disabled={busy || !Object.keys(changes).length}
							type="submit"
						>
							{copy.save}
						</Button>
						{saved ? (
							<span className="text-sm text-status-success" role="status">
								{copy.saved}
							</span>
						) : null}
					</div>
				</form>
			) : null}
			{actionOutput ? (
				<p className="whitespace-pre-wrap text-sm" role="status">
					{actionOutput}
				</p>
			) : null}
			<Dialog
				onOpenChange={(open) => {
					if (!open) {
						setActionCompanion(undefined);
					}
				}}
				open={!!actionCompanion}
			>
				<DialogContent className="h-[min(40rem,85vh)] max-w-4xl">
					<DialogHeader>
						<DialogTitle>{actionCompanion?.label}</DialogTitle>
						<DialogDescription>{copy.modalDescription}</DialogDescription>
					</DialogHeader>
					<div className="min-h-0 flex-1">
						{actionCompanion ? (
							<Suspense
								fallback={
									<p
										className="flex items-center gap-2 text-muted-foreground text-sm"
										role="status"
									>
										<Spinner />
										{copy.loadingInterface}
									</p>
								}
							>
								<McpAppPanel companion={actionCompanion} />
							</Suspense>
						) : null}
					</div>
				</DialogContent>
			</Dialog>
		</div>
	);
}
