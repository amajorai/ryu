/* @jsxImportSource @opentui/react */
// Setup surface (path /setup) - the guided onboarding wizard, the TUI port of
// apps/cli's 4-screen setup flow (Screen::Setup{Dependencies,Providers,Tools,
// Agents} + `ryu setup`). apps/cli walks the user Dependencies -> Providers ->
// Tools -> Agents, installing sidecars via POST /api/setup/:name/install; the TUI
// had only bootstrap.ts (auto-start Core) with no guided selection, which the
// parity audit flagged as the one "partial" interactive gap. This closes it.
//
// Faithful but lean: each catalog step (Providers/Tools/Agents) reuses the shared
// ListTab (j/k move · Enter install · r reload) over a category-filtered view of
// GET /api/catalog, installing the selected item with the typed
// installSidecar (POST /api/setup/:name/install) - the exact endpoints apps/cli
// uses. The Dependencies step is informational (git/rust/npm/python are host
// prerequisites Core cannot install for you), matching apps/cli's read-only
// dependency screen. Step navigation (←/→ or Tab) is owned here; the per-step
// ListTab owns j/k/Enter/r, and the two keyboards compose because neither claims
// the other's keys. Reachable from the command palette ("Run setup wizard") and
// the sidebar, not auto-launched (bootstrap already brings Core online).

import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { type ApiTarget, apiUrl, makeHeaders } from "@ryuhq/core-client/client";
import { installSidecar } from "@ryuhq/core-client/plugins";
import { type ReactNode, useState } from "react";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import type { ListRow } from "../../core/featureList.ts";
import { useInputFocused } from "../../core/InputFocusContext.tsx";
import { type ListLoader, ListTab } from "../../ui/ListTab.tsx";
import type { SurfaceModule, SurfaceProps } from "../../workspace/router.ts";
import { useWorkspace } from "../../workspace/WorkspaceContext.tsx";

// Host prerequisites Core cannot install; shown read-only like apps/cli's
// dependency screen so the user knows what to have on PATH.
const DEPENDENCIES: { hint: string; name: string }[] = [
	{ name: "git", hint: "version control · required for worktree runs" },
	{ name: "rust", hint: "toolchain · required to build native agents" },
	{ name: "npm", hint: "node package manager · for JS agents/tools" },
	{ name: "python", hint: "≥3.9 · for vllm and python tools" },
];

// GET /api/catalog wire shape (the `sidecars` array). Core-client has no typed
// reader for this endpoint, so it is fetched with the shared HTTP primitives -
// the same approach as src/tabs/apps.tsx.
interface CatalogItemWire {
	category?: string;
	description?: string;
	install_state?: string;
	name?: string;
	recommended?: boolean;
}

// Build a ListTab loader over /api/catalog filtered to one category, mapped to the
// generic ListRow (title=name, subtitle=description, badge=install state).
function catalogLoader(category: string): ListLoader {
	return async (target: ApiTarget, signal?: AbortSignal): Promise<ListRow[]> => {
		const resp = await fetch(apiUrl(target, "/api/catalog"), {
			headers: makeHeaders(target.token),
			signal,
		});
		if (!resp.ok) {
			throw new Error(`/api/catalog failed: ${resp.status}`);
		}
		const json = (await resp.json()) as { sidecars?: CatalogItemWire[] };
		return (json.sidecars ?? [])
			.filter((item) => item.category === category)
			.map((item): ListRow => {
				const rec = item.recommended ? "★ " : "";
				const state = item.install_state;
				const badge =
					state && state !== "not_installed" ? state : rec ? "recommended" : undefined;
				return {
					id: item.name ?? "",
					title: item.name ?? "—",
					subtitle: `${rec}${item.description ?? ""}`.trim() || undefined,
					badge,
				};
			});
	};
}

// Enter on a catalog row: install it via the same endpoint apps/cli posts to.
const installRow = async (row: ListRow, target: ApiTarget): Promise<string> => {
	await installSidecar(target, row.id);
	return `installing ${row.id}… (r to refresh)`;
};

interface Step {
	body: (focused: boolean) => ReactNode;
	hint: string;
	title: string;
}

function DependencyStep() {
	const theme = useTheme();
	return (
		<box flexDirection="column" flexGrow={1} paddingLeft={1} paddingTop={1}>
			{DEPENDENCIES.map((dep) => (
				<box flexDirection="row" gap={1} key={dep.name}>
					<text fg={theme.colors.muted}>·</text>
					<text fg={theme.colors.foreground}>{dep.name}</text>
					<text fg={theme.colors.mutedForeground}>{dep.hint}</text>
				</box>
			))}
			<box paddingTop={1}>
				<text fg={theme.colors.mutedForeground}>
					Install any missing prerequisite with your system package manager,
					then press → to pick providers.
				</text>
			</box>
		</box>
	);
}

const STEP_COUNT = 4;

function SetupSurface({ active, paneId }: SurfaceProps) {
	const theme = useTheme();
	const { focusedPaneId } = useWorkspace();
	const inputFocused = useInputFocused();
	const focused = active && focusedPaneId === paneId;
	const [step, setStep] = useState(0);

	// Own ←/→ and Tab for step navigation. The per-step ListTab owns j/k/Enter/r;
	// the keyboards compose because neither claims the other's keys.
	useKeyboard((key: KeyEvent) => {
		if (!focused || inputFocused) {
			return;
		}
		if (key.name === "right" || (key.name === "tab" && !key.shift)) {
			setStep((s) => Math.min(STEP_COUNT - 1, s + 1));
		} else if (key.name === "left" || (key.name === "tab" && key.shift)) {
			setStep((s) => Math.max(0, s - 1));
		}
	});

	const steps: Step[] = [
		{
			title: "Dependencies",
			hint: "host prerequisites (read-only)",
			body: () => <DependencyStep />,
		},
		{
			title: "Providers",
			hint: "local inference engines · Enter install",
			body: (f) => (
				<ListTab
					active={f}
					emptyLabel="No providers in catalog"
					load={catalogLoader("provider")}
					onActivate={installRow}
				/>
			),
		},
		{
			title: "Tools",
			hint: "web/scrape/perception tools · Enter install",
			body: (f) => (
				<ListTab
					active={f}
					emptyLabel="No tools in catalog"
					load={catalogLoader("tool")}
					onActivate={installRow}
				/>
			),
		},
		{
			title: "Agents",
			hint: "agent runtimes · Enter install",
			body: (f) => (
				<ListTab
					active={f}
					emptyLabel="No agents in catalog"
					load={catalogLoader("agent")}
					onActivate={installRow}
				/>
			),
		},
	];

	const current = steps[step] ?? steps[0];

	return (
		<box flexDirection="column" flexGrow={1}>
			<box flexDirection="column" paddingLeft={1} paddingTop={1}>
				<text fg={theme.colors.foreground}>
					<b>Setup</b>
				</text>
				<box flexDirection="row" gap={1}>
					{steps.map((s, i) => (
						<text
							fg={i === step ? theme.colors.primary : theme.colors.muted}
							key={s.title}
						>
							{i === step ? `[${i + 1} ${s.title}]` : `${i + 1} ${s.title}`}
						</text>
					))}
				</box>
				<text fg={theme.colors.mutedForeground}>
					{current.hint} · ←/→ step · Tab next · r reload
				</text>
			</box>
			{current.body(focused)}
		</box>
	);
}

/** The Setup wizard surface module (path /setup). Registered in router.ts. */
export const setupSurface: SurfaceModule = {
	id: "setup",
	title: "Setup",
	match: (path) => path === "/setup" || path.startsWith("/setup/"),
	Component: SetupSurface,
};
