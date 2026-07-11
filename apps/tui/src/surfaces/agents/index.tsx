/* @jsxImportSource @opentui/react */
// Agents surface - the desktop-mirrored /agents page. It regroups the legacy
// src/tabs/agents.tsx master-detail content into the desktop AgentsPage
// information architecture (a titled page with a list + detail, plus New/Edit
// affordances) and adds an inline edit view that echoes the desktop
// /agents/:id/edit route: pressing `e` (or `n` for a new agent) opens that path
// via useWorkspace().openTab, and this same surface renders the edit form because
// its match() owns the /agents/ prefix.
//
// Data/fetch logic is reused unchanged from the legacy tab and the typed
// @ryuhq/core-client/agents module (fetchAgents / fetchAgent / createAgent /
// updateAgent). No new fetch paths are introduced.

import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import {
	type Agent,
	type AgentInput,
	type AgentSummary,
	bumpPatchVersion,
	createAgent,
	fetchAgent,
	fetchAgents,
	updateAgent,
} from "@ryuhq/core-client/agents";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { Badge } from "@/components/ui/badge.tsx";
import { StatusMessage } from "@/components/ui/status-message.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../../core/CoreContext.tsx";
import { useSetInputFocused } from "../../core/InputFocusContext.tsx";
import { ErrorView } from "../../ui/ErrorView.tsx";
import { Loading } from "../../ui/Loading.tsx";
import { useToast } from "../../ui/toast.tsx";
import type { SurfaceModule, SurfaceProps } from "../../workspace/router.ts";
import { useWorkspace } from "../../workspace/WorkspaceContext.tsx";

const LIST_HEIGHT = 16;
const LABEL_WIDTH = 12;
const AGENT_EDIT_RE = /^\/agents\/([^/]+)\/edit$/;

type Theme = ReturnType<typeof useTheme>;

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function padLabel(label: string): string {
	return label.padEnd(LABEL_WIDTH, " ");
}

/** Extract the agent id from an edit path (`/agents/:id/edit`), or null when the
 * path is the plain list route. `new` is a valid sentinel meaning "create". */
function parseEditId(path: string): string | null {
	const match = AGENT_EDIT_RE.exec(path);
	return match?.[1] ?? null;
}

// A page header echoing the desktop page chrome: a bold title, a muted subtitle,
// and a muted key-hint line so the surface is self-describing without the shell.
function PageHeader({
	title,
	subtitle,
	hint,
}: {
	hint: string;
	subtitle: string;
	title: string;
}) {
	const theme = useTheme();
	return (
		<box flexDirection="column" paddingLeft={1} paddingTop={1}>
			<text fg={theme.colors.foreground}>
				<b>{title}</b>
			</text>
			<text fg={theme.colors.mutedForeground}>{subtitle}</text>
			<text fg={theme.colors.mutedForeground}>{hint}</text>
		</box>
	);
}

function AgentsSurface({ active, paneId }: SurfaceProps) {
	const { focusedPaneId, tabs, panes, openTab, closeTab } = useWorkspace();
	const focused = active && focusedPaneId === paneId;

	// Derive this instance's path from the pane's active tab, so one surface can
	// render either the list route or the /agents/:id/edit route.
	const pane = panes.find((p) => p.id === paneId);
	const activeTab = tabs.find((t) => t.id === pane?.activeTabId);
	const path = activeTab?.path ?? "/agents";
	const editId = parseEditId(path);

	if (editId !== null) {
		return (
			<AgentEditView
				agentId={editId}
				focused={focused}
				onClose={() => {
					openTab("/agents");
					if (activeTab) {
						closeTab(activeTab.id);
					}
				}}
			/>
		);
	}

	return (
		<AgentsListView
			focused={focused}
			onEdit={(agent) =>
				openTab(`/agents/${agent.id}/edit`, { title: agent.name })
			}
			onNew={() => openTab("/agents/new/edit", { title: "New agent" })}
		/>
	);
}

// ── List + detail view (the /agents page) ────────────────────────────────────

