// packages/services-cli/src/index.ts
//
// `@ryuhq/services-cli`: the library surface. This module has no side
// effects, so a host that bundles it (`apps/cli`, `apps/mcp`) never runs the
// `ryu-services` command line on its own argv; the bin lives in `bin.ts`.

export { NPM_PUBLISHED_VERSION } from "@ryuhq/services";
export type {
	FlagSpec,
	FlagSpecs,
	FlagType,
	FlagValue,
	ParsedFlags,
} from "./args.ts";
export {
	booleanFlag,
	CliUsageError,
	countFlag,
	GLOBAL_FLAGS,
	numberFlag,
	requireStringFlag,
	stringFlag,
	stringsFlag,
} from "./args.ts";
export {
	buildRyuOptions,
	type CliIo,
	DEFAULT_PROGRAM,
	DOCTOR_COMMAND_FLAGS,
	exitCodeFor,
	MCP_FLAGS,
	mcpClientExample,
	runCli,
	WEBHOOKS_COMMAND_FLAGS,
} from "./cli.ts";
export { connectPointer } from "./commands/connect.ts";
export { createCaptureFetch, toCurl } from "./curl.ts";
export {
	MCP_TOOL_MODULES,
	type RegisterServiceToolsOptions,
	type RegisterServiceToolsResult,
	registerServiceTools,
	type ServiceToolAnnotations,
	type ServiceToolDefinition,
	type ServiceToolModule,
	type ServiceToolRegistrar,
} from "./mcp/registry.ts";
export {
	collectEvents,
	runTool,
	toolFailure,
	toolSuccess,
} from "./mcp/result.ts";
export {
	createServicesMcpServer,
	MCP_SERVER_NAME,
	serveServicesMcp,
} from "./mcp/server.ts";
export { EXIT_CODES, type ExitCode } from "./output.ts";
export {
	bindCallOptions,
	CLI_SERVICES,
	type CliService,
	type CliServiceName,
	type CommandContext,
	type CommandIo,
	commandLine,
	matchCommand,
	SERVICE_COMMANDS,
	type ServiceCommand,
} from "./registry.ts";
export {
	type SettledCall,
	settled,
	settledWith,
	unwrapSettled,
} from "./settled.ts";
export {
	CLI_VERSION,
	NPM_STATUS_CLAUSE,
	type NpmStatusOrigin,
	npmStatusNote,
} from "./version.ts";
