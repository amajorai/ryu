// Shared fixtures for the agent-egress suites (agent-egress*.test.ts): the
// Rust mirror readers and the classifier's catalog and preference builders.
// See agent-egress.test.ts for why these tests parse Core's Rust.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formatMessage } from "@ryu/i18n";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	type AgentEgress,
	classifyAgentEgress,
	type EgressPrefs,
} from "./agent-egress.ts";
import type { AgentCatalogEntry } from "./agents.ts";

export const tl: LiteralMessage = (source, values) =>
	formatMessage(source, values ?? {});

// src/lib/api → src/lib → src → apps/desktop → apps → repo root.
const REPO_ROOT = join(import.meta.dir, "../../../../..");

/** The mirror under test; named in every anchor diagnostic. */
export const AGENT_EGRESS_TS = "apps/desktop/src/lib/api/agent-egress.ts";

export function rustSource(relative: string): string {
	const path = join(REPO_ROOT, relative);
	try {
		return readFileSync(path, "utf8");
	} catch (e) {
		throw new Error(
			`mirror test cannot read ${relative} (resolved ${path}): ${e instanceof Error ? e.message : e}`
		);
	}
}

/**
 * Drop `//` line comments, then collapse whitespace runs to one space, so
 * neither `cargo fmt` nor a reworded doc comment can break an anchor. Stripping
 * only ever REMOVES text, so it cannot turn a stale mirror into a passing one.
 */
export const squeeze = (s: string): string =>
	s
		.replaceAll(/^[ \t]*\/\/.*$/gm, "")
		.replaceAll(/\s+/g, " ")
		.trim();

/**
 * Assert a literal Rust expression is still present in `file`, whitespace-
 * insensitively. Returns a marker string rather than asserting inline (Biome's
 * `noMisplacedAssertion` rejects an `expect` outside an `it`, and a returned
 * diagnostic shows the reader WHY the mirror is stale, not just that it is).
 */
export const PRESENT = "present";
export function anchor(file: string, expression: string): string {
	const body = squeeze(rustSource(file));
	if (body.includes(squeeze(expression))) {
		return PRESENT;
	}
	return (
		`mirror test anchor lost its target: \`${expression}\` is no longer in ${file}. ` +
		`${AGENT_EGRESS_TS} claims to reproduce that default; re-check the mirror ` +
		"against whatever replaced it, then re-point this anchor."
	);
}

/** Same reader as the Rust mirrors; the wording mirror is TypeScript. */
export const repoSource = rustSource;

/** The other UI over `claude-`/`codex-`/`agent-gateway-routing`. */
export const AGENT_EDIT_TSX = "packages/blocks/src/desktop/agent-edit.tsx";

/** Core's `agent_route`: which route each agent family takes. */
export const AGENT_ROUTE_RS =
	"apps/core/src/sidecar/adapters/adapter_core/agent_route_jwt.rs";
/** The flagship's (`ryu`) spawn: its Gateway env and managed-Pi fallback. */
export const RYU_ROUTE_RS =
	"apps/core/src/sidecar/adapters/adapter_core/ryu_route.rs";
/** Spawn commands for the gateway-routed ACP families and registry agents. */
export const ACP_GATEWAY_CMDS_RS =
	"apps/core/src/sidecar/adapters/acp/gateway_cmds.rs";
/** The managed Pi (`ryu-pi-acp`) spawn command. */
export const ACP_PI_CMD_RS = "apps/core/src/sidecar/adapters/acp/pi_cmd.rs";
/**
 * Every source of `AcpAgentRegistry` entries: the hand-written built-in and
 * curated rows, and the constructor for agents from the upstream registry.
 */
export const ACP_REGISTRY_RS = [
	"apps/core/src/sidecar/adapters/acp/registry_builtin.rs",
	"apps/core/src/sidecar/adapters/acp/registry_curated.rs",
	ACP_GATEWAY_CMDS_RS,
];
/** Owner of both gates and both defaults. */
export const AGENT_ROUTING_RS = "apps/core/src/agent_routing/mod.rs";
/** Where the bridge decision is actually taken, per ACP instance. */
export const ACP_TOOL_ACCESS_RS =
	"apps/core/src/sidecar/adapters/acp/tool_access.rs";
/** Ships the flagship's alternative tool path. */
export const PI_CONFIG_RS = "apps/core/src/pi_config/mod.rs";

const ADAPTERS_DIR = "apps/core/src/sidecar/adapters";
/** Every non-test Rust source of Core's chat adapters, ACP submodules included. */
export function adapterSources(): string[] {
	return readdirSync(join(REPO_ROOT, ADAPTERS_DIR), {
		encoding: "utf8",
		recursive: true,
	})
		.map((file) => file.replaceAll("\\", "/"))
		.filter(
			(file) => file.endsWith(".rs") && !/(^|[/_])tests?([/._]|$)/.test(file)
		)
		.sort()
		.map((file) => rustSource(`${ADAPTERS_DIR}/${file}`));
}

// ── Classifier fixtures ──────────────────────────────────────────────────────

export const prefs = (over: Partial<EgressPrefs>): EgressPrefs => ({
	agents: {},
	claude: true,
	codex: true,
	piRouting: "gateway",
	// Empty, i.e. no agent has an explicit tool-bridge entry — which is the state
	// every agent on a real node is in until someone touches the panel, and the
	// state Core reads as ON.
	tools: {},
	...over,
});

export const entry = (
	over: Partial<AgentCatalogEntry> & { id: string }
): AgentCatalogEntry => ({
	added: true,
	available: true,
	bridgeVersionStatus: null,
	description: null,
	detected: null,
	engine: null,
	gatewayBypass: false,
	iconUrl: null,
	installedBridgeVersion: null,
	installedVersion: null,
	installHint: null,
	latestBridgeVersion: null,
	latestVersion: null,
	name: over.id,
	recommended: false,
	registryId: null,
	transport: "acp",
	versionStatus: null,
	...over,
});

/** A catalog in the same declaration order Core's registry uses. */
export const CATALOG: AgentCatalogEntry[] = [
	entry({ id: "ryu" }),
	entry({ id: "acp:claude", gatewayBypass: true }),
	entry({ id: "acp:codex" }),
	entry({ id: "acp:gemini", gatewayBypass: true }),
	// `registry_id: Some("pi-acp")` verbatim from Core's entry — it is one of the
	// two ways the tool-bridge mirror recognises a pi-acp spawn.
	entry({ id: "acp:pi", registryId: "pi-acp" }),
	entry({ id: "openclaw", gatewayBypass: true }),
	entry({ id: "zeroclaw", transport: "openai_compat" }),
];

export const classify = (
	agent: { engine: string | null; flagship?: boolean; id: string },
	over: Partial<EgressPrefs> = {}
): AgentEgress =>
	classifyAgentEgress(
		{
			id: agent.id,
			name: agent.id,
			engine: agent.engine,
			flagship: agent.flagship ?? false,
		},
		CATALOG,
		prefs(over),
		tl
	);
