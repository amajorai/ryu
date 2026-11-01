import { beforeAll, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ASSISTANT_LIGHT_SCHEME_CLASS } from "./color-scheme.tsx";
import { loadAssistantSession } from "./deferred-session.tsx";
import { RyuAssistantWidget } from "./public-widget.tsx";
import {
	ASSISTANT_GLASS_CHROME,
	ASSISTANT_GLASS_FILL,
	ASSISTANT_ISLAND_LAUNCHER_SKIN,
} from "./skin.ts";

// The panel is code-split; once its chunk settles, use() renders it synchronously.
beforeAll(async () => {
	await loadAssistantSession();
});

describe("RyuAssistantWidget theme", () => {
	test("wears Desktop's themed Ask Ryu glass instead of forcing dark mode", () => {
		const markup = renderToStaticMarkup(
			<RyuAssistantWidget inline openOnMount showLauncher={false} />
		);

		expect(markup).toContain(ASSISTANT_GLASS_FILL);
		expect(markup).toContain(ASSISTANT_GLASS_CHROME);
		expect(markup).not.toContain('class="dark ');
		// The surface itself wears theme tokens only: no forced background, no
		// gradient and no raw palette colour. (The composer inside keeps its own
		// token fill.)
		const surface = markup.slice(0, markup.indexOf(">"));
		expect(surface).not.toContain("bg-background");
		expect(surface).not.toContain("gradient");
		expect(surface).not.toContain("neutral-");
		// The session chunk rendered: the empty start greets instead of a title.
		expect(markup).toContain("How can I help?");
	});

	test("auto renders without a pinned scheme until it reads the host", () => {
		const markup = renderToStaticMarkup(<RyuAssistantWidget />);
		expect(markup).not.toContain("data-ryu-color-scheme");
		expect(markup).not.toContain(ASSISTANT_LIGHT_SCHEME_CLASS);
	});

	test("a pinned theme scopes the widget to that scheme", () => {
		const dark = renderToStaticMarkup(<RyuAssistantWidget theme="dark" />);
		expect(dark).toContain('class="dark"');
		expect(dark).toContain('data-ryu-color-scheme="dark"');
		expect(dark).toContain("color-scheme:dark");

		const light = renderToStaticMarkup(
			<RyuAssistantWidget
				inline
				openOnMount
				showLauncher={false}
				theme="light"
			/>
		);
		const surface = light.slice(0, light.indexOf(">"));
		expect(surface).toContain(ASSISTANT_LIGHT_SCHEME_CLASS);
		expect(surface).toContain('data-ryu-color-scheme="light"');
	});
});

describe("RyuAssistantWidget launcher", () => {
	test("wears the Island's logo circle instead of the panel glass", () => {
		const markup = renderToStaticMarkup(<RyuAssistantWidget />);
		const buttonStart = markup.indexOf("<button");
		const button = markup.slice(buttonStart, markup.indexOf(">", buttonStart));
		expect(button).toContain('aria-label="Open Ask Ryu"');
		expect(button).toContain(ASSISTANT_ISLAND_LAUNCHER_SKIN);
		expect(button).not.toContain(ASSISTANT_GLASS_FILL);
		expect(markup).toContain('data-ryu-launcher-face="island"');
		expect(markup).toContain('data-slot="glass-scrim-card"');
	});
});
