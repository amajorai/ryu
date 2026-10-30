"use client";

import {
	CodedRpcError,
	createI18nHostServices,
	type HostServices,
	type WidgetGlobalsPatch,
} from "@ryu/app-host/rpc";
import type { createScopedToastHost } from "@ryu/app-host/toast-host";
import type { WidgetInitialGlobals } from "@ryu/app-host/widget-bootstrap";
import type { useWidgetStateStore } from "@ryu/app-host/widget-state-store";
import type { useOptionalI18n } from "@ryu/i18n/react";
import {
	isNativeNumber,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import {
	type Dispatch,
	type MutableRefObject,
	type SetStateAction,
	useMemo,
} from "react";
import type { WidgetAvailableData } from "./app-widget-payload.ts";
import type {
	WidgetHostEnv,
	WidgetHostServices,
} from "./widget-host-context.tsx";

/** Per-instance HostServices for one widget mount (see app-widget.tsx). */
export function useWidgetHostServices({
	data,
	fileAccess,
	globalsRef,
	i18n,
	modalTemplateRef,
	openExternalShell,
	pushGlobals,
	services,
	setClosed,
	setDisplayMode,
	setHeight,
	stateStore,
	toastHost,
}: {
	data: WidgetAvailableData | null;
	fileAccess: WidgetHostServices["fileAccess"];
	globalsRef: MutableRefObject<WidgetInitialGlobals | null>;
	i18n: ReturnType<typeof useOptionalI18n>;
	modalTemplateRef: MutableRefObject<unknown>;
	openExternalShell: WidgetHostEnv["openExternal"] | undefined;
	pushGlobals: (patch: WidgetGlobalsPatch) => void;
	services: WidgetHostServices | undefined;
	setClosed: Dispatch<SetStateAction<boolean>>;
	setDisplayMode: Dispatch<SetStateAction<"inline" | "fullscreen" | "pip">>;
	setHeight: Dispatch<SetStateAction<number | null>>;
	stateStore: ReturnType<typeof useWidgetStateStore.getState>;
	toastHost: ReturnType<typeof createScopedToastHost>;
}): HostServices {
	const hostServices = useMemo<HostServices>(() => {
		// Capture the resolved payload once so the closures share one non-null `d`
		// (the frame can never supply these identifiers).
		const d = data;
		const requireInstance = () => {
			if (!d) {
				throw new CodedRpcError("not_found", "widget instance unavailable");
			}
			return d;
		};
		const i18nServices = createI18nHostServices(
			i18n ?? {
				getSnapshot: () => ({
					direction: "ltr" as const,
					locale: "en",
					packId: null,
					packName: null,
					packVersion: null,
				}),
				subscribe: () => () => undefined,
				t: (_id, _values, fallback) => fallback ?? _id,
			}
		);
		return {
			...i18nServices,
			readOpenedFile: fileAccess
				? async ({ uri }) => {
						if (uri !== fileAccess.uri) {
							throw new CodedRpcError(
								"denied",
								"Only the opened file is accessible"
							);
						}
						return await fileAccess.read();
					}
				: undefined,
			writeOpenedFile:
				fileAccess?.editable && (fileAccess.write || fileAccess.writeBlob)
					? async (input) => {
							if (input.uri !== fileAccess.uri) {
								throw new CodedRpcError(
									"denied",
									"Only the opened file is editable"
								);
							}
							if (isNativeText(input.text) && fileAccess.write) {
								return await fileAccess.write(
									input.text,
									input.expectedRevision
								);
							}
							if (isNativeText(input.blob) && fileAccess.writeBlob) {
								return await fileAccess.writeBlob(
									input.blob,
									input.expectedRevision
								);
							}
							throw new CodedRpcError(
								"denied",
								"This file representation is not editable"
							);
						}
					: undefined,
			getModelContext: () =>
				services?.getModelContext?.(requireInstance().instanceId) ?? null,
			updateModelContext: async (input) => {
				if (!services?.updateModelContext) {
					throw new CodedRpcError(
						"server_error",
						"Model context is unavailable"
					);
				}
				const state = await services.updateModelContext({
					owner: requireInstance().instanceId,
					input,
				});
				pushGlobals({ modelContext: state });
				return state;
			},
			uiToastDismiss: (input) => toastHost.dismiss(input),
			uiToastShow: (input) => toastHost.show(input),
			uiToastUpdate: (input) => toastHost.update(input),
			callTool: async (name, args) => {
				if (!services) {
					throw new CodedRpcError("server_error", "widget host unavailable");
				}
				const inst = requireInstance();
				const result = await services.callTool({
					args,
					instanceId: inst.instanceId,
					name,
					serverId: inst.serverId,
					toolCallId: inst.toolCallId,
				});
				// Reflect the confirmed output back into the frame's globals.
				pushGlobals({ toolOutput: result.output });
				return result.output;
			},
			getGlobals: () => Promise.resolve(globalsRef.current),
			// Plugin-only services the shared HostServices interface requires. A widget
			// is never granted `core.listAgents`/`ui.render`, so these are unreachable
			// through the gate; they reject to satisfy the type without leaking access.
			listAgents: () =>
				Promise.reject(
					new CodedRpcError(
						"denied",
						"core.listAgents is not a widget capability"
					)
				),
			registerRoute: () =>
				Promise.reject(
					new CodedRpcError(
						"denied",
						"ui.registerRoute is not a widget capability"
					)
				),
			notifyHeight: (px) => {
				const cap = d?.maxHeight;
				const capped = isNativeNumber(cap) ? Math.min(px, cap) : px;
				setHeight(capped > 0 ? capped : null);
			},
			requestDisplayMode: ({ mode }) => {
				const next =
					mode === "inline" || mode === "fullscreen" || mode === "pip"
						? mode
						: "inline";
				setDisplayMode(next);
				pushGlobals({ displayMode: next });
				return Promise.resolve({ mode: next });
			},
			// Governed `window.openai.requestModal`: Ryu has no modal-template surface,
			// so a modal maps to fullscreen — but the requested `template` is honored
			// (recorded here + reflected into the widget's `view` global) rather than
			// silently dropped.
			requestModal: ({ template }) => {
				modalTemplateRef.current = template;
				setDisplayMode("fullscreen");
				pushGlobals({
					displayMode: "fullscreen",
					view: { modalTemplate: template },
				});
				return Promise.resolve({ mode: "fullscreen" });
			},
			// Governed `window.openai.requestClose`: dismiss this widget instance.
			requestClose: () => {
				services?.clearModelContext?.(requireInstance().instanceId);
				setClosed(true);
				return Promise.resolve();
			},
			// Governed `window.openai.openExternal`: the arg is already vetted to an
			// http(s) URL by the rpc gate; open it in the user's real browser via the
			// desktop shell — NEVER inside the sandboxed frame.
			openExternal: async ({ href }) => {
				if (!openExternalShell) {
					throw new CodedRpcError("server_error", "widget host unavailable");
				}
				await openExternalShell(href);
			},
			sendFollowUpMessage: async ({ prompt }) => {
				if (!services) {
					throw new CodedRpcError("server_error", "widget host unavailable");
				}
				const inst = requireInstance();
				await services.sendFollowUpMessage({
					instanceId: inst.instanceId,
					prompt,
					toolCallId: inst.toolCallId,
				});
			},
			setWidgetState: (state) => {
				const inst = requireInstance();
				stateStore.set(inst.toolCallId, state);
				pushGlobals({ widgetState: state });
				// Best-effort server persistence (D4); never blocks the widget.
				services
					?.setWidgetState?.({
						instanceId: inst.instanceId,
						state,
						toolCallId: inst.toolCallId,
					})
					.catch(() => {
						// swallow — client store remains authoritative for the session
					});
				return Promise.resolve();
			},
		};
	}, [
		services,
		openExternalShell,
		data,
		i18n,
		stateStore,
		pushGlobals,
		toastHost,
		fileAccess,
	]);
	return hostServices;
}
