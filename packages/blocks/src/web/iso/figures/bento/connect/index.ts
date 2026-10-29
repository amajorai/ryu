import type { BentoDrawings } from "../card.ts";
import { drawing as anyMcpClient } from "./any-mcp-client.tsx";
import { drawing as hostedSkills } from "./hosted-skills.tsx";
import { drawing as mcpOrRest } from "./mcp-or-rest.tsx";
import { drawing as triggerEvents } from "./trigger-events.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Hosted Skills": hostedSkills,
	"Any MCP client": anyMcpClient,
	"MCP or REST": mcpOrRest,
	"Trigger events": triggerEvents,
};