function AgentsListView({
	focused,
	onNew,
	onEdit,
}: {
	focused: boolean;
	onEdit: (agent: AgentSummary) => void;
	onNew: () => void;
}) {
	const { target, url, token } = useCore();
	const theme = useTheme();

	const [agents, setAgents] = useState<AgentSummary[]>([]);
	const [index, setIndex] = useState(0);
	const [loading, setLoading] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const [detail, setDetail] = useState<Agent | null>(null);
	const [detailLoading, setDetailLoading] = useState(false);
	const [detailError, setDetailError] = useState<string | null>(null);

	const listReqRef = useRef(0);
	const detailReqRef = useRef(0);

	const loadAgents = useCallback(() => {
		const reqId = ++listReqRef.current;
		setLoading(true);
		setError(null);
		fetchAgents(target)
			.then((next) => {
				if (listReqRef.current !== reqId) {
					return;
				}
				setAgents(next);
				setIndex((i) => (next.length === 0 ? 0 : Math.min(i, next.length - 1)));
				setDetail(null);
				setDetailError(null);
				setLoaded(true);
			})
			.catch((err: unknown) => {
				if (listReqRef.current !== reqId) {
					return;
				}
				setError(errText(err));
				setLoaded(true);
			})
			.finally(() => {
				if (listReqRef.current === reqId) {
					setLoading(false);
				}
			});
	}, [target]);

	// Lazy first load on focus; reload on node switch (url/token primitives).
	useEffect(() => {
		if (focused) {
			loadAgents();
		}
	}, [focused, loadAgents]);

	const selected = agents[index];

	const loadDetail = useCallback(() => {
		if (!selected) {
			return;
		}
		const reqId = ++detailReqRef.current;
		setDetail(null);
		setDetailError(null);
		setDetailLoading(true);
		fetchAgent(target, selected.id)
			.then((d) => {
				if (detailReqRef.current === reqId) {
					setDetail(d);
				}
			})
			.catch((err: unknown) => {
				if (detailReqRef.current === reqId) {
					setDetailError(`Failed to load detail: ${errText(err)}`);
				}
			})
			.finally(() => {
				if (detailReqRef.current === reqId) {
					setDetailLoading(false);
				}
			});
	}, [target, selected]);

	const move = useCallback((delta: number, count: number) => {
		setDetail(null);
		setDetailError(null);
		setIndex((i) => Math.min(Math.max(0, count - 1), Math.max(0, i + delta)));
	}, []);

	useKeyboard((key: KeyEvent) => {
		if (!focused) {
			return;
		}
		if (key.name === "up" || key.name === "k") {
			move(-1, agents.length);
		} else if (key.name === "down" || key.name === "j") {
			move(1, agents.length);
		} else if (key.name === "return") {
			loadDetail();
		} else if (key.name === "r") {
			loadAgents();
		} else if (key.name === "n") {
			onNew();
		} else if (key.name === "e" && selected) {
			onEdit(selected);
		}
	});

	if (loading && !loaded) {
		return <Loading label="Loading agents…" />;
	}
	if (error) {
		return <ErrorView message={error} />;
	}

	return (
		<box flexDirection="column" flexGrow={1}>
			<PageHeader
				hint="n new · e edit · Enter detail · r reload · j/k move"
				subtitle={`${agents.length} configured`}
				title="Agents"
			/>
			{agents.length === 0 ? (
				<box paddingLeft={1} paddingTop={1}>
					<text fg={theme.colors.mutedForeground}>
						no agents configured — press n to create one
					</text>
				</box>
			) : (
				<box flexDirection="row" flexGrow={1} gap={1} padding={1}>
					<AgentList agents={agents} selectedIndex={index} theme={theme} />
					<AgentDetail
						agent={selected}
						detail={detail}
						error={detailError}
						loading={detailLoading}
						theme={theme}
					/>
				</box>
			)}
		</box>
	);
}

