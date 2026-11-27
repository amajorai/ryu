import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RailLogo } from "@/src/lib/usage-rail/usage-rail-sources.ts";
import { RailLogoMark, type RailLogoSize } from "./usage-rail-logo.tsx";

// The mark in the middle of a ring tells the sources apart at a glance: the
// provider's brand mark, the agent's avatar, or one letter of the name. The
// ring's button carries the accessible name, so a brand mark and a letter are
// decoration and stay out of the accessibility tree.

function mark(logo: RailLogo, size: RailLogoSize = 14, className?: string) {
	return renderToStaticMarkup(
		<RailLogoMark className={className} logo={logo} size={size} />
	);
}

/** The letter a mark shows, or null when it draws a picture instead. */
function letter(logo: RailLogo): string | null {
	return mark(logo).match(/<span[^>]*>([^<]*)<\/span>/)?.[1] ?? null;
}

describe("the mark of a provider", () => {
	test("a provider with a bundled mark shows it, as decoration", () => {
		const html = mark({
			kind: "provider",
			key: "claude-pro-max Claude Pro/Max",
		});
		expect(html).toContain('src="/logos/claude.svg"');
		expect(html).toContain('alt=""');
		expect(html).toContain('aria-hidden="true"');
		expect(html).not.toContain("<span");
	});

	test("the mark is 14 pixels inside a ring and 16 at the head of a card", () => {
		const logo: RailLogo = { kind: "provider", key: "claude-pro-max Claude" };
		expect(mark(logo, 14)).toContain('height="14"');
		expect(mark(logo, 14)).toContain('width="14"');
		expect(mark(logo, 16)).toContain('height="16"');
		expect(mark(logo, 16)).toContain('width="16"');
	});

	test("a mark with a light and a dark drawing renders both, one per theme", () => {
		const html = mark({ kind: "provider", key: "openai-codex ChatGPT" });
		expect(html).toContain('src="/logos/openai.svg"');
		expect(html).toContain('src="/logos/openai_dark.svg"');
		expect(html).toContain("dark:hidden");
		expect(html).toContain("dark:block");
	});

	test("a provider with no bundled mark shows the first letter of its label", () => {
		expect(letter({ kind: "provider", key: "zed-ai Zed" })).toBe("Z");
		// The label gives the letter, not the id, and its first word, not its last.
		expect(letter({ kind: "provider", key: "acme-max Zed Pro" })).toBe("Z");
		expect(letter({ kind: "provider", key: "acme-max Team plan" })).toBe("T");
	});

	test("a key with no label falls back to the letter of the id", () => {
		// A pool whose provider is missing from the snapshot gives "<id> ".
		expect(letter({ kind: "provider", key: "acme-max " })).toBe("a");
		expect(letter({ kind: "provider", key: "acme-max" })).toBe("a");
	});

	test("a label that starts with an emoji keeps the whole character", () => {
		expect(letter({ kind: "provider", key: "acme-max 🚀 Rocket" })).toBe("🚀");
	});

	test("a Ryu managed provider never shows the supplier's mark", () => {
		const html = mark({
			kind: "provider",
			key: "managed-anthropic-credits Ryu Code",
		});
		expect(html).not.toContain("<img");
		expect(html).not.toContain("claude");
		expect(letter({ kind: "provider", key: "managed Ryu Fast" })).toBe("R");
	});

	test("an empty key still draws a mark", () => {
		expect(letter({ kind: "provider", key: "" })).toBe("?");
		expect(letter({ kind: "provider", key: "   " })).toBe("?");
	});
});

describe("the letter of a pool that mixes providers", () => {
	test("shows the letter it was given, in capitals, as decoration", () => {
		const html = mark({ kind: "initial", text: "w" });
		expect(letter({ kind: "initial", text: "w" })).toBe("w");
		// The class draws it in capitals; the text itself is left as the name has it.
		expect(html).toContain("uppercase");
		expect(html).toContain('aria-hidden="true"');
		// One letter of a name is not a sentence to translate.
		expect(html).toContain('data-ryu-i18n="off"');
	});

	test("a pool with no name still draws a mark", () => {
		expect(letter({ kind: "initial", text: "" })).toBe("?");
	});

	test("the letter is smaller inside a ring than at the head of a card", () => {
		const logo: RailLogo = { kind: "initial", text: "W" };
		expect(mark(logo, 14)).toContain("size-3.5");
		expect(mark(logo, 14)).not.toContain("size-4");
		expect(mark(logo, 16)).toContain("size-4");
		expect(mark(logo, 16)).not.toContain("size-3.5");
	});
});

describe("the mark of an agent on its own sign-in", () => {
	test("an agent with no avatar shows the logo of its engine", () => {
		const html = mark({ kind: "agent", avatarUrl: null, engine: "claude" });
		expect(html).toContain('src="/assets/logos/claude.svg"');
		expect(html).toContain("--agent-logo-size:14px");
		expect(html).not.toContain("<span");
	});

	test("the agent's own avatar wins over the engine logo", () => {
		const html = mark({
			kind: "agent",
			avatarUrl: "https://example.test/avatar.png",
			engine: "claude",
		});
		expect(html).toContain('src="https://example.test/avatar.png"');
		expect(html).not.toContain("/assets/logos/claude.svg");
	});

	test("an agent with no engine and no avatar still draws a picture, not a letter", () => {
		const html = mark({ kind: "agent", avatarUrl: null, engine: null }, 16);
		expect(html).toContain("<svg");
		expect(html).toContain("--logo-size:16px");
		expect(html).not.toContain("<span");
	});
});

describe("every kind of mark", () => {
	const logos: RailLogo[] = [
		{ kind: "provider", key: "claude-pro-max Claude Pro/Max" },
		{ kind: "provider", key: "zed-ai Zed" },
		{ kind: "initial", text: "W" },
		{ kind: "agent", avatarUrl: null, engine: "claude" },
		{ kind: "agent", avatarUrl: null, engine: null },
	];

	test("keeps its size in a tight ring and takes the caller's class", () => {
		for (const logo of logos) {
			const html = mark(logo, 14, "ring-mark");
			expect(html).toContain("shrink-0");
			expect(html).toContain("ring-mark");
		}
	});
});
