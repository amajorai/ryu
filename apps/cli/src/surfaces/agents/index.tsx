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
import { useKeyboard, useRenderer } from "@opentui/react";
import {
	type Agent,
	type AgentIdentityMode,
	type AgentInput,
	type AgentSummary,
	bumpPatchVersion,
	createAgent,
	fetchAgent,
	fetchAgents,
	launchCheck,
	updateAgent,
} from "@ryuhq/core-client/agents";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { request } from "@ryuhq/core-client/client";
import { samplingConfigSchema } from "@ryuhq/core-client/inference";
import type { McpTool } from "@ryuhq/core-client/mcp";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { z } from "zod";
import { Badge } from "@/components/ui/badge.tsx";
import { Divider } from "@/components/ui/divider.tsx";
import { StatusMessage } from "@/components/ui/status-message.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import {
	type AccountCatalogCore,
	type AvailableAccounts,
	accountCatalogLoadFailed,
	accountLimitStartBlocked,
	accountPickerRows,
	loadAvailableAccounts,
	toggleAccountAccess,
} from "../../core/agentAccountCatalog.ts";
import {
	ACCOUNT_KEY_FORMATS,
	AGENT_IDENTITY_MODE_OPTIONS,
	AGENT_IDENTITY_MODE_ORDER,
	accountAccessHeadline,
	addAccountKeys,
	identityModeLabel,
	isRemotePeerEngine,
	parseAccountKey,
	REMOTE_PEER_IDENTITY_NOTE,
	RYU_ENGINE_ID,
	removeAccountKeys,
	stepIdentityMode,
} from "../../core/agentIdentity.ts";
import { useCore } from "../../core/CoreContext.tsx";
import {
	useInputFocused,
	useSetInputFocused,
	useShellKeyboardCaptured,
} from "../../core/InputFocusContext.tsx";
import { HINT, hintText } from "../../core/keymap.ts";
import { humanizeError } from "../../core/native-errors.ts";
import { useOverlay } from "../../overlays/OverlayHost.tsx";
import {
	editorText,
	fieldsForEngine,
	inferenceConfigurationSchema,
	type JsonObject,
	parseEdit,
	type SamplingField,
	valueLabel,
	withFieldValue,
} from "../../overlays/settings/inference.tsx";
import { ErrorView } from "../../ui/ErrorView.tsx";
import { Loading } from "../../ui/Loading.tsx";
import { useToast } from "../../ui/toast.tsx";
import type { SurfaceModule, SurfaceProps } from "../../workspace/router.ts";
import { useWorkspace } from "../../workspace/WorkspaceContext.tsx";
import {
	type AgentSkillOption,
	encodeSkillSelection,
	encodeToolSelection,
	fetchAgentSkills,
	fetchAgentTools,
	NO_AGENT_CAPABILITIES,
	type SkillPickerRow,
	selectedSkillIds,
	selectedToolIds,
	skillPickerRows,
	type ToolPickerRow,
	toolPickerRows,
} from "./capabilities.ts";
import { AgentAccountAccessPanel, AgentIdentityStep } from "./identity.tsx";

const LIST_HEIGHT = 16;
const LABEL_WIDTH = 12;
const EDIT_LABEL_WIDTH = 16;
const PICKER_HEIGHT = 11;
const EDIT_BACK_HINT = hintText([HINT.back]);
const AGENT_LIST_HINT = hintText([
	HINT.move,
	{ keys: "Enter", label: "detail" },
	{ keys: "n", label: "new" },
	{ keys: "e", label: "edit" },
	HINT.refresh,
]);
const PICKER_HINT = hintText([
	HINT.move,
	{ keys: "Space/Enter", label: "toggle" },
	{ keys: "0", label: "none" },
	HINT.retry,
	HINT.back,
]);
const AGENT_EDIT_RE = /^\/agents\/([^/]+)\/edit$/;

type Theme = ReturnType<typeof useTheme>;

