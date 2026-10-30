import { z } from "zod";

export const mcpJsonPayloadSchema = z.json();
export type McpJsonPayload = z.infer<typeof mcpJsonPayloadSchema>;
