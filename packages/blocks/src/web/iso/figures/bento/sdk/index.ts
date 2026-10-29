import type { BentoDrawings } from "../card.ts";
import { drawing as gatewayRoutedModels } from "./gateway-routed-models.tsx";
import { drawing as mcpBuiltIn } from "./mcp-built-in.tsx";
import { drawing as projectScaffold } from "./project-scaffold.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Gateway-routed models": gatewayRoutedModels,
	"MCP built in": mcpBuiltIn,
	"Project scaffold": projectScaffold,
};
