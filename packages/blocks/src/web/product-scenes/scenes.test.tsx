import { describe, expect, it } from "bun:test";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentsScene } from "./agents.tsx";
import { BotScene } from "./bot.tsx";
import { CloudScene } from "./cloud.tsx";
import { ConsoleScene } from "./console.tsx";
import { CoreProductScene } from "./core.tsx";
import { DesktopProductScene } from "./desktop.tsx";
import { GatewayScene } from "./gateway.tsx";
import { MarketplaceScene } from "./marketplace.tsx";
import { SdkScene } from "./sdk.tsx";
import { SkillsScene } from "./skills.tsx";

const { default: coreStyles } = await import("./core.module.css");

/** Every homepage scene, with the words it must draw to explain itself. */
const SCENES: readonly [string, ComponentType, readonly string[]][] = [
	[
		"gateway",
		GatewayScene,
		["agent", "gateway", "model", "backup", "tool", "approve?", "approved"],
	],
	[
		"console",
		ConsoleScene,
		["models", "tools", "approvals", "support", "research", "history"],
	],
	["bot", BotScene, ["write the launch notes", "post to #launch?", "approve"]],
	[
		"desktop",
		DesktopProductScene,
		["agents", "claude code", "codex", "model", "your key", "plan", "local"],
	],
	["agents", AgentsScene, ["agent", "model", "voice", "tools", "memory"]],
	["skills", SkillsScene, ["skills.sh", "SKILL.md", "skills/"]],
	["marketplace", MarketplaceScene, ["agent", "skill", "tool", "mcp", "get"]],
	["sdk", SdkScene, ["defineAgent({", "chat", "memory", "mcp", "agent"]],
	["core", CoreProductScene, ["task", "core", "claude code", "codex", "git"]],
	["cloud", CloudScene, ["cloud", "asleep", "awake", "models", "tools"]],
];

const count = (haystack: string, needle: string) =>
	haystack.split(needle).length - 1;

describe("homepage product scenes", () => {
	for (const [id, Scene, labels] of SCENES) {
		describe(id, () => {
			const html = renderToStaticMarkup(<Scene />);

			it("renders one decorative card visual on the shared canvas", () => {
				expect(count(html, `data-testid="realm-visual-${id}"`)).toBe(1);
				expect(html).toContain('aria-hidden="true"');
				expect(count(html, 'viewBox="0 0 296 176"')).toBe(1);
				expect(html).toContain("data-scene-canvas");
			});

			it("centres the canvas on the shared stage at no more than its own size", () => {
				expect(count(html, 'preserveAspectRatio="xMidYMid meet"')).toBe(1);
				expect(html).toMatch(/class="[^"]*items-center[^"]*justify-center/);
				expect(html).toContain("max-height:176px;max-width:296px");
			});

			it("is deterministic with no generated ids", () => {
				expect(renderToStaticMarkup(<Scene />)).toBe(html);
				expect(html).not.toMatch(/\sid="/);
				expect(html).not.toMatch(/:r[0-9a-z]+:|«r/);
				expect(html).not.toContain("url(#");
			});

			it("labels what it shows in the shared type size", () => {
				for (const label of labels) {
					expect(html).toContain(`>${label}</text>`);
				}
				expect(html).not.toContain("font-size");
			});

			it("uses only the shared accent and draws with transforms", () => {
				expect(html).not.toMatch(/realm-(complete|progress|review)/);
				expect(html).not.toContain("pathLength");
				expect(html).not.toContain("stroke-dash");
			});
		});
	}

	it("spawns Core's sub-agents from the hub's face, clear of its label", () => {
		const html = renderToStaticMarkup(<CoreProductScene />);
		const subs = [
			...html.matchAll(
				new RegExp(
					`<circle class="[^"]*${coreStyles.sub}[^"]*" cx="([\\d.]+)"`,
					"g"
				)
			),
		].map((match) => Number(match[1]));

		expect(subs).toHaveLength(2);
		// The hub is 44 wide around x 148 and the "core" label sits at its centre.
		for (const cx of subs) {
			expect(cx).toBe(126);
		}
	});
});
