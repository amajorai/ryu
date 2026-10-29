import type { BentoDrawings } from "../card.ts";
import { drawing as gitNativeWorkspace } from "./git-native-workspace.tsx";
import { drawing as runsAnywhere } from "./runs-anywhere.tsx";
import { drawing as sessionsAndMemory } from "./sessions-and-memory.tsx";
import { drawing as subAgentsAndWorkflows } from "./sub-agents-and-workflows.tsx";
import { drawing as toolsViaMcp } from "./tools-via-mcp.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Sub-agents and workflows": subAgentsAndWorkflows,
	"Sessions and memory": sessionsAndMemory,
	"Tools via MCP": toolsViaMcp,
	"Git-native workspace": gitNativeWorkspace,
	"Runs anywhere": runsAnywhere,
};
