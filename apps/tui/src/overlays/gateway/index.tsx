/* @jsxImportSource @opentui/react */
// Gateway overlay body — the TUI mirror of the desktop GatewayDialog
// (apps/desktop/src/components/gateway/GatewayDialog.tsx). It renders an inset
// sub-nav grouped exactly like desktop (Overview; Policy: Routing, Guardrails,
// Budgets, Keys, Identities, Channels; Observability: Audit, Evals) beside a
// scrollable content pane. It is only mounted while the overlay is open, so its
// keyboard (↑/↓ or j/k to switch section, r to refresh) needs no focus gate; the
// OverlayHost owns Esc-to-close and claims raw input while open.
//
// Data-backed sections reuse the single raw GET /api/gateway/status snapshot
// (src/overlays/gateway/status.ts, lifted from the legacy src/tabs/gateway.tsx);
// the fetch logic is unchanged. Registered under the "gateway" overlay id by the
// Integrate step (registerOverlay(gatewayOverlay)).

import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { ErrorView } from "../../ui/ErrorView.tsx";
import { Loading } from "../../ui/Loading.tsx";
import type { OverlayBodyProps, OverlayModule } from "../registry.ts";
import {
	AuditPanel,
	BudgetsPanel,
	ChannelsPanel,
	EvalsPanel,
	GuardrailsPanel,
	IdentitiesPanel,
	KeysPanel,
	OverviewPanel,
	RoutingPanel,
} from "./sections.tsx";
import { type LoadState, useGatewayStatus } from "./status.ts";

type Section =
	| "overview"
	| "routing"
	| "guardrails"
	| "budgets"
	| "keys"
	| "identities"
	| "channels"
	| "audit"
	| "evals";

const SECTION_ORDER: Section[] = [
	"overview",
	"routing",
	"guardrails",
	"budgets",
	"keys",
	"identities",
	"channels",
	"audit",
	"evals",
];

const SECTION_LABELS: Record<Section, string> = {
	overview: "Overview",
	routing: "Routing",
	guardrails: "Guardrails",
	budgets: "Budgets",
	keys: "Keys",
	identities: "Identities",
	channels: "Channels",
	audit: "Audit",
	evals: "Evals",
};

const NAV_GROUPS: { items: Section[]; title?: string }[] = [
	{ items: ["overview"] },
	{
		title: "Policy",
		items: [
			"routing",
			"guardrails",
			"budgets",
			"keys",
			"identities",
			"channels",
		],
	},
	{ title: "Observability", items: ["audit", "evals"] },
];

const NAV_WIDTH = 20;
const CONTENT_WIDTH = 58;
const BODY_HEIGHT = 18;

function stepSection(current: Section, delta: 1 | -1): Section {
	const index = SECTION_ORDER.indexOf(current);
	const next = Math.min(SECTION_ORDER.length - 1, Math.max(0, index + delta));
	return SECTION_ORDER[next];
}

function NavItem({ active, label }: { active: boolean; label: string }) {
	const theme = useTheme();
	return (
		<box flexDirection="row" gap={1}>
			<text fg={active ? theme.colors.primary : theme.colors.muted}>
				{active ? "›" : " "}
			</text>
			<text fg={active ? theme.colors.primary : theme.colors.foreground}>
				{label}
			</text>
		</box>
	);
}

function GatewayNav({ active }: { active: Section }) {
	const theme = useTheme();
	return (
		<box flexDirection="column" gap={1} width={NAV_WIDTH}>
			{NAV_GROUPS.map((group) => (
				<box flexDirection="column" key={group.title ?? "general"}>
					{group.title ? (
						<text fg={theme.colors.mutedForeground}>{group.title}</text>
					) : null}
					{group.items.map((item) => (
						<NavItem
							active={item === active}
							key={item}
							label={SECTION_LABELS[item]}
						/>
					))}
				</box>
			))}
		</box>
	);
}

function DataPanel({ raw, section }: { raw: RawFor; section: Section }) {
	if (section === "overview") {
		return <OverviewPanel raw={raw} />;
	}
	if (section === "routing") {
		return <RoutingPanel raw={raw} />;
	}
	if (section === "guardrails") {
		return <GuardrailsPanel raw={raw} />;
	}
	if (section === "budgets") {
		return <BudgetsPanel raw={raw} />;
	}
	return <KeysPanel raw={raw} />;
}

// The four lighter sections render regardless of the fetch state; the rest need
// the raw status snapshot and show the shared loading/error surfaces first.
function SectionContent({
	section,
	state,
}: {
	section: Section;
	state: LoadState;
}) {
	if (section === "identities") {
		return <IdentitiesPanel />;
	}
	if (section === "channels") {
		return <ChannelsPanel />;
	}
	if (section === "audit") {
		return <AuditPanel />;
	}
	if (section === "evals") {
		return <EvalsPanel />;
	}
	if (state.kind === "idle" || state.kind === "loading") {
		return <Loading label="Loading gateway status…" />;
	}
	if (state.kind === "error") {
		return (
			<ErrorView
				hint="Core may still be starting · press r to retry"
				message="gateway unreachable — Core may still be starting"
			/>
		);
	}
	return <DataPanel raw={state.raw} section={section} />;
}

function GatewayBody(_props: OverlayBodyProps) {
	const theme = useTheme();
	const { state, refresh } = useGatewayStatus();
	const [section, setSection] = useState<Section>("overview");

	useKeyboard((key) => {
		if (key.name === "r") {
			refresh();
			return;
		}
		if (key.name === "down" || key.name === "j") {
			setSection((current) => stepSection(current, 1));
			return;
		}
		if (key.name === "up" || key.name === "k") {
			setSection((current) => stepSection(current, -1));
		}
	});

	return (
		<box flexDirection="column" gap={1}>
			<text fg={theme.colors.mutedForeground}>
				↑/↓ or j/k switch section · r refresh · Esc close
			</text>
			<box flexDirection="row" gap={2}>
				<GatewayNav active={section} />
				<box height={BODY_HEIGHT} width={CONTENT_WIDTH}>
					<scrollbox flexGrow={1}>
						<SectionContent section={section} state={state} />
					</scrollbox>
				</box>
			</box>
		</box>
	);
}

// Local alias so DataPanel's prop type reads clearly; the panels accept RawStatus.
type RawFor = Extract<LoadState, { kind: "ready" }>["raw"];

/** The Gateway overlay module. Registered by the Integrate step under the
 * "gateway" overlay id (registerOverlay(gatewayOverlay)), replacing the skeleton. */
export const gatewayOverlay: OverlayModule = {
	id: "gateway",
	title: "Gateway",
	Body: GatewayBody,
};
