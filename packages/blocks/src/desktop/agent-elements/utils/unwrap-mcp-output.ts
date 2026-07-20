// Unwrap an MCP/tool output into its underlying value. MCP results arrive as a
// `{ type: "text", text }` block (or an array of them), often wrapping JSON;
// this peels that envelope and parses embedded JSON when present. Pure (no UI
// imports) so consumers stay decoupled from renderer modules.
// biome-ignore lint/suspicious/noExplicitAny: tolerates arbitrary tool payloads
export function unwrapMcpOutput(output: any): any {
	if (!output) {
		return output;
	}
	if (Array.isArray(output)) {
		const textParts: string[] = [];
		for (const block of output) {
			if (block?.type === "text" && typeof block?.text === "string") {
				textParts.push(block.text);
			}
		}
		if (textParts.length > 0) {
			const combined = textParts.join("");
			try {
				return JSON.parse(combined);
			} catch {
				return combined;
			}
		}
		return output;
	}
	if (output?.type === "text" && typeof output?.text === "string") {
		try {
			return JSON.parse(output.text);
		} catch {
			return output.text;
		}
	}
	if (typeof output === "string") {
		try {
			return JSON.parse(output);
		} catch {
			return output;
		}
	}
	return output;
}
