// packages/services/src/tools/core.ts
//
// The one seam between `@ryuhq/services/tools` and the rest of the package.
// Every runtime value a tool module needs from outside src/tools comes
// through here, and only names the root entry exports may be listed.
//
// The build marks this module external as `@ryuhq/services` (see
// `toolsCoreExternal` in tsup.config.ts), so dist/tools/index.{js,cjs}
// loads the root entry instead of bundling its own copy of errors.ts and
// result.ts. Without that, the CJS build (which tsup does not code-split)
// would hold a second `CALL_META` map that the root entry's `Ryu` never
// fills, so tool results would lose their meta, and a RyuError from a tool
// would fail `instanceof` against the root entry's classes.
// `exports-lockstep.test.ts` checks both the seam and the built output.

export {
	constructorOptionFor,
	ENV_VARS,
	serviceDocsUrl,
} from "../config.ts";
export {
	createRyuError,
	isRyuError,
	messageWithoutHint,
	RyuConfigurationError,
	RyuInvalidRequestError,
	toRyuError,
} from "../errors.ts";
export {
	pendingToolApprovals,
	TOOL_APPROVAL_EVENT_TYPES,
} from "../managed-agents/helpers.ts";
export { toResult } from "../result.ts";
