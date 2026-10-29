import { z } from "zod";
import { pluginDocumentSchema } from "../src/lib/api/plugin-wire-values.ts";
import type {
	DockPanelRequest,
	TerminalCommandRequest,
} from "../src/store/useDockPanelRequestStore.ts";

const requestFields = z.object({
	body: pluginDocumentSchema.nullable(),
	method: z.string(),
	origin: z.string(),
	path: z.string(),
});
export type WorkspaceFixtureRequest = z.output<typeof requestFields>;
const requestsSchema = z.array(
	z.custom<WorkspaceFixtureRequest>(
		(value) => requestFields.safeParse(value).success
	)
);
const recentsSchema = z.array(z.string());
const environmentFields = z.record(z.string(), z.string());
const environmentsSchema = z.custom<z.output<typeof environmentFields>>(
	(value) => environmentFields.safeParse(value).success
);
const commandFields = z.object({
	command: z.string(),
	cwd: z.string().nullable(),
	env: environmentFields.optional(),
	shell: z.string().nullable(),
}) satisfies z.ZodType<TerminalCommandRequest>;
const terminalFields = z.object({
	command: commandFields.optional(),
	kind: z.string(),
	label: z.string(),
	nonce: z.number(),
	side: z.enum(["bottom", "right"]).optional(),
}) satisfies z.ZodType<DockPanelRequest>;
const terminalSchema = z.custom<DockPanelRequest>(
	(value) =>
		pluginDocumentSchema.safeParse(value).success &&
		terminalFields.safeParse(value).success
);

export const decodeWorkspaceRequests = (raw: string) =>
	requestsSchema.parse(JSON.parse(raw));
export const decodeWorkspaceRecents = (raw: string) =>
	recentsSchema.parse(JSON.parse(raw));
export const decodeWorkspaceEnvironments = (raw: string) =>
	environmentsSchema.parse(JSON.parse(raw));
export const decodeWorkspaceTerminalRequest = (raw: string) =>
	terminalSchema.parse(JSON.parse(raw));
export const isExactWorkspaceTrigger = (name: string | RegExp) =>
	z.string().safeParse(name).success;
