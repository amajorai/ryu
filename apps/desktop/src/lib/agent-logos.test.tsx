import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	AgentAvatar,
	AgentAvatarStack,
	AgentLogo,
	agentLogoSrc,
	getEngineIcon,
	personaToGlyph,
} from "./agent-logos.tsx";

describe("agent logo ownership", () => {
	it("uses registry brand art after normalizing the actual engine identifier", () => {
		const markup = renderToStaticMarkup(
			<AgentLogo engine="acp:cursor" size="16px" />
		);
		expect(markup).toContain("/assets/logos/cursor_light.svg");
		expect(markup).toContain("/assets/logos/cursor_dark.svg");
		expect(markup).toContain("--agent-logo-size:16px");
		expect(markup).toContain("size-(--agent-logo-size)");
	});
	it("keeps glyph inheritance distinct from engine logo presentation", () => {
		const glyph = renderToStaticMarkup(
			<AgentAvatar
				className="size-4 shrink-0"
				glyph={{ kind: "emoji", emoji: "A" }}
				presentation="compact"
				size="16px"
			/>
		);
		expect(glyph).toContain("rounded-inherit");
		expect(glyph).toContain("object-cover");
		expect(glyph).not.toContain("rounded-glyph-compact");
		const engine = renderToStaticMarkup(
			<AgentAvatar
				className="size-4 shrink-0"
				engine="claude"
				presentation="compact"
				size="16px"
			/>
		);
		expect(engine).toContain("rounded-glyph-compact");
		expect(engine).toContain("object-contain");
	});
	it("preserves avatar selection priority and omits absent optional layers", () => {
		expect(
			personaToGlyph({
				avatarUrl: "https://example.com/avatar.png",
				emoji: "A",
				icon: "calendar",
			})
		).toEqual({ kind: "avatar", dataUrl: "https://example.com/avatar.png" });
		expect(personaToGlyph({ emoji: "A", icon: "calendar" })).toEqual({
			kind: "emoji",
			emoji: "A",
		});
		expect(personaToGlyph({ icon: "calendar", iconColor: "red" })).toEqual({
			kind: "icon",
			id: "calendar",
			color: "red",
		});
		expect(personaToGlyph({})).toBeNull();
	});
	it("keeps engine icon component references stable across normalized identifiers", () => {
		expect(getEngineIcon("acp:claude")).toBe(getEngineIcon("claude"));
		expect(getEngineIcon(null)).toBe(getEngineIcon(undefined));
	});
	it("retains exactly three stacked members with the original front-to-back order", () => {
		const markup = renderToStaticMarkup(
			<AgentAvatarStack
				members={[
					{ id: "a", engine: "claude" },
					{ id: "b", engine: "codex" },
					{ id: "c", engine: "gemini" },
					{ id: "d", engine: "cursor" },
				]}
			/>
		);
		expect(markup).toContain("z-3");
		expect(markup).toContain("z-2");
		expect(markup).toContain("z-1");
		expect(markup).not.toContain("cursor_light.svg");
	});

	it("resolves a static logo path for notification images", () => {
		expect(agentLogoSrc("acp:claude")).toBe("/assets/logos/claude.svg");
		expect(agentLogoSrc("codex")).toBe("/assets/logos/openai_light.svg");
		expect(agentLogoSrc("acp:cursor")).toBe("/assets/logos/cursor_light.svg");
		expect(agentLogoSrc("unknown-engine")).toBe("/assets/logos/ryu_light.svg");
		expect(agentLogoSrc(null)).toBe("/assets/logos/ryu_light.svg");
	});
});
