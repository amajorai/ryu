import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PlatformStory } from "./platform-story.tsx";

test("platform story exposes the hierarchy, integration paths, capabilities, and showcase", () => {
	const html = renderToStaticMarkup(<PlatformStory />);

	expect(html).toContain('data-testid="platform-story-full"');
	expect(html).toContain('data-testid="platform-hierarchy"');
	for (const label of [
		"Deploy",
		"SDK",
		"Core",
		"Gateway",
		"Bot",
		"Console",
		"Apps",
		"Gateway endpoint",
		"ACP + A2A",
		"GitHub Actions",
		"Fine-tuning",
		"Update Night",
	]) {
		expect(html).toContain(label);
	}
	expect(html).toContain('href="https://github.com/amajorai/updatenight"');
	expect(html).toContain("https://docs.ryuhq.com/docs/extend/develop/sdk");
	expect(html).not.toContain('href="/docs/');
	expect(html).toContain("Core runs the platform.");
	expect(html).toContain("Gateway secures model access and spending.");
	expect(html).toContain("Servers");
	expect(html).not.toContain("Nodes");
});
