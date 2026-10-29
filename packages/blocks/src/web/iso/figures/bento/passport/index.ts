import type { BentoDrawings } from "../card.ts";
import { drawing as auditedReads } from "./audited-reads.tsx";
import { drawing as importASession } from "./import-a-session.tsx";
import { drawing as mcpSignIns } from "./mcp-sign-ins.tsx";
import { drawing as profilesAndDomains } from "./profiles-and-domains.tsx";
import { drawing as tenantSeparated } from "./tenant-separated.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Profiles and domains": profilesAndDomains,
	"Import a session": importASession,
	"Audited reads": auditedReads,
	"Tenant-separated": tenantSeparated,
	"MCP sign-ins": mcpSignIns,
};
