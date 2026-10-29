/* @jsxImportSource @opentui/react */
import { expect, spyOn, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { Markdown } from "../../components/ui/markdown.tsx";
import { ThemeProvider } from "../../components/ui/theme-provider.tsx";

const SENTINEL = "Finished paragraph sentinel.";

test("streaming into the last paragraph leaves finished paragraphs unrendered", async () => {
	// Every render of a text unit runs the heading regexes on each of its lines,
	// so heading `match` calls on the sentinel line count renders of its
	// paragraph. Block parsing (the fence regex) still runs once per token.
	const originalMatch = String.prototype.match;
	// SAFETY: lib.es5 String.match accepts string | RegExp; the native
	// lib.es2015.symbol.wellknown overload additionally accepts Symbol.match.
	// Function.apply selects only the last overload. This callable declaration
	// retains both published inputs and the original receiver/result/error.
	const nativeMatch = originalMatch as (
		this: string,
		pattern: string | RegExp | Parameters<typeof originalMatch>[0]
	) => ReturnType<typeof originalMatch>;
	let sentinelRenders = 0;
	const match = spyOn(String.prototype, "match").mockImplementation(function (
		this: string,
		...args: Parameters<typeof nativeMatch>
	) {
		const [pattern] = args;
		if (
			String(this) === SENTINEL &&
			pattern instanceof RegExp &&
			pattern.source.startsWith("^#")
		) {
			sentinelRenders++;
		}
		return nativeMatch.apply(this, args);
	});

	let append!: (text: string) => void;
	function View() {
		const [tail, setTail] = useState("Streaming");
		append = (text) => setTail((current) => current + text);
		return (
			<ThemeProvider>
				<Markdown>{`${SENTINEL}\n\n\`\`\`ts\nconst done = true;\n\`\`\`\n\n${tail}`}</Markdown>
			</ThemeProvider>
		);
	}

	const setup = await testRender(<View />, { width: 80, height: 20 });
	try {
		await setup.renderOnce();
		const settled = sentinelRenders;
		expect(settled).toBeGreaterThan(0);
		for (let chunk = 0; chunk < 30; chunk++) {
			await act(async () => {
				append(` word${chunk}`);
			});
		}
		await setup.renderOnce();
		expect(sentinelRenders).toBe(settled);
		expect(setup.captureCharFrame()).toContain("word29");
	} finally {
		match.mockRestore();
		setup.renderer.destroy();
	}
});
