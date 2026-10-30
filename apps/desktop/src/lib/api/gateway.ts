// apps/desktop/src/lib/api/gateway.ts
//
// Typed client for the Gateway observability surface, surfaced through Core's
// read-only proxy (`GET /api/gateway/status`). The proxy fetches the gateway's
// /health and /metrics and returns a combined snapshot, or a clear down state
// (`reachable: false`) when the gateway is unreachable while Core is still up.

export type {
	AssertionResult,
	BudgetChargeInclusion,
	EvalMessage,
	GatewayAuditFilters,
	GatewayCacheMetrics,
	GatewayCoreProviderView,
	GatewayFirewallPolicy,
	GatewayHealth,
	GatewayLocalProviderView,
	GatewayProviderMetrics,
	GatewayRequestMetrics,
	GatewayTokenMetrics,
	ModelRouterType,
	ProviderCircuitState,
	RedTeamStrategyResult,
	RouteStrategy,
	SmartRule,
	StagePicker,
} from "@ryuhq/core-client/gateway.ts";
export type {
	AuditEntry,
	BudgetSpend,
	BudgetSpendFilters,
	BudgetSpendLimits,
	BudgetSpendWireResponse,
	GatewayAuditResponse,
	GatewayAuditWireResponse,
	GatewayUsageRollupEvent,
	GatewayUsageRollupFilters,
	GatewayUsageRollupResponse,
} from "./gateway-audit.ts";
export {
	fetchBudgetSpend,
	fetchGatewayAudit,
	fetchGatewayUsageRollup,
	parseGatewayUsageRollupResponse,
	pruneGatewayAudit,
} from "./gateway-audit.ts";
export type {
	BudgetAction,
	BudgetRule,
	BudgetRuleInput,
	GatewayAcpConfig,
	GatewayAcpSettings,
	GatewayApiKey,
	GatewayAuthConfig,
	GatewayBudgetConfig,
	GatewayClientOperation,
	GatewayComputerUseConfig,
	GatewayConfig,
	GatewayConfigPatch,
	GatewayDoctorCategory,
	GatewayDoctorFinding,
	GatewayDoctorFix,
	GatewayDoctorFixResult,
	GatewayDoctorReport,
	GatewayDoctorSeverity,
	GatewayDriftWarning,
	GatewayEgressConfig,
	GatewayToolProfile,
	GatewayToolsConfig,
} from "./gateway-budget-config.ts";
export {
	buildBudgetRule,
	DEFAULT_BUDGET_INCLUSION,
	DEFAULT_GATEWAY_ACP,
	DEFAULT_GATEWAY_COMPUTER_USE,
	DEFAULT_SESSION_BUDGET,
	DEFAULT_SMART_ROUTING,
	withAgentBudget,
} from "./gateway-budget-config.ts";
export type {
	ClassifyTierState,
	InspectorConfig,
	LockableFirewallField,
} from "./gateway-classify-tier.ts";
export {
	CLASSIFY_MODEL_ID,
	CLASSIFY_MODEL_PREFIX,
	CLASSIFY_SIDECAR_NAME,
	CLASSIFY_TIER_COPY,
	classifyTierCannotServeModel,
	classifyTierServable,
	DEFAULT_INSPECTOR,
	deriveClassifyTierState,
	fetchClassifyWeightsPresent,
} from "./gateway-classify-tier.ts";
export type { GatewayConfigPatchInput } from "./gateway-config-api.ts";
export {
	fetchGatewayConfig,
	fetchGatewayDoctor,
	fixGatewayDoctor,
	updateGatewayConfig,
	withResolvedInspectorModels,
} from "./gateway-config-api.ts";
export type {
	Assertion,
	AssertionOptions,
	CodeEvaluatorSpec,
	EvalCaseScore,
	EvalDatasetCase,
	EvalRunAggregate,
	EvalRunResult,
	ModelEvalResult,
	RedTeamRunResult,
	RunEvalsRequest,
} from "./gateway-evals.ts";
export {
	runGatewayEvals,
	runGatewayRedTeam,
	scoreGatewayOutput,
} from "./gateway-evals.ts";
export type {
	Evaluator,
	EvaluatorAggregate,
	EvaluatorBinding,
	EvaluatorCapabilities,
	EvaluatorCategory,
	EvaluatorCodeLang,
	EvaluatorImpl,
	EvaluatorInlineConfig,
	EvaluatorOfflineConfig,
	EvaluatorScore,
	EvaluatorTarget,
	GatewayFirewallConfig,
	GatewayFirewallOverlay,
	GatewayFirewallView,
} from "./gateway-evaluators.ts";
export { fetchEvaluators } from "./gateway-evaluators.ts";
export type {
	EvalRoutingConfig,
	GatewayAccountStrategy,
	GatewayGenAiProviderView,
	GatewayProvidersConfig,
	GatewayProviderView,
	GatewaySdkContext,
	GatewaySdkProviderView,
	Modality,
	ModalityMapping,
	ModelMapping,
	ProviderKind,
} from "./gateway-provider-config.ts";
export {
	MODALITIES,
	MODEL_ROUTER_TYPE_DESCRIPTIONS,
	MODEL_ROUTER_TYPE_LABELS,
	ROUTE_STRATEGY_DESCRIPTIONS,
	ROUTE_STRATEGY_FRIENDLY_DESCRIPTIONS,
	ROUTE_STRATEGY_FRIENDLY_LABELS,
	ROUTE_STRATEGY_LABELS,
	routeStrategyCopy,
} from "./gateway-provider-config.ts";
export type {
	ByokProvider,
	GatewayProviderApplication,
	GatewayProviderEditResult,
} from "./gateway-provider-keys.ts";
export {
	addGatewayProviderAccount,
	applySavedGatewayProviderConnections,
	clearGatewayProvider,
	configureGatewayProviderAccount,
	generateGatewayKey,
	registerByoaKey,
	removeByoaKey,
	removeGatewayProviderAccount,
	replaceGatewayProviderAccount,
	requireGatewayProviderReload,
	setGatewayProvider,
	setGatewaySdkConnection,
} from "./gateway-provider-keys.ts";
export type {
	AutoScoringWeights,
	CustomPattern,
	CustomPatternKind,
	GatewayAlertTier,
	GatewayProviderPool,
	GatewayRoutingConfig,
	InspectorMode,
	PoolExecutionConfig,
	ProviderPoolStrategy,
	SmartRoutingConfig,
} from "./gateway-routing-config.ts";
export {
	ALERT_TIERS,
	DEFAULT_POOL_AUTO_WEIGHTS,
	DEFAULT_POOL_EXECUTION,
	LEGACY_PROVIDER_POOL_STRATEGIES,
	PROVIDER_POOL_STRATEGIES,
	providerPoolSettingsError,
	supportedProviderPoolStrategies,
} from "./gateway-routing-config.ts";
export type { RoutePool } from "./gateway-routing-helpers.ts";
export {
	formatPoolList,
	isOpenRoutePool,
	parsePoolList,
	routingViewIncludesModalityMap,
	routingViewIncludesSmartRouting,
	sameGuardrailSections,
	withModalityMapping,
	withRoutingDraftEdits,
} from "./gateway-routing-helpers.ts";
export {
	configUpdateNeedsRestart,
	deleteCustomEvaluator,
	fetchAgentRouteOverride,
	fetchAgentRoutePool,
	SmartRoutingUnavailableError,
	saveAgentRouteOverride,
	saveAgentRoutePool,
	saveCustomEvaluator,
	saveCustomEvaluators,
} from "./gateway-smart-routing.ts";
export type {
	GatewayMetrics,
	GatewayStatus,
	ProviderQuota,
	RawStatus,
} from "./gateway-status.ts";
export { fetchGatewayStatus } from "./gateway-status.ts";
export type { TrafficEvent, TrafficVerdict } from "./gateway-traffic.ts";
export { subscribeGatewayTraffic } from "./gateway-traffic.ts";

export interface GatewayProviderAccount {
	drainThresholdPercent?: number | null;
	enabled: boolean;
	id: string;
	name: string;
	priority: number;
	source?: "stored" | "environment" | "fleet";
}
