import { COMPANION_THEME_MUTATION_ATTRIBUTES } from "@ryu/app-host/companion-theme";
import { type HostServices, isShellSafeRoute } from "@ryu/app-host/rpc";
import { asGlyphValue } from "@ryu/ui/components/glyph.ts";
import {
	type CommandEntry,
	contributionRegistry,
} from "@/src/contributions/registry.ts";
import { registerTabIcon } from "@/src/contributions/tab-icon-registry.ts";
import { subscribeFriendlyMode } from "@/src/hooks/useFriendlyMode.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	type EventChannel,
	subscribeChannel,
} from "@/src/lib/api/eventStream.ts";
import {
	parseCompanionCommands,
	parseCompanionEventChannels,
	parseCompanionTabIcons,
} from "./node-response-contracts.ts";
import type { PluginHostServicesContext } from "./PluginHostPanel-services-context.ts";
import { readHostThemeTokens } from "./PluginHostPanel-theme-tokens.ts";

/** The node event-stream channels a `shell.eventsSubscribe` call may request (grant
 *  `shell:integrate`). A companion's requested set is intersected with this — an
 *  unknown channel is silently dropped. Mirrors the `EventChannel` union. */
const SHELL_EVENT_CHANNELS: readonly EventChannel[] = [
	"activity",
	"notifications",
	"quests",
	"monitors",
	"approvals",
	"downloads",
];

export function buildPluginHostShellServices({
	companion,
	node,
	openTab,
}: PluginHostServicesContext): Partial<HostServices> {
	return {
		// --- Shell primitives (grant shell:integrate). The generic shell-integration
		// lane. The host owns every seam (tabs / theme / palette / event stream), so
		// none of these reach Core — they resolve entirely in the trusted webview
		// (like the per-app nav verbs above). `shellOpenTab` re-applies the route
		// ALLOWLIST on top of the grant (a granted companion can still only open a
		// safe first-party destination). The three subscribe/register verbs are
		// streaming: each attaches its listener and releases it when `signal` aborts
		// (frame unmount / dispose), so no subscription outlives the frame. ---
		shellOpenTab: ({
			path,
			title,
			conversationId,
			forceNew,
			initialPrompt,
			icon,
		}) => {
			const ownPath = `/plugin/${encodeURIComponent(companion.pluginId)}`;
			if (!isShellSafeRoute(path, ownPath)) {
				throw new Error(
					`shell.openTab: '${path}' is not an allowed shell destination`
				);
			}
			openTab(path, {
				title,
				conversationId,
				forceNew,
				initialPrompt,
				icon: asGlyphValue(icon),
			});
			return Promise.resolve();
		},
		shellThemeSubscribe: (_input, emit, signal) =>
			new Promise<void>((resolve) => {
				const push = () => {
					try {
						emit(JSON.stringify(readHostThemeTokens()));
					} catch {
						// A serialize/post failure is non-fatal — the next change re-emits.
					}
				};
				push(); // emit the current tokens immediately on subscribe
				const observer = new MutationObserver(push);
				observer.observe(document.documentElement, {
					attributes: true,
					attributeFilter: [...COMPANION_THEME_MUTATION_ATTRIBUTES],
				});
				const done = () => {
					observer.disconnect();
					resolve();
				};
				if (signal.aborted) {
					done();
				} else {
					signal.addEventListener("abort", done, { once: true });
				}
			}),
		// The host's display preferences. One field today — `friendly`, the
		// app-wide "Friendly names" toggle — emitted now and on every change, so a
		// companion's own copy can follow the shell's vocabulary instead of being
		// the one panel still saying "Graph" while the app around it says
		// "Connected search". `subscribeFriendlyMode` calls back immediately, which
		// is what gives the frame the current value on subscribe (the same contract
		// `shellThemeSubscribe` above keeps with its initial `push()`).
		shellPrefsSubscribe: (_input, emit, signal) =>
			new Promise<void>((resolve) => {
				const dispose = subscribeFriendlyMode((friendly) => {
					try {
						emit(JSON.stringify({ friendly }));
					} catch {
						// A serialize/post failure is non-fatal — the next change re-emits.
					}
				});
				const done = () => {
					dispose();
					resolve();
				};
				if (signal.aborted) {
					done();
				} else {
					signal.addEventListener("abort", done, { once: true });
				}
			}),
		shellRegisterCommand: (input, emit, signal) =>
			new Promise<void>((resolve) => {
				const raw = parseCompanionCommands(input);
				const disposers: (() => void)[] = [];
				for (const c of raw) {
					const commandId = c.id;
					const entry: CommandEntry = {
						// Namespace the palette id so a companion can neither collide with
						// nor impersonate a built-in / another plugin's command.
						id: `plugin:${companion.pluginId}:${commandId}`,
						title: c.title,
						group:
							c.group === undefined
								? companion.label || companion.name
								: c.group,
						keywords: c.keywords === undefined ? undefined : c.keywords,
						// Invocation is pushed back to the frame (which owns the handler);
						// emit the ORIGINAL id the frame registered.
						run: () => {
							try {
								emit(JSON.stringify(commandId));
							} catch {
								// non-fatal
							}
						},
					};
					disposers.push(contributionRegistry.registerCommand(entry));
				}
				const done = () => {
					for (const dispose of disposers) {
						dispose();
					}
					resolve();
				};
				if (signal.aborted) {
					done();
				} else {
					signal.addEventListener("abort", done, { once: true });
				}
			}),
		shellRegisterTabIcon: (input, _emit, signal) =>
			new Promise<void>((resolve) => {
				const raw = parseCompanionTabIcons(input);
				const disposers: (() => void)[] = [];
				for (const entry of raw) {
					disposers.push(
						registerTabIcon({
							id: `plugin:${companion.pluginId}:tab-icon:${entry.index}:${entry.pathPrefix}`,
							pathPrefix: entry.pathPrefix,
							pathIncludes:
								entry.pathIncludes === undefined
									? undefined
									: entry.pathIncludes,
							icon: entry.icon,
							priority: entry.priority === undefined ? 30 : entry.priority,
						})
					);
				}
				const done = () => {
					for (const dispose of disposers) {
						dispose();
					}
					resolve();
				};
				if (signal.aborted) {
					done();
				} else {
					signal.addEventListener("abort", done, { once: true });
				}
			}),
		shellEventsSubscribe: (input, emit, signal) =>
			new Promise<void>((resolve) => {
				const requested = parseCompanionEventChannels(input);
				const allowed = SHELL_EVENT_CHANNELS.filter((ch) =>
					requested.includes(ch)
				);
				const disposers = allowed.map((ch) =>
					subscribeChannel(toTarget(node), ch, (data) => {
						try {
							emit(JSON.stringify({ channel: ch, data }));
						} catch {
							// non-fatal
						}
					})
				);
				const done = () => {
					for (const dispose of disposers) {
						dispose();
					}
					resolve();
				};
				if (signal.aborted) {
					done();
				} else {
					signal.addEventListener("abort", done, { once: true });
				}
			}),
	};
}
