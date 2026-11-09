// The reviewed-author guard is shared with the mobile host so both clients
// refuse the same owner-token workflow verbs; see the module for the rationale.
export {
	gateWorkflowAuthoring,
	isReviewedWorkflowAuthor,
	WORKFLOW_AUTHORING_VERBS,
} from "@ryu/app-host/workflow-authoring-guard";
