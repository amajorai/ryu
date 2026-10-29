import type { BentoDrawings } from "../card.ts";
import { drawing as approvalRules } from "./approval-rules.tsx";
import { drawing as builtInServers } from "./built-in-servers.tsx";
import { drawing as oneAgentOneLink } from "./one-agent-one-link.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"One agent, one link": oneAgentOneLink,
	"Built-in servers": builtInServers,
	"Approval rules": approvalRules,
};
