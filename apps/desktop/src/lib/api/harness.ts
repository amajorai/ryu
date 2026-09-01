// Desktop compatibility entrypoint for the shared durable harness client.

export type {
	ApprovalMode,
	ExecutionProfile,
	ExecutionProfileKind,
	HarnessApprovalOption,
	HarnessRun,
	HarnessRunEvent,
	HarnessRunEventEnvelope,
	HarnessRunStatus,
	HarnessSession,
	NetworkMode,
	SandboxMode,
} from "@ryuhq/core-client/harness";
export {
	bindNativeSession,
	cancelHarnessRun,
	createHarnessSession,
	getHarnessRun,
	getHarnessSession,
	listChildHarnessSessions,
	listHarnessRuns,
	resolveHarnessPermission,
	startHarnessRun,
	streamHarnessRunEvents,
} from "@ryuhq/core-client/harness";
