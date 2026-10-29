import type { Node } from "../../src/store/useNodeStore.ts";

export function useActiveNode(): Node {
	return {
		name: "Gateway hooks and MCP proof node",
		token: "hooks-mcp-proof-token",
		url: "http://127.0.0.1:7980",
	};
}
