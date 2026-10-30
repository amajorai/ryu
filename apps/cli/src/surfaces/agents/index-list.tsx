/* @jsxImportSource @opentui/react */
import type { KeyEvent } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import {
	type Agent,
	type AgentSummary,
	fetchAgent,
	fetchAgents,
} from "@ryuhq/core-client/agents";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { Badge } from "@/components/ui/badge.tsx";
import { Divider } from "@/components/ui/divider.tsx";
import { StatusMessage } from "@/components/ui/status-message.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import {
	accountAccessHeadline,
	identityModeLabel,
} from "../../core/agentIdentity.ts";
import { useCore } from "../../core/CoreContext.tsx";
import { useInputFocused } from "../../core/InputFocusContext.tsx";
import { HINT, hintText } from "../../core/keymap.ts";
import { humanizeError } from "../../core/native-errors.ts";
import { tf } from "../../i18n/translate.ts";
import { ErrorView } from "../../ui/ErrorView.tsx";
import { Loading } from "../../ui/Loading.tsx";
import { errText, PageHeader, type Theme } from "./index-shared.tsx";

const LIST_HEIGHT = 16;
const LABEL_WIDTH = 12;
const AGENT_LIST_HINT = hintText([
	HINT.move,
	{ keys: "Enter", label: "detail" },
	{ keys: "n", label: "new" },
	{ keys: "e", label: "edit" },
	HINT.refresh,
]);

function padLabel(label: string): string {
	return label.padEnd(LABEL_WIDTH, " ");
}

// ── List + detail view (the /agents page) ────────────────────────────────────

export function AgentsListView({
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
					setDetailError(
						tf("Failed to load detail: {error}", { error: errText(err) })
					);
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
				subtitle={tf("{count} configured", { count: String(agents.length) })}
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
						{tf("{label}press enter to load", { label: padLabel("tools") })}
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
