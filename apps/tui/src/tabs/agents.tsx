/* @jsxImportSource @opentui/react */
// Agents tab - parity with apps/cli's "Agents" tab (apps/cli/src/{app.rs,
// api.rs,ui.rs,main.rs}). A master-detail view over Core's configured agents:
//   - GET /api/agents (fetchAgents)          left card list, one row per agent
//   - GET /api/agents/:id (fetchAgent)        right detail pane, loaded on Enter
// All rows come from Core; the client never defines agents (parity note in
// api.rs fetch_agents). The left list shows name + engine [transport] badge and a
// "!" marker when the agent is not installed. The right pane shows the agent's
// attributes (name / engine / model / routing / transport / description) and its
// tools list once the detail has been loaded.
//
// Keyboard (gated on `active`, mirrors main.rs SidebarTab::Agents):
//   - j/k or ↑/↓   move the selection (clears any loaded detail, like the Rust
//                  tab which resets agent_detail on every move)
//   - Enter        load the selected agent's full record (tools)
//   - r            refresh the agent list from Core
// This tab owns no text input, so it only gates on `active` (the shell unmounts
// inactive tabs and passes active=false while an overlay is open).

import { useKeyboard } from "@opentui/react";
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
import { StatusMessage } from "@/components/ui/status-message.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../core/CoreContext.tsx";
import { useInputFocused } from "../core/InputFocusContext.tsx";
import { ErrorView } from "../ui/ErrorView.tsx";
import { Loading } from "../ui/Loading.tsx";
import type { TabProps } from "./types.ts";

const LIST_HEIGHT = 16;
const LABEL_WIDTH = 11;

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// Pad an attribute label to a fixed column so values line up (parity with the
// Rust detail pane's " engine     " style fixed-width labels).
function padLabel(label: string): string {
	return label.padEnd(LABEL_WIDTH, " ");
}

export function AgentsTab({ active }: TabProps) {
	const { target, url, token } = useCore();
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

	// Track the latest list/detail requests so a stale resolve cannot clobber
	// fresh state after a fast node switch or selection change.
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

	// Lazy first load on activation; reload on node switch (url/token primitives).
	useEffect(() => {
		if (active) {
			loadAgents();
		}
	}, [active, loadAgents]);

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
				if (detailReqRef.current !== reqId) {
					return;
				}
				setDetail(d);
			})
			.catch((err: unknown) => {
				if (detailReqRef.current !== reqId) {
					return;
				}
				setDetailError(`Failed to load detail: ${errText(err)}`);
			})
			.finally(() => {
				if (detailReqRef.current === reqId) {
					setDetailLoading(false);
				}
			});
	}, [target, selected]);

	// Moving the selection clears any loaded detail (parity with main.rs which
	// sets agent_detail = None on every up/down).
	const move = useCallback((delta: number) => {
		setDetail(null);
		setDetailError(null);
		setIndex((i) => {
			const next = i + delta;
			if (next < 0) {
				return 0;
			}
			return next;
		});
	}, []);

	useKeyboard((key) => {
		if (!active || inputFocused) {
			return;
		}
		if (key.name === "up" || key.name === "k") {
			move(-1);
		} else if (key.name === "down" || key.name === "j") {
			setDetail(null);
			setDetailError(null);
			setIndex((i) => Math.min(Math.max(0, agents.length - 1), i + 1));
		} else if (key.name === "return") {
			loadDetail();
		} else if (key.name === "r") {
			loadAgents();
		}
	});

	if (loading && !loaded) {
		return <Loading label="Loading agents…" />;
	}
	// A failed list fetch covers "core not running" (parity with the Rust empty
	// state when Core is unreachable).
	if (error) {
		return <ErrorView message={error} />;
	}

	return (
		<box flexDirection="column" flexGrow={1} paddingLeft={1} paddingTop={1}>
			<text fg={theme.colors.foreground}>
				<b>Agents</b>
			</text>
			{agents.length === 0 ? (
				<box paddingTop={1}>
					<text fg={theme.colors.mutedForeground}>no agents configured</text>
				</box>
			) : (
				<box flexDirection="row" flexGrow={1} gap={1} paddingTop={1}>
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

type Theme = ReturnType<typeof useTheme>;

function AgentList({
	agents,
	selectedIndex,
	theme,
}: {
	agents: AgentSummary[];
	selectedIndex: number;
	theme: Theme;
}) {
	// Window the list so the selection stays visible without a focus-capturing
	// scrollbox (parity with ListTab's windowing approach).
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
			{visible.map((agent, i) => {
				const absolute = start + i;
				const isSel = absolute === selectedIndex;
				return (
					<box
						flexDirection="column"
						key={agent.id}
						marginTop={i === 0 ? 1 : 0}
					>
						<box flexDirection="row" gap={1}>
							<text fg={isSel ? theme.colors.accent : theme.colors.muted}>
								{isSel ? "›" : " "}
							</text>
							<text fg={isSel ? theme.colors.accent : theme.colors.foreground}>
								{isSel ? <b>{agent.name}</b> : agent.name}
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
			})}
			{agents.length > visible.length ? (
				<text fg={theme.colors.mutedForeground}>
					{`${selectedIndex + 1}/${agents.length}`}
				</text>
			) : null}
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
	loading: boolean;
	error: string | null;
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
	loading: boolean;
	error: string | null;
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

	// Routing parity with the Rust CLI (ui.rs): `gatewayBypass === true` renders
	// "direct (gateway bypass)"; false/undefined (Core omits it, i.e. Rust `None`)
	// renders "via gateway".
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
		</box>
	);
}

function ToolsList({ tools, theme }: { tools: string[]; theme: Theme }) {
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
	label: string;
	children: ReactNode;
	theme: Theme;
}) {
	return (
		<box flexDirection="row" gap={1}>
			<text fg={theme.colors.mutedForeground}>{padLabel(label)}</text>
			{children}
		</box>
	);
}
