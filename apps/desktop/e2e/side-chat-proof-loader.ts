let initScript: Promise<string> | undefined;
/** Native browser codecs run in the same realm as the fixture transport. */
export function sideChatCodecScript() {
	initScript ??= (async () => {
		const result = await Bun.build({
			entrypoints: [
				new URL("./side-chat-proof.browser.ts", import.meta.url).pathname,
			],
			target: "browser",
			format: "iife",
		});
		if (!result.success) {
			throw new AggregateError(
				result.logs,
				"Could not compile native side-chat proof codecs"
			);
		}
		const [output] = result.outputs;
		if (!output) {
			throw new Error("Missing native side-chat proof codec artifact");
		}
		return output.text();
	})();
	return initScript;
}
