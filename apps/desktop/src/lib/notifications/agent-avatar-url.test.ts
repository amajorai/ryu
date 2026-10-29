import { describe, expect, test } from "bun:test";
import { agentAvatarUrl, twemojiCode } from "./agent-avatar-url.ts";

const base = { id: "nova", name: "Nova" };

describe("agentAvatarUrl", () => {
	test("uploaded images are used as they are", () => {
		expect(
			agentAvatarUrl({
				...base,
				avatarGlyph: { kind: "avatar", dataUrl: "data:image/png;base64,AAAA" },
			})
		).toBe("data:image/png;base64,AAAA");
		expect(
			agentAvatarUrl({ ...base, avatarUrl: "https://cdn.example.com/n.png" })
		).toBe("https://cdn.example.com/n.png");
	});

	test("DiceBear and emoji avatars become PNG URLs", () => {
		expect(
			agentAvatarUrl({
				...base,
				avatarGlyph: { kind: "dicebear", style: "notionists", seed: "nova" },
			})
		).toBe("https://api.dicebear.com/9.x/notionists/png?seed=nova&size=192");
		expect(
			agentAvatarUrl({
				...base,
				avatarGlyph: { kind: "emoji", emoji: "🦊" },
			})
		).toBe(
			"https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/1f98a.png"
		);
		expect(twemojiCode("❤️")).toBe("2764");
	});

	test("icon and dither avatars send only the initial and colour", () => {
		expect(
			agentAvatarUrl({
				...base,
				avatarGlyph: {
					kind: "icon",
					id: "hugeicons:robot-01",
					color: "#3B82F6",
				},
			})
		).toBe(
			"https://api.dicebear.com/9.x/initials/png?seed=N&size=192&backgroundColor=3b82f6"
		);
		expect(
			agentAvatarUrl({
				...base,
				avatarGlyph: {
					kind: "dither",
					dither: { from: "purple", to: null, direction: "up" },
				},
			})
		).toEndWith("backgroundColor=966eff");
		expect(agentAvatarUrl({ ...base, avatarGlyph: null })).toContain(
			"/initials/png?seed=N&"
		);
	});

	test("unsafe uploads fall back to the initial", () => {
		expect(
			agentAvatarUrl({
				...base,
				avatarGlyph: { kind: "avatar", dataUrl: "javascript:alert(1)" },
			})
		).toContain("/initials/png?");
	});
});
