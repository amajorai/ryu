// Standalone Vite config for the plugin-runtime cert harness (`index.html` +
// `main.ts`), isolated from the main desktop app so the cert page builds and serves
// on its own. Playwright's `webServer` runs `vite` with this config; `vite build`
// with it proves the harness compiles here even though headless Chromium cannot
// launch in this environment.
//
// `root` is the harness dir so `index.html` is the entry; the `@` alias mirrors the
// app so `../../src/...` and any `@/...` imports resolve to `apps/desktop`.

import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	plugins: [react()],
	// Keep the built proof pages self-contained so the desktop/browser harness
	// can be opened from a file:// URL when a local server is unavailable.
	base: "./",
	// Mirror the app's PostCSS pipeline so the stories render with the REAL
	// utilities. Without it every Tailwind class is a no-op here, which makes a
	// story useless for judging layout (and silently changes any behavior that
	// depends on a class actually clipping or scrolling).
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	// Some shared settings components import Next's client adapter. The browser
	// harness is Vite-only, so provide the compile-time env object Next expects.
	define: {
		"process.env": {},
	},
	root: harnessDir,
	// Reuse the desktop's bundled logos and other offline assets so visual proof
	// pages exercise the same product marks as the real webview instead of showing
	// broken-image placeholders from the harness root.
	publicDir: path.resolve(desktopRoot, "public"),
	clearScreen: false,
	resolve: {
		alias: {
			"@": desktopRoot,
		},
	},
	server: {
		host: "127.0.0.1",
		port: Number(process.env.RYU_E2E_PORT ?? "5177"),
		strictPort: true,
	},
	build: {
		outDir: path.resolve(harnessDir, "dist"),
		target: "chrome105",
		emptyOutDir: true,
		rollupOptions: {
			input: {
				index: path.resolve(harnessDir, "index.html"),
				tauriUpdatePredownloadProof: path.resolve(
					harnessDir,
					"tauri-update-predownload-proof.html"
				),
				shareConversation: path.resolve(
					harnessDir,
					"share-conversation-story.html"
				),
				a2aSettingsProof: path.resolve(harnessDir, "a2a-settings-proof.html"),
				graphragSpacesLive: path.resolve(
					harnessDir,
					"graphrag-spaces-live.html"
				),
				interfaceLevelStory: path.resolve(
					harnessDir,
					"interface-level-story.html"
				),
				usagePacer: path.resolve(harnessDir, "usage-pacer-proof.html"),
				electronAutoUpdateProof: path.resolve(
					harnessDir,
					"electron-auto-update-proof.html"
				),
				actionSummary: path.resolve(harnessDir, "action-summary-proof.html"),
				connectionHub: path.resolve(harnessDir, "connection-hub-proof.html"),
				agentApproval: path.resolve(harnessDir, "agent-approval-story.html"),
				composerInteraction: path.resolve(
					harnessDir,
					"composer-interaction-proof.html"
				),
				composerMarkdownProof: path.resolve(
					harnessDir,
					"composer-markdown-proof.html"
				),
				agentSetupComposerProof: path.resolve(
					harnessDir,
					"agent-setup-composer-proof.html"
				),
				answerNowProof: path.resolve(harnessDir, "answer-now-proof.html"),
				agentMessage: path.resolve(harnessDir, "agent-message-story.html"),
				agentConversationBranchProof: path.resolve(
					harnessDir,
					"agent-conversation-branch-proof.html"
				),
				sidebarTodoProgressProof: path.resolve(
					harnessDir,
					"sidebar-todo-progress-proof.html"
				),
				pinnedAgentStageProof: path.resolve(
					harnessDir,
					"pinned-agent-stage-proof.html"
				),
				goalMessageProof: path.resolve(harnessDir, "goal-message-proof.html"),
				agentTemplateSchedules: path.resolve(
					harnessDir,
					"agent-template-schedules-proof.html"
				),
				composerSummary: path.resolve(
					harnessDir,
					"composer-summary-story.html"
				),
				composerDraftPersistence: path.resolve(
					harnessDir,
					"composer-draft-persistence-proof.html"
				),
				pinnedSummaryScrollProof: path.resolve(
					harnessDir,
					"pinned-summary-scroll-proof.html"
				),
				storeChromeStory: path.resolve(harnessDir, "store-chrome-story.html"),
				marketplaceStabilityVersionHistory: path.resolve(
					harnessDir,
					"marketplace-stability-version-history-proof.html"
				),
				pinnedBackgroundProcesses: path.resolve(
					harnessDir,
					"pinned-background-processes-story.html"
				),
				planPinnedSummary: path.resolve(
					harnessDir,
					"plan-pinned-summary-proof.html"
				),
				newTabMenuProof: path.resolve(harnessDir, "new-tab-menu-proof.html"),
				chatRecovery: path.resolve(harnessDir, "chat-recovery-story.html"),
				reconnectRetryProof: path.resolve(
					harnessDir,
					"reconnect-retry-proof.html"
				),
				onboardingAgents: path.resolve(
					harnessDir,
					"onboarding-agents-story.html"
				),
				onboardingChoose: path.resolve(
					harnessDir,
					"onboarding-choose-story.html"
				),
				onboardingDefaultsProfile: path.resolve(
					harnessDir,
					"onboarding-defaults-profile-proof.html"
				),
				proactiveChannelOpening: path.resolve(
					harnessDir,
					"proactive-channel-opening-proof.html"
				),
				channelAgentLifecycleProof: path.resolve(
					harnessDir,
					"channel-agent-lifecycle-proof.html"
				),
				learningFeedbackProof: path.resolve(
					harnessDir,
					"learning-feedback-proof.html"
				),
				managedChannelProvisioningProof: path.resolve(
					harnessDir,
					"managed-channel-provisioning-proof.html"
				),
				welcomeStep: path.resolve(harnessDir, "welcome-step-story.html"),
				onboardingUpdate: path.resolve(
					harnessDir,
					"onboarding-update-story.html"
				),
				memoryChatSearch: path.resolve(
					harnessDir,
					"memory-chat-search-story.html"
				),
				spaceActions: path.resolve(harnessDir, "space-actions-story.html"),
				privateTeamVisibility: path.resolve(
					harnessDir,
					"private-team-visibility-story.html"
				),
				scrollFade: path.resolve(harnessDir, "scroll-fade-story.html"),
				horizontalWheelScrollProof: path.resolve(
					harnessDir,
					"horizontal-wheel-scroll-proof.html"
				),
				keyboardShortcutsSearchProof: path.resolve(
					harnessDir,
					"keyboard-shortcuts-search-proof.html"
				),
				tabOverflowProof: path.resolve(
					harnessDir,
					"tab-overflow-proof-story.html"
				),
				tabSearchProof: path.resolve(harnessDir, "tab-search-proof.html"),
				tabDropdownProof: path.resolve(harnessDir, "tab-dropdown-proof.html"),
				floatingTabsProof: path.resolve(harnessDir, "floating-tabs-proof.html"),
				reorderIndicatorProof: path.resolve(
					harnessDir,
					"reorder-indicator-proof.html"
				),
				wshobsonPackProof: path.resolve(harnessDir, "wshobson-pack-proof.html"),
				diagramDesignPackProof: path.resolve(
					harnessDir,
					"diagram-design-pack-proof.html"
				),
				unlazyPackProof: path.resolve(harnessDir, "unlazy-pack-proof.html"),
				dropdownPickerProof: path.resolve(
					harnessDir,
					"dropdown-picker-proof.html"
				),
				archiveStopProof: path.resolve(harnessDir, "archive-stop-proof.html"),
				gatewayPostureDoctor: path.resolve(
					harnessDir,
					"gateway-posture-doctor-proof.html"
				),
				acpRuntimeSettings: path.resolve(
					harnessDir,
					"acp-runtime-settings-proof.html"
				),
				computerUseSettings: path.resolve(
					harnessDir,
					"computer-use-settings-proof.html"
				),
				systemNotifications: path.resolve(
					harnessDir,
					"system-notifications-story.html"
				),
				orgBillingContext: path.resolve(
					harnessDir,
					"org-billing-context-proof.html"
				),
				buttonLabelOverflow: path.resolve(
					harnessDir,
					"button-label-overflow-proof.html"
				),
				emptyStateFolderPicker: path.resolve(
					harnessDir,
					"empty-state-folder-picker-proof.html"
				),
				creditUsageCharts: path.resolve(
					harnessDir,
					"credit-usage-charts-proof.html"
				),
				creditSidebarWarning: path.resolve(
					harnessDir,
					"credit-sidebar-warning-proof.html"
				),
				chatVoiceUiProof: path.resolve(harnessDir, "chat-voice-ui-proof.html"),
				replyMessageProof: path.resolve(harnessDir, "reply-message-proof.html"),
				replyThreadProof: path.resolve(harnessDir, "reply-thread-proof.html"),
				chatPreviewRail: path.resolve(
					harnessDir,
					"chat-preview-rail-story.html"
				),
				chatComposerTransition: path.resolve(
					harnessDir,
					"chat-composer-transition-proof.html"
				),
				appearanceContextMenuProof: path.resolve(
					harnessDir,
					"appearance-context-menu-proof.html"
				),
				markdownTable: path.resolve(harnessDir, "markdown-table-story.html"),
				chatRichContentProof: path.resolve(
					harnessDir,
					"chat-rich-content-proof.html"
				),
				chatTypingIndicatorProof: path.resolve(
					harnessDir,
					"chat-typing-indicator-proof.html"
				),
				botChatSectionsProof: path.resolve(
					harnessDir,
					"bot-chat-sections-proof.html"
				),
				botProductShellProof: path.resolve(
					harnessDir,
					"bot-product-shell-proof.html"
				),
				osDesktopSurfaceProof: path.resolve(
					harnessDir,
					"os-desktop-surface-proof.html"
				),
				chatUnreadMessagesProof: path.resolve(
					harnessDir,
					"chat-unread-messages-proof.html"
				),
				workspaceSessionProof: path.resolve(
					harnessDir,
					"workspace-session-proof.html"
				),
				subagentsWorkspaceProof: path.resolve(
					harnessDir,
					"subagents-workspace-proof.html"
				),
				notificationLayoutProof: path.resolve(
					harnessDir,
					"notification-layout-proof.html"
				),
				announcementVisualsProof: path.resolve(
					harnessDir,
					"announcement-visuals-proof.html"
				),
				mediaPipLightboxProof: path.resolve(
					harnessDir,
					"media-pip-lightbox-proof.html"
				),
				agentSyncProof: path.resolve(harnessDir, "agent-sync-proof.html"),
				agentBudgetEditProof: path.resolve(
					harnessDir,
					"agent-budget-edit-proof.html"
				),
				nodeLifecycleCapabilityProof: path.resolve(
					harnessDir,
					"node-lifecycle-capability-proof.html"
				),
				browserAnnotationProof: path.resolve(
					harnessDir,
					"browser-annotation-proof.html"
				),
				modelPricingProof: path.resolve(harnessDir, "model-pricing-proof.html"),
				startupSelection: path.resolve(
					harnessDir,
					"desktop-startup-selection-story.html"
				),
				morphiconsAdoptionProof: path.resolve(
					harnessDir,
					"morphicons-adoption-proof.html"
				),
				versionHistoryStory: path.resolve(
					harnessDir,
					"version-history-story.html"
				),
				gitEnvironmentProof: path.resolve(
					harnessDir,
					"git-environment-proof.html"
				),
				gatewayGovernanceProof: path.resolve(
					harnessDir,
					"gateway-governance-proof.html"
				),
				skillRelationsStory: path.resolve(
					harnessDir,
					"skill-relations-story.html"
				),
			},
		},
	},
});