const agentErrorSchema = z.instanceof(Error);
function errText(
	err: Parameters<typeof agentErrorSchema.safeParse>[0]
): string {
	const parsed = agentErrorSchema.safeParse(err);
	return parsed.success ? parsed.data.message : String(err);
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
	const { target } = useCore();
	const renderer = useRenderer();
	const theme = useTheme();
	const inputFocused = useInputFocused();

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
			.catch((err) => {
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
			.catch((err) => {
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
		if (!focused || inputFocused) {
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
		return (
			<ErrorView message={humanizeError(error, { url: target.url })} onRetry />
		);
	}

	return (
		<box flexDirection="column" flexGrow={1}>
			<PageHeader
				hint={AGENT_LIST_HINT}
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
					<box flexShrink={0} marginRight={1}>
						<Divider
							color={theme.colors.border}
							height={Math.max(1, renderer.height - 8)}
							orientation="vertical"
						/>
					</box>
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
				<text
					fg={selected ? theme.colors.accent : theme.colors.mutedForeground}
				>
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
			{detailMatches && detail ? (
				<>
					<KvRow label="works as" theme={theme}>
						<text fg={theme.colors.foreground}>
							{identityModeLabel(detail.identityMode)}
						</text>
					</KvRow>
					<KvRow label="accounts" theme={theme}>
						<text fg={theme.colors.foreground}>
							{accountAccessHeadline(detail.accountAccess)}
						</text>
					</KvRow>
				</>
			) : null}
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

type FieldKey =
	| "name"
	| "title"
	| "engine"
	| "model"
	| "description"
	| "systemPrompt"
	| "personaDisplayName"
	| "personaTone"
	| "orchestrator"
	| "canCreateAgents"
	| "tools"
	| "skills"
	| "inference"
	| "identity"
	| "accountAccess";

interface FieldDef {
	key: FieldKey;
	kind?: "text" | "toggle" | "picker" | "sampling" | "identity" | "access";
	label: string;
	placeholder: string;
}

type PickerKind = "tools" | "skills";
type CatalogStatus = "idle" | "loading" | "ready" | "error";

interface PickerCatalog<T> {
	error: string | null;
	items: T[];
	status: CatalogStatus;
}

const emptyCatalog = <T,>(): PickerCatalog<T> => ({
	error: null,
	items: [],
	status: "idle",
});

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
	const shellKeyboardCaptured = useShellKeyboardCaptured();
	const { openId: externalOverlayId } = useOverlay();
	const setInputFocused = useSetInputFocused();

	const isNew = agentId === "new";

	const [existing, setExisting] = useState<Agent | null>(null);
	const [name, setName] = useState("");
	const [title, setTitle] = useState("");
	const [engine, setEngine] = useState("");
	const [model, setModel] = useState("");
	const [description, setDescription] = useState("");
	const [systemPrompt, setSystemPrompt] = useState("");
	const [personaDisplayName, setPersonaDisplayName] = useState("");
	const [personaTone, setPersonaTone] = useState("");
	const [orchestrator, setOrchestrator] = useState<boolean | null>(null);
	const [canCreateAgents, setCanCreateAgents] = useState<boolean | null>(null);
	const [toolAllowlist, setToolAllowlist] = useState<string[]>(() =>
		isNew ? [NO_AGENT_CAPABILITIES] : []
	);
	const [skillAllowlist, setSkillAllowlist] = useState<string[]>([]);
	const [pickerKind, setPickerKind] = useState<PickerKind | null>(null);
	const [pickerIndex, setPickerIndex] = useState(0);
	const [sampling, setSampling] = useState<JsonObject>({});
	const [samplingTouched, setSamplingTouched] = useState(false);
	const [samplingPanelOpen, setSamplingPanelOpen] = useState(false);
	const [toolCatalog, setToolCatalog] =
		useState<PickerCatalog<McpTool>>(emptyCatalog);
	const [skillCatalog, setSkillCatalog] =
		useState<PickerCatalog<AgentSkillOption>>(emptyCatalog);
	const [fieldIndex, setFieldIndex] = useState(0);
	const [loading, setLoading] = useState(!isNew);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// How the agent works. A new agent opens on the identity step with "Acts as
	// you" preselected, like the desktop New agent dialog; it is always sent on
	// create, and on update only when it changed, so saving other fields never
	// rewrites a mode read from Core.
	const [identityMode, setIdentityMode] =
		useState<AgentIdentityMode>("managed");
	const [identityStepOpen, setIdentityStepOpen] = useState(isNew);
	const [identityConfirmed, setIdentityConfirmed] = useState(!isNew);
	const [identityDraft, setIdentityDraft] =
		useState<AgentIdentityMode>("managed");
	// `null` = no limit; `[]` = no accounts. Sent only once edited here.
	const [accountAccess, setAccountAccess] = useState<string[] | null>(null);
	const [accountAccessTouched, setAccountAccessTouched] = useState(false);
	const [accessPanelOpen, setAccessPanelOpen] = useState(false);
	const [accessIndex, setAccessIndex] = useState(0);
	const [accessAdding, setAccessAdding] = useState(false);
	const [accessAddText, setAccessAddText] = useState("");
	const [accessError, setAccessError] = useState<string | null>(null);
	// The accounts the panel lists; `null` while they load.
	const [accessAccounts, setAccessAccounts] =
		useState<AvailableAccounts | null>(null);
	const accessRequestRef = useRef(0);

	const savingRef = useRef(false);
	savingRef.current = saving;
	const toolsRequestRef = useRef(0);
	const skillsRequestRef = useRef(0);
	const catalogTargetRef = useRef(`${url}\u0000${token ?? ""}`);

	// Keep the terminal editor useful for the settings the Desktop agent editor
	// writes through the same Core contract. Tools, skills, Composio grants, and
	// sampling use dedicated editors instead of lossy comma-separated text fields.
	const fields: FieldDef[] = [
		{ key: "name", label: "name", placeholder: "Agent name" },
		{
			key: "title",
			label: "title",
			placeholder: "Title in Chat",
		},
		{
			key: "engine",
			label: "engine",
			placeholder: "e.g. acp:claude",
		},
		{ key: "model", label: "model", placeholder: "Model id" },
		{ key: "description", label: "desc", placeholder: "Description" },
		{
			key: "systemPrompt",
			label: "prompt",
			placeholder: "Instructions",
		},
		{
			key: "personaDisplayName",
			label: "persona name",
			placeholder: "Reply name",
		},
		{
			key: "personaTone",
			label: "persona tone",
			placeholder: "friendly / custom",
		},
		{
			key: "orchestrator",
			kind: "toggle",
			label: "delegate agents",
			placeholder: "",
		},
		{
			key: "canCreateAgents",
			kind: "toggle",
			label: "create agents",
			placeholder: "",
		},
		{
			key: "tools",
			kind: "picker",
			label: "tools",
			placeholder: "",
		},
		{
			key: "skills",
			kind: "picker",
			label: "skills",
			placeholder: "",
		},
		{
			key: "inference",
			kind: "sampling",
			label: "sampling",
			placeholder: "",
		},
		{
			key: "identity",
			kind: "identity",
			label: "works as",
			placeholder: "",
		},
		{
			key: "accountAccess",
			kind: "access",
			label: "account access",
			placeholder: "",
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
				setTitle(record.title ?? "");
				setEngine(record.engine ?? "");
				setModel(record.model ?? "");
				setDescription(record.description ?? "");
				setSystemPrompt(record.systemPrompt ?? "");
				setPersonaDisplayName(record.persona?.display_name ?? "");
				setPersonaTone(record.persona?.tone ?? "");
				setOrchestrator(record.orchestrator);
				setCanCreateAgents(record.canCreateAgents);
				setSampling(inferenceConfigurationSchema.parse(record.inference ?? {}));
				setSamplingTouched(false);
				setToolAllowlist(record.tools);
				setSkillAllowlist(record.skills);
				setIdentityMode(record.identityMode);
				setAccountAccess(record.accountAccess);
				setAccountAccessTouched(false);
			})
			.catch((err) => setError(errText(err)))
			.finally(() => setLoading(false));
	}, [target, agentId, isNew]);

	const loadToolCatalog = useCallback(() => {
		const requestId = ++toolsRequestRef.current;
		setToolCatalog((current) => ({
			...current,
			error: null,
			status: "loading",
		}));
		fetchAgentTools(target)
			.then((items) => {
				if (toolsRequestRef.current === requestId) {
					setToolCatalog({ error: null, items, status: "ready" });
				}
			})
			.catch((err) => {
				if (toolsRequestRef.current === requestId) {
					setToolCatalog((current) => ({
						...current,
						error: errText(err),
						status: "error",
					}));
				}
			});
	}, [target]);

	const loadSkillCatalog = useCallback(() => {
		const requestId = ++skillsRequestRef.current;
		setSkillCatalog((current) => ({
			...current,
			error: null,
			status: "loading",
		}));
		fetchAgentSkills(target)
			.then((items) => {
				if (skillsRequestRef.current === requestId) {
					setSkillCatalog({ error: null, items, status: "ready" });
				}
			})
			.catch((err) => {
				if (skillsRequestRef.current === requestId) {
					setSkillCatalog((current) => ({
						...current,
						error: errText(err),
						status: "error",
					}));
				}
			});
	}, [target]);

	useEffect(() => {
		const nextTarget = `${url}\u0000${token ?? ""}`;
		if (catalogTargetRef.current === nextTarget) {
			return;
		}
		catalogTargetRef.current = nextTarget;
		toolsRequestRef.current += 1;
		skillsRequestRef.current += 1;
		setToolCatalog(emptyCatalog());
		setSkillCatalog(emptyCatalog());
	}, [url, token]);

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

	const toolRows = useMemo(
		() => toolPickerRows(toolAllowlist, toolCatalog.items),
		[toolAllowlist, toolCatalog.items]
	);
	const skillRows = useMemo(
		() => skillPickerRows(skillAllowlist, skillCatalog.items),
		[skillAllowlist, skillCatalog.items]
	);
	const selectedTools = useMemo(
		() => selectedToolIds(toolAllowlist, toolCatalog.items),
		[toolAllowlist, toolCatalog.items]
	);
	const selectedSkills = useMemo(
		() => selectedSkillIds(skillAllowlist, skillCatalog.items),
		[skillAllowlist, skillCatalog.items]
	);

	const toggleTool = useCallback(
		(id: string) => {
			const next = new Set(selectedToolIds(toolAllowlist, toolCatalog.items));
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			setToolAllowlist(encodeToolSelection(next, toolCatalog.items));
		},
		[toolAllowlist, toolCatalog.items]
	);
	const toggleSkill = useCallback(
		(id: string) => {
			const next = new Set(
				selectedSkillIds(skillAllowlist, skillCatalog.items)
			);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			setSkillAllowlist(encodeSkillSelection(next, skillCatalog.items));
		},
		[skillAllowlist, skillCatalog.items]
	);

	const toolSummary =
		toolAllowlist.length === 0 || toolAllowlist.includes("*")
			? "all Core tools"
			: toolAllowlist.includes(NO_AGENT_CAPABILITIES)
				? "none"
				: `${toolAllowlist.length} grant${toolAllowlist.length === 1 ? "" : "s"}`;
	const skillSummary =
		skillAllowlist.length === 0
			? "all enabled skills"
			: skillAllowlist.includes(NO_AGENT_CAPABILITIES)
				? "none"
				: `${skillAllowlist.length} skill${skillAllowlist.length === 1 ? "" : "s"}`;
	const toolPickerNotice =
		toolAllowlist.length === 0 || toolAllowlist.includes("*")
			? "Changing this Core-wide grant narrows access to the listed MCP tools."
			: "Other saved grants remain visible as unavailable rows.";
	const samplingSummary =
		Object.keys(sampling).length === 0
			? "engine defaults"
			: `${Object.keys(sampling).length} sampling override${Object.keys(sampling).length === 1 ? "" : "s"}`;
	const samplingEngine = existing?.engine ?? engine;
	// A remote A2A peer runs on another node under that node's accounts, so
	// there is no identity or account access to choose here (as on desktop).
	const remotePeer = isRemotePeerEngine(engine);
	const samplingFields = fieldsForEngine(samplingEngine);
	const updateSampling = useCallback((next: JsonObject) => {
		setSampling(next);
		setSamplingTouched(true);
	}, []);

	const save = useCallback(() => {
		if (savingRef.current) {
			return;
		}
		if (existing?.locked) {
			setError("This agent is locked. Unlock it before saving changes.");
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
			title: title.trim() || null,
			description: description.trim() || null,
			systemPrompt: systemPrompt.trim() || null,
			engine: engineValue,
			model: model.trim() || null,
			persona: {
				// Spreading the loaded persona retains avatar/style fields returned by
				// current Core versions even when an older client type does not expose
				// them. Editing the name or tone must not clear the saved avatar.
				...existing?.persona,
				display_name: personaDisplayName.trim() || null,
				tone:
					personaTone.trim() && personaTone.trim() !== "neutral"
						? personaTone.trim()
						: null,
			},
			tools: toolAllowlist,
			skills: skillAllowlist,
			composioActions: existing?.composioActions ?? [],
			orchestrator,
			canCreateAgents,

			version: existing?.version
				? bumpPatchVersion(existing.version)
				: undefined,
		};
		if (samplingTouched || existing?.inference) {
			const parsedSampling = samplingConfigSchema.safeParse(sampling);
			if (!parsedSampling.success) {
				setError(
					"Sampling settings contain invalid generation values. Correct them before saving."
				);
				return;
			}
			input.inference = parsedSampling.data;
		}
		if (isNew || identityMode !== existing?.identityMode) {
			input.identityMode = identityMode;
		}
		// `null` is meaningful: it clears the allowlist to "no limit".
		if (accountAccessTouched) {
			input.accountAccess = accountAccess;
		}
		setSaving(true);
		setError(null);
		// Ask Core whether the engine would start under this identity and account
		// access, as the desktop editor does before it enables Save. A check that
		// cannot be made does not block the save; Core still checks at launch.
		const check = engineValue
			? launchCheck(target, {
					accountAccess,
					agentId: isNew ? null : agentId,
					engine: engineValue,
					identityMode,
				}).catch(() => null)
			: Promise.resolve(null);
		check
			.then((result) => {
				if (result && !result.launchable) {
					const reason =
						result.reason ?? "Core says this agent's engine would not start.";
					const hint =
						engineValue === RYU_ENGINE_ID
							? ""
							: isNew
								? ` Set the engine to ${RYU_ENGINE_ID} to run it on Ryu instead.`
								: ` Change how it works or its account access, or switch its engine with 'ryu-cli agents identity ${agentId} ${identityMode} --engine ${RYU_ENGINE_ID}'.`;
					throw new Error(`${reason} Nothing was saved.${hint}`);
				}
				return isNew
					? createAgent(target, input)
					: updateAgent(target, agentId, input);
			})
			.then(() => {
				notify(isNew ? "Agent created" : "Agent saved", "success");
				onClose();
			})
			.catch((err) => setError(errText(err)))
			.finally(() => setSaving(false));
	}, [
		target,
		agentId,
		isNew,
		name,
		title,
		engine,
		model,
		description,
		systemPrompt,
		personaDisplayName,
		personaTone,
		orchestrator,
		canCreateAgents,
		sampling,
		samplingTouched,
		toolAllowlist,
		skillAllowlist,
		identityMode,
		accountAccess,
		accountAccessTouched,
		existing,
		notify,
		onClose,
	]);

	const loadAccessAccounts = useCallback(() => {
		const requestId = ++accessRequestRef.current;
		setAccessAccounts(null);
		const core: AccountCatalogCore = {
			get: (path) => request(target, path, {}, appResponseValueSchema),
			post: (path, body) =>
				request(target, path, { method: "POST", body }, appResponseValueSchema),
		};
		loadAvailableAccounts(core, {
			agentId: isNew ? null : agentId,
			engine: engine.trim() || null,
			identityMode,
			savedIdentityMode: existing?.identityMode ?? null,
		})
			.catch((error: unknown) => accountCatalogLoadFailed(error))
			.then((accounts) => {
				if (requestId === accessRequestRef.current) {
					setAccessAccounts(accounts);
				}
			});
	}, [target, isNew, agentId, engine, identityMode, existing]);

	// Every listed account, then the keys allowed now or when loaded that the
	// list does not show, so unticking one never makes it disappear.
	const accessRows = useMemo(() => {
		const saved = existing?.accountAccess ?? null;
		const kept =
			saved === null && accountAccess === null
				? null
				: [...new Set([...(saved ?? []), ...(accountAccess ?? [])])];
		return accountPickerRows(
			accessAccounts ?? { hiddenGroups: [], sections: [] },
			kept
		);
	}, [accessAccounts, accountAccess, existing]);

	const addAccessKey = useCallback(() => {
		const key = parseAccountKey(accessAddText);
		if (key === null) {
			setAccessError(
				`Not an account key Core accepts. Keys look like: ${ACCOUNT_KEY_FORMATS.map((format) => format.split("  ")[0]).join(", ")}`
			);
			return;
		}
		// Adding to "no limit" starts a limited list with only this key.
		const next = addAccountKeys(accountAccess, [key]);
		setAccountAccess(next);
		setAccountAccessTouched(true);
		const listed = accessRows.findIndex((row) => row.key === key);
		setAccessIndex(listed === -1 ? accessRows.length : listed);
		setAccessAddText("");
		setAccessAdding(false);
		setAccessError(null);
	}, [accessAddText, accountAccess, accessRows]);

	// Returns true when the key was handled by the identity step.
	const handleIdentityStepKey = (key: KeyEvent): boolean => {
		if (!identityStepOpen) {
			return false;
		}
		if (key.name === "escape") {
			if (identityConfirmed) {
				setIdentityStepOpen(false);
			} else {
				onClose();
			}
		} else if (key.name === "left" || key.name === "h") {
			setIdentityDraft((mode) => stepIdentityMode(mode, -1));
		} else if (key.name === "right" || key.name === "l") {
			setIdentityDraft((mode) => stepIdentityMode(mode, 1));
		} else if (key.name === "1" || key.name === "2" || key.name === "3") {
			const mode = AGENT_IDENTITY_MODE_ORDER[Number(key.name) - 1];
			if (mode) {
				setIdentityDraft(mode);
			}
		} else if (key.name === "return") {
			setIdentityMode(identityDraft);
			setIdentityConfirmed(true);
			setIdentityStepOpen(false);
		}
		return true;
	};

	// Returns true when the key was handled by the account-access panel.
	const handleAccessPanelKey = (key: KeyEvent): boolean => {
		if (!accessPanelOpen) {
			return false;
		}
		if (accessAdding) {
			if (key.name === "escape") {
				setAccessAdding(false);
				setAccessAddText("");
				setAccessError(null);
			} else if (key.name === "return") {
				addAccessKey();
			}
			return true;
		}
		const selected = accessRows[accessIndex];
		if (key.name === "escape") {
			setAccessPanelOpen(false);
			setAccessError(null);
		} else if (key.name === "up" || key.name === "k") {
			setAccessIndex((i) => Math.max(0, i - 1));
		} else if (key.name === "down" || key.name === "j") {
			setAccessIndex((i) =>
				Math.min(Math.max(0, accessRows.length - 1), i + 1)
			);
		} else if (key.name === "r") {
			setAccessError(null);
			loadAccessAccounts();
		} else if (existing?.locked) {
			// A locked agent's access is shown, never changed.
		} else if (key.name === "a") {
			setAccessAdding(true);
			setAccessAddText("");
			setAccessError(null);
		} else if (
			key.name === "space" ||
			key.name === " " ||
			key.name === "return"
		) {
			// Under no limit, the first toggle starts a limit from every listed
			// account, so wait until they have loaded: otherwise it would leave
			// out accounts still loading.
			const blocked =
				accountAccess === null && accessAccounts !== null
					? accountLimitStartBlocked(accessAccounts)
					: null;
			if (blocked) {
				setAccessError(blocked);
			} else if (
				selected &&
				!(accountAccess === null && accessAccounts === null)
			) {
				setAccountAccess(
					toggleAccountAccess(
						accountAccess,
						accessAccounts ?? { hiddenGroups: [], sections: [] },
						selected.key
					)
				);
				setAccountAccessTouched(true);
				setAccessError(null);
			}
		} else if (
			(key.name === "x" || key.name === "delete" || key.name === "d") &&
			accountAccess !== null
		) {
			if (selected && accountAccess.includes(selected.key)) {
				setAccountAccess(removeAccountKeys(accountAccess, [selected.key]));
				setAccountAccessTouched(true);
			}
		} else if (key.name === "c") {
			setAccountAccess(null);
			setAccountAccessTouched(true);
			setAccessIndex(0);
		} else if (key.name === "0" && !(key.ctrl || key.meta || key.option)) {
			// Plain 0 only: Alt+0 is the shell's sidebar-focus chord.
			setAccountAccess([]);
			setAccountAccessTouched(true);
			setAccessIndex(0);
		}
		return true;
	};

	useKeyboard((key: KeyEvent) => {
		if (!focused || shellKeyboardCaptured || externalOverlayId) {
			return;
		}
		if (samplingPanelOpen) {
			return;
		}
		if (handleIdentityStepKey(key) || handleAccessPanelKey(key)) {
			return;
		}
		if (pickerKind !== null) {
			if (key.name === "escape") {
				setPickerKind(null);
				return;
			}
			// Plain 0 only: Alt+0 is the shell's sidebar-focus chord.
			if (key.name === "0" && !(key.ctrl || key.meta || key.option)) {
				if (pickerKind === "tools") {
					setToolAllowlist([NO_AGENT_CAPABILITIES]);
				} else {
					setSkillAllowlist([NO_AGENT_CAPABILITIES]);
				}
				setPickerIndex(0);
				return;
			}
			if (key.name === "r") {
				if (pickerKind === "tools") {
					loadToolCatalog();
				} else {
					loadSkillCatalog();
				}
				return;
			}
			const rows = pickerKind === "tools" ? toolRows : skillRows;
			if (key.name === "up" || key.name === "k") {
				setPickerIndex((i) => Math.max(0, i - 1));
				return;
			}
			if (key.name === "down" || key.name === "j") {
				setPickerIndex((i) => Math.min(Math.max(0, rows.length - 1), i + 1));
				return;
			}
			if (key.name === "space" || key.name === "return") {
				const row = rows[pickerIndex];
				const catalogStatus =
					pickerKind === "tools" ? toolCatalog.status : skillCatalog.status;
				if (row && catalogStatus !== "loading" && catalogStatus !== "idle") {
					if (pickerKind === "tools") {
						toggleTool(row.id);
					} else {
						toggleSkill(row.id);
					}
				}
				return;
			}
			return;
		}
		// Alt chords belong to the shell: Ctrl+Alt+S splits and Alt+←/→ moves
		// between panes, so neither may save or flip a toggle here.
		const alt = key.meta || key.option;
		if (key.ctrl && !alt && key.name === "s") {
			save();
		} else if (key.name === "escape") {
			onClose();
		} else if (
			fields[fieldIndex]?.kind === "toggle" &&
			!alt &&
			(key.name === "return" || key.name === "left" || key.name === "right")
		) {
			const field = fields[fieldIndex];
			if (field?.key === "orchestrator") {
				setOrchestrator((current) => !(current ?? true));
			} else if (field?.key === "canCreateAgents") {
				setCanCreateAgents((current) => !(current ?? false));
			}
		} else if (key.name === "tab" && key.shift) {
			setFieldIndex((i) => (i - 1 + fields.length) % fields.length);
		} else if (key.name === "tab") {
			setFieldIndex((i) => (i + 1) % fields.length);
		} else if (fields[fieldIndex]?.kind === "picker" && key.name === "return") {
			const field = fields[fieldIndex];
			if (field?.key === "tools") {
				setPickerKind("tools");
				setPickerIndex(0);
				if (toolCatalog.status === "idle") {
					loadToolCatalog();
				}
			} else if (field?.key === "skills") {
				setPickerKind("skills");
				setPickerIndex(0);
				if (skillCatalog.status === "idle") {
					loadSkillCatalog();
				}
			}
		} else if (
			fields[fieldIndex]?.kind === "sampling" &&
			key.name === "return"
		) {
			setSamplingPanelOpen(true);
		} else if (
			fields[fieldIndex]?.kind === "identity" &&
			key.name === "return" &&
			!remotePeer
		) {
			if (existing?.locked) {
				setError("This agent is locked. Unlock it before saving changes.");
				return;
			}
			setIdentityDraft(identityMode);
			setIdentityStepOpen(true);
		} else if (
			fields[fieldIndex]?.kind === "access" &&
			key.name === "return" &&
			!remotePeer
		) {
			setAccessIndex(0);
			setAccessAdding(false);
			setAccessError(null);
			setAccessPanelOpen(true);
			loadAccessAccounts();
		}
	});

	if (loading) {
		return <Loading label="Loading agent…" />;
	}

	const valueFor = (k: FieldKey): string => {
		switch (k) {
			case "name":
				return name;
			case "title":
				return title;
			case "engine":
				return engine;
			case "model":
				return model;
			case "description":
				return description;
			case "systemPrompt":
				return systemPrompt;
			case "personaDisplayName":
				return personaDisplayName;
			case "personaTone":
				return personaTone;
			case "orchestrator":
				return (orchestrator ?? true) ? "on" : "off";
			case "canCreateAgents":
				return (canCreateAgents ?? false) ? "on" : "off";
			case "tools":
				return toolSummary;
			case "skills":
				return skillSummary;
			case "inference":
				return samplingSummary;
			case "identity":
				return remotePeer
					? REMOTE_PEER_IDENTITY_NOTE.title
					: AGENT_IDENTITY_MODE_OPTIONS[identityMode].title;
			case "accountAccess":
				return remotePeer
					? "not used on this node"
					: accountAccessHeadline(accountAccess);
		}
	};

	const setterFor = (k: FieldKey): ((v: string) => void) => {
		switch (k) {
			case "name":
				return setName;
			case "title":
				return setTitle;
			case "engine":
				return setEngine;
			case "model":
				return setModel;
			case "description":
				return setDescription;
			case "systemPrompt":
				return setSystemPrompt;
			case "personaDisplayName":
				return setPersonaDisplayName;
			case "personaTone":
				return setPersonaTone;
			case "orchestrator":
			case "canCreateAgents":
			case "tools":
			case "skills":
			case "inference":
			case "identity":
			case "accountAccess":
				return () => undefined;
		}
	};

	if (identityStepOpen) {
		return (
			<AgentIdentityStep
				selected={identityDraft}
				title={isNew ? "New agent" : name.trim() || "Edit agent"}
			/>
		);
	}
	if (accessPanelOpen) {
		return (
			<AgentAccountAccessPanel
				accountAccess={accountAccess}
				accounts={accessAccounts}
				addError={accessError}
				adding={accessAdding}
				addText={accessAddText}
				focusedIndex={accessIndex}
				identityMode={identityMode}
				locked={existing?.locked ?? false}
				onAddInput={setAccessAddText}
				rows={accessRows}
			/>
		);
	}
	if (pickerKind === "tools") {
		return (
			<AgentCapabilityPicker
				error={toolCatalog.error}
				focusedIndex={pickerIndex}
				kind="tools"
				notice={toolPickerNotice}
				rows={toolRows}
				selected={selectedTools}
				status={toolCatalog.status}
				summary={toolSummary}
				theme={theme}
			/>
		);
	}
	if (pickerKind === "skills") {
		return (
			<AgentCapabilityPicker
				error={skillCatalog.error}
				focusedIndex={pickerIndex}
				kind="skills"
				notice="Disabled skills remain inactive until enabled globally."
				rows={skillRows}
				selected={selectedSkills}
				status={skillCatalog.status}
				summary={skillSummary}
				theme={theme}
			/>
		);
	}
	if (samplingPanelOpen) {
		return (
			<AgentInferenceEditor
				engineName={samplingEngine}
				error={error}
				fields={samplingFields}
				// The editor reads plain keys; it yields to the palette, sidebar
				// focus mode and shell overlays like the agent editor itself.
				focused={focused && !shellKeyboardCaptured && !externalOverlayId}
				onBack={() => setSamplingPanelOpen(false)}
				onChange={updateSampling}
				onSave={save}
				saving={saving}
				value={sampling}
			/>
		);
	}

	return (
		<box flexDirection="column" flexGrow={1}>
			<PageHeader
				hint="Tab fields · arrows edit · Enter toggle/pick · ^S save"
				subtitle={isNew ? "Create a new agent" : (existing?.id ?? agentId)}
				title={isNew ? "New agent" : name.trim() || "Edit agent"}
			/>
			<box flexDirection="column" gap={1} padding={1}>
				{fields.map((field, i) =>
					field.kind === "toggle" ? (
						<ToggleField
							focused={focused && fieldIndex === i}
							key={field.key}
							label={field.label}
							theme={theme}
							value={valueFor(field.key)}
						/>
					) : field.kind === "sampling" ? (
						<PickerField
							action="Enter to edit"
							focused={focused && fieldIndex === i}
							key={field.key}
							label="sampling"
							theme={theme}
							value={samplingSummary}
						/>
					) : field.kind === "identity" || field.kind === "access" ? (
						<PickerField
							action={
								remotePeer
									? "Remote peer"
									: field.kind === "identity"
										? "Enter to change"
										: "Enter to edit"
							}
							focused={focused && fieldIndex === i}
							key={field.key}
							label={field.label}
							theme={theme}
							value={valueFor(field.key)}
						/>
					) : field.kind === "picker" ? (
						<PickerField
							focused={focused && fieldIndex === i}
							key={field.key}
							label={field.label}
							theme={theme}
							value={valueFor(field.key)}
						/>
					) : (
						<EditField
							focused={focused && fieldIndex === i}
							key={field.key}
							label={field.label}
							onChange={setterFor(field.key)}
							placeholder={field.placeholder}
							theme={theme}
							value={valueFor(field.key)}
						/>
					)
				)}
				{remotePeer ? (
					<text fg={theme.colors.mutedForeground}>
						{REMOTE_PEER_IDENTITY_NOTE.description}
					</text>
				) : null}
				{error ? <StatusMessage variant="error">{error}</StatusMessage> : null}
				{saving ? (
					<StatusMessage variant="loading">saving…</StatusMessage>
				) : null}
			</box>
		</box>
	);
}

function AgentInferenceEditor({
	engineName,
	error,
	fields,
	focused,
	onBack,
	onChange,
	onSave,
	saving,
	value,
}: {
	engineName: string;
	error: string | null;
	fields: readonly SamplingField[];
	focused: boolean;
	onBack: () => void;
	onChange: (next: JsonObject) => void;
	onSave: () => void;
	saving: boolean;
	value: JsonObject;
}) {
	const theme = useTheme();
	const [draft, setDraft] = useState<JsonObject>(value);
	const [fieldIndex, setFieldIndex] = useState(0);
	const [editing, setEditing] = useState(false);
	const [editText, setEditText] = useState("");
	const [editError, setEditError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const selectedField = fields[Math.min(fieldIndex, fields.length - 1)];

	const beginEdit = useCallback(() => {
		if (!(selectedField && !saving)) {
			return;
		}
		setEditText(editorText(selectedField, draft[selectedField.key]));
		setEditError(null);
		setNotice(null);
		setEditing(true);
	}, [draft, saving, selectedField]);

	const finishEdit = useCallback(() => {
		if (!selectedField) {
			return;
		}
		const parsed = parseEdit(selectedField, editText);
		if (parsed.error) {
			setEditError(parsed.error);
			return;
		}
		const next = withFieldValue(draft, selectedField.key, parsed.value);
		setDraft(next);
		onChange(next);
		setEditing(false);
		setEditError(null);
		setNotice(`${selectedField.label} updated in the agent draft.`);
	}, [draft, editText, onChange, selectedField]);

	const cancelEdit = useCallback(() => {
		setEditing(false);
		setEditError(null);
		setNotice("Edit cancelled.");
	}, []);

	const clearSelected = useCallback(() => {
		if (!selectedField || editing || saving) {
			return;
		}
		const next = withFieldValue(draft, selectedField.key, undefined);
		setDraft(next);
		onChange(next);
		setEditError(null);
		setNotice(`${selectedField.label} cleared to use its default.`);
	}, [draft, editing, onChange, saving, selectedField]);

	useKeyboard((key) => {
		if (!focused) {
			return;
		}
		if (editing) {
			if (key.name === "return") {
				finishEdit();
			} else if (key.name === "tab") {
				cancelEdit();
			}
			return;
		}
		if (key.name === "escape") {
			onBack();
			return;
		}
		if (key.ctrl && key.name === "s") {
			if (!(saving || editError)) {
				onSave();
			}
			return;
		}
		if (saving) {
			return;
		}
		if (key.name === "up" || key.name === "k") {
			setFieldIndex((current) => Math.max(0, current - 1));
		} else if (key.name === "down" || key.name === "j") {
			setFieldIndex((current) => Math.min(fields.length - 1, current + 1));
		} else if (key.name === "e" || key.name === "return") {
			beginEdit();
		} else if (key.name === "x" || key.name === "delete") {
			clearSelected();
		}
	});

	return (
		<box flexDirection="column" flexGrow={1}>
			<PageHeader
				hint={`↑↓ / j k fields · e / Enter edit · x clear · ^S save agent · ${EDIT_BACK_HINT}`}
				subtitle={`Per-agent defaults · ${engineName || "engine default"}`}
				title="Advanced inference"
			/>
			<box flexDirection="column" gap={1} padding={1}>
				<text fg={theme.colors.mutedForeground}>
					Agent values are fallbacks: engine defaults override matching fields,
					and request values override both. Blank fields use engine defaults.
				</text>
				{selectedField ? (
					<box flexDirection="column" gap={1}>
						<text fg={theme.colors.mutedForeground}>
							{selectedField.group} · {selectedField.label} ({fieldIndex + 1}/
							{fields.length})
						</text>
						{editing ? (
							<input
								focused={focused}
								onInput={setEditText}
								placeholder={
									selectedField.kind === "number"
										? "number; blank uses engine default"
										: "value; blank clears"
								}
								value={editText}
							/>
						) : (
							<text fg={theme.colors.foreground}>
								{valueLabel(draft[selectedField.key])}
							</text>
						)}
						{selectedField.hint ? (
							<text fg={theme.colors.mutedForeground}>
								{selectedField.hint}
							</text>
						) : null}
						{editError ? (
							<StatusMessage variant="error">{editError}</StatusMessage>
						) : null}
						{notice ? <text fg={theme.colors.success}>{notice}</text> : null}
					</box>
				) : null}
				{error ? <StatusMessage variant="error">{error}</StatusMessage> : null}
				{saving ? (
					<StatusMessage variant="loading">saving agent…</StatusMessage>
				) : null}
			</box>
		</box>
	);
}

function ToggleField({
	focused,
	label,
	value,
	theme,
}: {
	focused: boolean;
	label: string;
	theme: Theme;
	value: string;
}) {
	const enabled = value === "on";
	return (
		<box flexDirection="row" gap={1}>
			<text fg={focused ? theme.colors.primary : theme.colors.mutedForeground}>
				{`${focused ? "›" : " "} ${label.padEnd(EDIT_LABEL_WIDTH)}`}
			</text>
			<text fg={focused ? theme.colors.primary : theme.colors.foreground}>
				{enabled ? "● On   ○ Off" : "○ On   ● Off"}
			</text>
		</box>
	);
}

function PickerField({
	action = "Enter to choose",
	focused,
	label,
	value,
	theme,
}: {
	action?: string;
	focused: boolean;
	label: string;
	theme: Theme;
	value: string;
}) {
	return (
		<box flexDirection="row" gap={1}>
			<text fg={focused ? theme.colors.primary : theme.colors.mutedForeground}>
				{`${focused ? "›" : " "} ${label.padEnd(EDIT_LABEL_WIDTH)}`}
			</text>
			<text fg={focused ? theme.colors.primary : theme.colors.foreground}>
				{`${action} · ${value}`}
			</text>
		</box>
	);
}

function AgentCapabilityPicker({
	error,
	focusedIndex,
	kind,
	notice,
	rows,
	selected,
	status,
	summary,
	theme,
}: {
	error: string | null;
	focusedIndex: number;
	kind: PickerKind;
	notice: string;
	rows: Array<ToolPickerRow | SkillPickerRow>;
	selected: ReadonlySet<string>;
	status: CatalogStatus;
	summary: string;
	theme: Theme;
}) {
	const title = kind === "tools" ? "Agent tools" : "Agent skills";
	const noun = kind === "tools" ? "tools" : "skills";
	const start = Math.max(
		0,
		Math.min(
			focusedIndex - Math.floor(PICKER_HEIGHT / 2),
			Math.max(0, rows.length - PICKER_HEIGHT)
		)
	);
	const visible = rows.slice(start, start + PICKER_HEIGHT);

	return (
		<box flexDirection="column" flexGrow={1}>
			<PageHeader
				hint={PICKER_HINT}
				subtitle={`${summary} · ${rows.length} listed`}
				title={title}
			/>
			<box flexDirection="column" gap={1} padding={1}>
				{status === "loading" && rows.length === 0 ? (
					<Loading label={`Loading ${noun}…`} />
				) : null}
				{error ? (
					<StatusMessage variant="error">
						{rows.length > 0
							? `Catalog refresh failed: ${error}. Showing saved/current rows; press r to retry.`
							: `Couldn't load ${noun}: ${error}. Press r to retry.`}
					</StatusMessage>
				) : null}
				{status === "ready" && rows.length === 0 ? (
					<text fg={theme.colors.mutedForeground}>
						{kind === "tools"
							? "No registered MCP tools are available."
							: "No installed skills are available."}
					</text>
				) : null}
				<text fg={theme.colors.mutedForeground}>{notice}</text>
				{visible.map((row, index) => {
					const focused = start + index === focusedIndex;
					return (
						<text
							fg={focused ? theme.colors.primary : theme.colors.foreground}
							key={row.id}
						>
							{`${focused ? "›" : " "} ${selected.has(row.id) ? "[x]" : "[ ]"} ${row.label}`}
						</text>
					);
				})}
				{rows.length > PICKER_HEIGHT ? (
					<text fg={theme.colors.mutedForeground}>
						{`${start + 1}–${Math.min(start + PICKER_HEIGHT, rows.length)} of ${rows.length}`}
					</text>
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
		<box flexDirection="row" gap={1}>
			<text fg={focused ? theme.colors.primary : theme.colors.mutedForeground}>
				{`${focused ? "›" : " "} ${label.padEnd(EDIT_LABEL_WIDTH)}`}
			</text>
			<box flexBasis={0} flexGrow={1}>
				<input
					cursorColor={theme.colors.primary}
					focused={focused}
					focusedTextColor={theme.colors.foreground}
					onInput={onChange}
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