function AgentList({
	agents,
	selectedIndex,
	theme,
}: {
	agents: AgentSummary[];
	selectedIndex: number;
	theme: Theme;
}) {
	const start = Math.max(
		0,
		Math.min(
			selectedIndex - Math.floor(LIST_HEIGHT / 2),
			Math.max(0, agents.length - LIST_HEIGHT)
		)
	);
	const visible = agents.slice(start, start + LIST_HEIGHT);
	return (
		<box
			borderColor={theme.colors.border}
			borderStyle="rounded"
			flexBasis={0}
			flexDirection="column"
			flexGrow={2}
			paddingLeft={1}
			paddingRight={1}
		>
			<text fg={theme.colors.mutedForeground}>agents</text>
			{visible.map((agent, i) => (
				<AgentRow
					agent={agent}
					key={agent.id}
					selected={start + i === selectedIndex}
					theme={theme}
					top={i === 0}
				/>
			))}
			{agents.length > visible.length ? (
				<text fg={theme.colors.mutedForeground}>
					{`${selectedIndex + 1}/${agents.length}`}
				</text>
			) : null}
		</box>
	);
}

function AgentRow({
	agent,
	selected,
	theme,
	top,
}: {
	agent: AgentSummary;
	selected: boolean;
	theme: Theme;
	top: boolean;
}) {
	return (
		<box flexDirection="column" marginTop={top ? 1 : 0}>
			<box flexDirection="row" gap={1}>
				<text fg={selected ? theme.colors.accent : theme.colors.muted}>
					{selected ? "›" : " "}
				</text>
				<text fg={selected ? theme.colors.accent : theme.colors.foreground}>
					{selected ? <b>{agent.name}</b> : agent.name}
				</text>
			</box>
			<box flexDirection="row" gap={1} paddingLeft={2}>
				{agent.engine ? (
					<text fg={theme.colors.mutedForeground}>{agent.engine}</text>
				) : null}
				{agent.transport ? (
					<Badge bordered={false} variant="secondary">
						{agent.transport}
					</Badge>
				) : null}
				{agent.installed === false ? (
					<text fg={theme.colors.error}>!</text>
				) : null}
			</box>
		</box>
	);
}

function AgentDetail({
	agent,
	detail,
	loading,
	error,
	theme,
}: {
	agent: AgentSummary | undefined;
	detail: Agent | null;
	error: string | null;
	loading: boolean;
	theme: Theme;
}) {
	return (
		<box
			borderColor={theme.colors.border}
			borderStyle="rounded"
			flexBasis={0}
			flexDirection="column"
			flexGrow={3}
			paddingLeft={1}
			paddingRight={1}
		>
			<text fg={theme.colors.mutedForeground}>attributes</text>
			<DetailBody
				agent={agent}
				detail={detail}
				error={error}
				loading={loading}
				theme={theme}
			/>
		</box>
	);
}

function DetailBody({
	agent,
	detail,
	loading,
	error,
	theme,
}: {
	agent: AgentSummary | undefined;
	detail: Agent | null;
	error: string | null;
	loading: boolean;
	theme: Theme;
}) {
	if (loading) {
		return (
			<box paddingTop={1}>
				<StatusMessage variant="loading">loading…</StatusMessage>
			</box>
		);
	}
	if (error) {
		return (
			<box paddingTop={1}>
				<text fg={theme.colors.error}>{error}</text>
			</box>
		);
	}
	if (!agent) {
		return null;
	}

	const routingLabel =
		agent.gatewayBypass === true ? "direct (gateway bypass)" : "via gateway";
	const detailMatches = detail !== null && detail.id === agent.id;

	return (
		<box flexDirection="column" paddingTop={1}>
			<KvRow label="name" theme={theme}>
				<text fg={theme.colors.foreground}>
					<b>{agent.name}</b>
				</text>
			</KvRow>
			<KvRow label="engine" theme={theme}>
				<text fg={theme.colors.accent}>{agent.engine ?? "—"}</text>
			</KvRow>
			<KvRow label="model" theme={theme}>
				<text fg={theme.colors.foreground}>{agent.model ?? "—"}</text>
			</KvRow>
			<KvRow label="routing" theme={theme}>
				<text fg={theme.colors.foreground}>{routingLabel}</text>
			</KvRow>
			{agent.transport ? (
				<KvRow label="transport" theme={theme}>
					<text fg={theme.colors.foreground}>{agent.transport}</text>
				</KvRow>
			) : null}
			<box flexDirection="column" paddingTop={1}>
				{detailMatches && detail ? (
					<ToolsList theme={theme} tools={detail.tools} />
				) : (
					<text fg={theme.colors.mutedForeground}>
						{padLabel("tools")}press enter to load
					</text>
				)}
			</box>
			{agent.description ? (
				<box paddingTop={1}>
					<KvRow label="desc" theme={theme}>
						<text fg={theme.colors.mutedForeground}>{agent.description}</text>
					</KvRow>
				</box>
			) : null}
			<box paddingTop={1}>
				<text fg={theme.colors.mutedForeground}>press e to edit</text>
			</box>
		</box>
	);
}

