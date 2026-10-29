import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { aboutYouCacheWarning } from "./prompt-cache-warning.ts";

type PromptEditCacheWarning = (
	changed: readonly string[],
	reach: string
) => { description: string; title: string } | null;

describe("aboutYouCacheWarning", () => {
	test("pins the About you prompt-cache copy", () => {
		expect(aboutYouCacheWarning()).toEqual({
			title: "Apply now? This resets the prompt cache",
			description:
				"About you is part of the system prompt for every thread on this node. Each thread's next message re-sends its whole conversation at the full input price, once; replies after that are cached again. Switching models costs the same.",
		});
	});

	test("matches the shared desktop helper word for word", async () => {
		// A computed path keeps the CLI typecheck out of the blocks package; the
		// module is only loaded at test time to compare the copy.
		const sharedPath = join(
			import.meta.dir,
			"../../../../../packages/blocks/src/desktop/agent-elements/prompt-cache.ts"
		);
		const shared = (await import(sharedPath)) as {
			promptEditCacheWarning: PromptEditCacheWarning;
		};
		expect(aboutYouCacheWarning()).toEqual(
			shared.promptEditCacheWarning(["About you"], "all-threads") ?? {
				description: "",
				title: "",
			}
		);
	});
});
