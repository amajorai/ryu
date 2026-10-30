// apps/desktop/src/lib/api/plugins.ts
//
// Typed client for Core's Plugin lifecycle endpoints (`/api/plugins`). A Plugin
// is a manifest.json bundle descriptor (manifest) with a persisted lifecycle
// record (installed/enabled state). Consumed by the Extensions page via the
// `useApps` hook.
//
// Wire shapes use snake_case as serialised by Rust/serde; camelCase types are
// the client-side view exposed to React components. The internal symbol names
// (App*, fetchApps, etc.) are kept stable to limit churn across importers.

export type {
	AppDependency,
	AppLifecycleAction,
	AppRecord,
	AppRequires,
	AppUninstallResult,
	DependencyError,
	Surface,
} from "@ryuhq/core-client/plugins.ts";
export {
	fetchAppLifecycleCapabilities,
	fetchApps,
	fetchPluginDoctor,
	fetchPluginEvals,
	previewAppLifecycle,
	runPluginEvals,
} from "./plugins-app-queries.ts";
export type { CatalogEntry } from "./plugins-catalog.ts";
export { fetchAppsCatalog } from "./plugins-catalog.ts";
export type {
	AddMarketplaceParams,
	PluginCatalogDetail,
	PluginCatalogPage,
	PluginCatalogSource,
	PluginCatalogSources,
	PluginSearchParams,
} from "./plugins-catalog-sources.ts";
export {
	addMarketplaceSource,
	fetchPluginCatalogDetail,
	fetchPluginChannels,
	fetchPluginSources,
	fetchPluginVersionDetail,
	installAppFromUrl,
	installPluginFromCatalog,
	installPluginFromCatalogAtVersion,
	PLUGIN_MARKETPLACE_SOURCE_ID,
	searchPluginCatalog,
	selectPluginSource,
} from "./plugins-catalog-sources.ts";
export type {
	AppInfo,
	AppLifecycleCapabilities,
	AppLifecyclePermission,
	AppLifecyclePreview,
	AppPresentation,
	AppTier,
	AppToggleResult,
	McpOAuthServerDeclaration,
	PluginDoctorFinding,
	PluginDoctorInventoryItem,
	PluginDoctorReport,
	PluginEvalAttempt,
	PluginEvalCaseResult,
	PluginEvalCaseSummary,
	PluginEvalGraderResult,
	PluginEvalIssue,
	PluginEvalOverview,
	PluginEvalRunInput,
	PluginEvalRunResult,
	PluginEvalSuite,
	RunnableEntry,
} from "./plugins-client-types.ts";
export { appTierFromWire, isCoreAppTier } from "./plugins-client-types.ts";
export { pluginThemeResponseSchema } from "./plugins-contribution-response-contracts.ts";
export type {
	PluginChannel,
	PluginCompanion,
	PluginCompanionCsp,
	PluginCompanionWire,
	PluginComposerControl,
	PluginComposerControlOption,
	PluginContextMenuItem,
	PluginCreateAction,
	PluginDockPanel,
	PluginDockPlacement,
	PluginFileHandler,
	PluginLiveActivity,
	PluginMessageAction,
	PluginSelectionAction,
	PluginView,
} from "./plugins-contribution-surface-types.ts";
export type {
	PluginAgentEditPanel,
	PluginAgentProfileTab,
	PluginChatFeature,
	PluginChatWidgetTemplate,
	PluginComputerUsePlanner,
	PluginContributions,
	PluginHookEvent,
	PluginOutputStyle,
	PluginSidebarButton,
	PluginSidebarMode,
	PluginSidebarSection,
	PluginStoreTab,
	PluginTheme,
	PluginWidgetApp,
} from "./plugins-contribution-types.ts";
export {
	fetchPluginUiBundle,
	getPluginContributions,
	parsePluginComputerUsePlanners,
} from "./plugins-contributions.ts";
export type { PluginHostErrorCode } from "./plugins-host-bridge.ts";
export {
	fireActivationEvent,
	ownAppEventStream,
	PluginHostError,
	pluginHostInvoke,
	pluginHostInvokeStream,
	unknownHostMethodMessage,
	withLegacyBridgeFallback,
} from "./plugins-host-bridge.ts";
export {
	disableApp,
	enableApp,
	installApp,
	installCompanionAppBundle,
	installStandaloneApp,
	installStandaloneAppBundle,
	setPluginGrants,
	uninstallApp,
	updateInstalledPlugin,
	updateInstalledPluginAtVersion,
} from "./plugins-install.ts";
export type { AppLifecycleError } from "./plugins-lifecycle-errors.ts";
export {
	dependencyErrorSchema,
	describeDependencyError,
} from "./plugins-lifecycle-errors.ts";
export { APP_LIFECYCLE_PERMISSIONS } from "./plugins-response-codecs.ts";
export type {
	EngineConcurrency,
	SidecarDetail,
	SidecarLifecyclePreview,
	SidecarSandboxStatus,
} from "./plugins-sidecars.ts";
export {
	fetchEngineConcurrency,
	fetchSidecarDetails,
	fetchSidecarStatus,
	installSidecar,
	previewSidecarInstall,
	previewSidecarUninstall,
	startSidecar,
	stopSidecar,
} from "./plugins-sidecars.ts";
export type {
	AppDependencyWire,
	AppManifestWire,
	AppRecordWire,
	ManifestTarget,
	RequiresWire,
	RunnableEntryWire,
} from "./plugins-wire-types.ts";