function ToolsList({ tools, theme }: { theme: Theme; tools: string[] }) {
	return (
		<box flexDirection="column">
			<text fg={theme.colors.mutedForeground}>tools</text>
			{tools.length === 0 ? (
				<text fg={theme.colors.mutedForeground}> (none configured)</text>
			) : (
				tools.map((tool) => (
					<text fg={theme.colors.foreground} key={tool}>{` • ${tool}`}</text>
				))
			)}
		</box>
	);
}

function KvRow({
	label,
	children,
	theme,
}: {
	children: ReactNode;
	label: string;
	theme: Theme;
}) {
	return (
		<box flexDirection="row" gap={1}>
			<text fg={theme.colors.mutedForeground}>{padLabel(label)}</text>
			{children}
		</box>
	);
}

// ── Edit view (the /agents/:id/edit route) ───────────────────────────────────

type FieldKey = "name" | "engine" | "description" | "systemPrompt";

interface FieldDef {
	key: FieldKey;
	label: string;
	placeholder: string;
}

function AgentEditView({
	agentId,
	focused,
	onClose,
}: {
	agentId: string;
	focused: boolean;
	onClose: () => void;
}) {
	const { target, url, token } = useCore();
	const theme = useTheme();
	const { notify } = useToast();
	const setInputFocused = useSetInputFocused();

	const isNew = agentId === "new";

	const [existing, setExisting] = useState<Agent | null>(null);
	const [name, setName] = useState("");
	const [engine, setEngine] = useState("");
	const [description, setDescription] = useState("");
	const [systemPrompt, setSystemPrompt] = useState("");
	const [fieldIndex, setFieldIndex] = useState(0);
	const [loading, setLoading] = useState(!isNew);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const savingRef = useRef(false);
	savingRef.current = saving;

	// The editable fields; a new agent also needs an engine binding, an existing
	// agent keeps its engine (edited via the dedicated engine flow, not here).
	const fields: FieldDef[] = isNew
		? [
				{ key: "name", label: "name", placeholder: "Agent name" },
				{
					key: "engine",
					label: "engine",
					placeholder: "Engine id, e.g. acp:claude",
				},
				{ key: "description", label: "desc", placeholder: "Short description" },
				{
					key: "systemPrompt",
					label: "prompt",
					placeholder: "System prompt",
				},
			]
		: [
				{ key: "name", label: "name", placeholder: "Agent name" },
				{ key: "description", label: "desc", placeholder: "Short description" },
				{
					key: "systemPrompt",
					label: "prompt",
					placeholder: "System prompt",
				},
			];

	const loadRecord = useCallback(() => {
		if (isNew) {
			return;
		}
		setLoading(true);
		setError(null);
		fetchAgent(target, agentId)
			.then((record) => {
				setExisting(record);
				setName(record.name);
				setEngine(record.engine ?? "");
				setDescription(record.description ?? "");
				setSystemPrompt(record.systemPrompt ?? "");
			})
			.catch((err: unknown) => setError(errText(err)))
			.finally(() => setLoading(false));
	}, [target, agentId, isNew]);

	// Load on focus; reload on node switch (url/token primitives).
	useEffect(() => {
		if (focused) {
			loadRecord();
		}
	}, [focused, loadRecord]);

	// Own raw input while focused so the shell's plain-key globals stay quiet.
	useEffect(() => {
		setInputFocused(focused);
		return () => setInputFocused(false);
	}, [focused, setInputFocused]);

	const save = useCallback(() => {
		if (savingRef.current) {
			return;
		}
		if (name.trim().length === 0) {
			setError("Name is required");
			return;
		}
		const engineValue = isNew
			? engine.trim() || null
			: (existing?.engine ?? null);
		const input: AgentInput = {
			name: name.trim(),
			description: description.trim() || null,
			systemPrompt: systemPrompt.trim() || null,
			engine: engineValue,
			tools: existing?.tools ?? [],
			skills: existing?.skills ?? [],
			composioActions: existing?.composioActions ?? [],
			orchestrator: existing?.orchestrator ?? undefined,
			canCreateAgents: existing?.canCreateAgents ?? undefined,
			version: existing?.version
				? bumpPatchVersion(existing.version)
				: undefined,
		};
		setSaving(true);
		setError(null);
		const request = isNew
			? createAgent(target, input)
			: updateAgent(target, agentId, input);
		request
			.then(() => {
				notify(isNew ? "Agent created" : "Agent saved", "success");
				onClose();
			})
			.catch((err: unknown) => setError(errText(err)))
			.finally(() => setSaving(false));
	}, [
		target,
		agentId,
		isNew,
		name,
		engine,
		description,
		systemPrompt,
		existing,
		notify,
		onClose,
	]);

	useKeyboard((key: KeyEvent) => {
		if (!focused) {
			return;
		}
		if (key.ctrl && key.name === "s") {
			save();
		} else if (key.name === "escape") {
			onClose();
		} else if (key.name === "tab" && key.shift) {
			setFieldIndex((i) => (i - 1 + fields.length) % fields.length);
		} else if (key.name === "tab") {
			setFieldIndex((i) => (i + 1) % fields.length);
		}
	});

	if (loading) {
		return <Loading label="Loading agent…" />;
	}

	const valueFor = (k: FieldKey): string => {
		if (k === "name") {
			return name;
		}
		if (k === "engine") {
			return engine;
		}
		if (k === "description") {
			return description;
		}
		return systemPrompt;
	};

	const setterFor = (k: FieldKey): ((v: string) => void) => {
		if (k === "name") {
			return setName;
		}
		if (k === "engine") {
			return setEngine;
		}
		if (k === "description") {
			return setDescription;
		}
		return setSystemPrompt;
	};

	return (
		<box flexDirection="column" flexGrow={1}>
			<PageHeader
				hint="Tab move field · Ctrl+S save · Esc cancel"
				subtitle={isNew ? "Create a new agent" : (existing?.id ?? agentId)}
				title={isNew ? "New agent" : name.trim() || "Edit agent"}
			/>
			<box flexDirection="column" gap={1} padding={1}>
				{fields.map((field, i) => (
					<EditField
						focused={focused && fieldIndex === i}
						key={field.key}
						label={field.label}
						onChange={setterFor(field.key)}
						placeholder={field.placeholder}
						theme={theme}
						value={valueFor(field.key)}
					/>
				))}
				{error ? <StatusMessage variant="error">{error}</StatusMessage> : null}
				{saving ? (
					<StatusMessage variant="loading">saving…</StatusMessage>
				) : null}
			</box>
		</box>
	);
}

function EditField({
	label,
	value,
	onChange,
	placeholder,
	focused,
	theme,
}: {
	focused: boolean;
	label: string;
	onChange: (v: string) => void;
	placeholder: string;
	theme: Theme;
	value: string;
}) {
	return (
		<box flexDirection="column">
			<text fg={focused ? theme.colors.primary : theme.colors.mutedForeground}>
				{label}
			</text>
			<box
				borderColor={focused ? theme.colors.focusRing : theme.colors.border}
				borderStyle="rounded"
				paddingLeft={1}
				paddingRight={1}
			>
				<input
					cursorColor={theme.colors.primary}
					focused={focused}
					onChange={onChange}
					placeholder={placeholder}
					placeholderColor={theme.colors.mutedForeground}
					textColor={theme.colors.foreground}
					value={value}
				/>
			</box>
		</box>
	);
}

/** The Agents surface module. Owns the /agents list route and the
 * /agents/:id/edit route (including /agents/new/edit). */
export const agentsSurface: SurfaceModule = {
	id: "agents",
	title: "Agents",
	match: (path) => path === "/agents" || path.startsWith("/agents/"),
	Component: AgentsSurface,
};
