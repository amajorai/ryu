import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A bot draws from an account pool, so a meter beside one bot or in the
// composer says nothing true. These surfaces must stay free of one: the usage
// of the accounts shows in the rings at the side (`components/usage-rail`).
// The check reads the sources, because each of these surfaces mounts only
// inside the whole signed-in shell.

const DESKTOP = new URL("../../../", import.meta.url);

function source(path: string): string {
	return readFileSync(fileURLToPath(new URL(path, DESKTOP)), "utf8");
}

/** Every way a surface could draw a per bot usage meter. */
const METER_MARKS = [
	"usage-bar.tsx",
	"usage-bar-meters.tsx",
	"usage-badges.tsx",
	"useAgentUsage",
	"<UsageBar",
	"<AgentUsageBadge",
];

const SURFACES_WITHOUT_A_METER = [
	// The bot rows of the full sidebar, both row styles.
	"src/components/layout/sidebar-agent-rows.tsx",
	"src/components/layout/sidebar-agents-section.tsx",
	// The bot avatars of the narrow rail.
	"src/components/layout/compact-rail-agents.tsx",
	// The composer: the control cluster and the trigger of its settings menu.
	"components/agent-elements/input/composer-agent-controls.tsx",
	"components/agent-elements/input/composer-settings-menu.tsx",
];

describe("the surfaces that lost their usage meter", () => {
	for (const path of SURFACES_WITHOUT_A_METER) {
		test(`${path} draws no usage meter`, () => {
			const text = source(path);
			for (const mark of METER_MARKS) {
				expect(text.includes(mark)).toBe(false);
			}
		});
	}

	test("the picker keeps a meter on a provider row and none on a bot row", () => {
		const rows = source(
			"components/agent-elements/input/universal-picker-row-renderers.tsx"
		);
		expect(rows.includes("<UsageBar")).toBe(false);
		expect(rows.includes("<AgentUsageBadge")).toBe(false);
		const providers = source(
			"components/agent-elements/input/universal-picker-target-sub.tsx"
		);
		expect(providers.includes("<UsageBar agentId={provider.id}")).toBe(true);
	});

	test("the composer settings menu has no slot a meter could come back through", () => {
		const types = source(
			"components/agent-elements/input/composer-settings-menu-types.ts"
		);
		expect(types.includes("trailing?: ReactNode")).toBe(false);
	});

	test("both side strips mount the usage rings", () => {
		expect(
			source("src/components/layout/AppSidebar.tsx").includes(
				"<SidebarUsageRow rail={usageRail} />"
			)
		).toBe(true);
		expect(
			source("src/components/layout/CompactRail.tsx").includes(
				"<CompactRailUsage rosterRef={rosterRef} />"
			)
		).toBe(true);
	});
});
