import { Globe02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	COMPANION_THEME_MUTATION_ATTRIBUTES,
	readCompanionThemeTokens,
} from "@ryu/app-host/companion-theme";
import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	BrowserAnnotationSurface,
	type BrowserContextResult,
	type BrowserRect,
} from "@/src/components/panels/BrowserAnnotationSurface.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAssistantPageContext } from "@/src/hooks/useAssistantPageContext.ts";
import { apiUrl, makeHeaders } from "@/src/lib/api/client.ts";
import { CONTRIBUTED_LINK_OPENED_EVENT } from "@/src/lib/contributed-link-handler.ts";
import { clearMediaSource, publishMediaSource } from "@/src/lib/media-pip.ts";
import { useAssistantStore } from "@/src/store/useAssistantStore.ts";
import {
	BROWSER_PLUGIN_ID,
	formatBrowserContext,
	type SidecarTab,
} from "./browser-shared.ts";
import { URL_PROTOCOL_RE } from "./iframe-panel.tsx";
import { useBrowserAnnotationActions } from "./use-browser-annotation-actions.ts";

export function BrowserSidecarPanel({
	active = true,
	requestedNonce,
	requestedUrl,
}: {
	active?: boolean;
	requestedNonce?: number;
	requestedUrl?: string;
}) {
	const tl = useLiteralMessages();
	const node = useActiveNode();
	const [tabs, setTabs] = useState<SidecarTab[]>([]);
	const [activeId, setActiveId] = useState<string | null>(null);
	const [inputVal, setInputVal] = useState("");
	const [shot, setShot] = useState<string | null>(null);
	const [context, setContext] = useState<BrowserContextResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [isAnnotating, setIsAnnotating] = useState(false);
	const [askRyuPending, setAskRyuPending] = useState(false);
	const askRyuPendingRef = useRef(false);
	const [isFrozen, setIsFrozen] = useState(false);
	const [themeTokens, setThemeTokens] = useState(() =>
		readCompanionThemeTokens(undefined, { includeStoredPreferences: true })
	);
	useEffect(() => {
		if (!globalThis.MutationObserver) {
			return;
		}
		const observer = new MutationObserver(() => {
			setThemeTokens(
				readCompanionThemeTokens(undefined, {
					includeStoredPreferences: true,
				})
			);
		});
		observer.observe(document.documentElement, {
			attributeFilter: [...COMPANION_THEME_MUTATION_ATTRIBUTES],
			attributes: true,
		});
		return () => observer.disconnect();
	}, []);

	const base = "/api/ext/@ryu/browser";
	const headers = useMemo(
		() => makeHeaders(node.token ?? null, node.userJwt),
		[node.token, node.userJwt]
	);
	const openAssistant = useAssistantStore((store) => store.open);
	const setPendingPrompt = useAssistantStore((store) => store.setPendingPrompt);

	const call = useCallback(
		async (path: string, init?: RequestInit) => {
			const resp = await fetch(
				apiUrl(
					{ url: node.url, token: node.token, userJwt: node.userJwt ?? null },
					path
				),
				{
					headers,
					...init,
				}
			);
			if (!resp.ok) {
				throw new Error(`${resp.status}`);
			}
			return resp;
		},
		[node.url, node.token, headers]
	);

	useEffect(() => {
		call(`${base}/theme`, {
			body: JSON.stringify({ tokens: themeTokens }),
			headers: { ...headers, "Content-Type": "application/json" },
			method: "PUT",
		}).catch(() => undefined);
	}, [call, headers, themeTokens]);

	const publishBrowserImage = useCallback(
		(id: string, image: string, title?: string) => {
			const imageUrl = `data:image/png;base64,${image}`;
			setShot(imageUrl);
			const tab = tabs.find((candidate) => candidate.id === id);
			publishMediaSource({
				id: `browser:${id}`,
				imageUrl,
				kind: "browser",
				tabId: id,
				title: title || tab?.title || tab?.url || "Browser tab",
			});
		},
		[tabs]
	);

	const getContext = useCallback(
		async (
			id: string,
			selections: BrowserRect[] = [],
			includeScreenshot = true
		): Promise<BrowserContextResult> => {
			const resp = await call(
				`${base}/tabs/${encodeURIComponent(id)}/context`,
				{
					method: "POST",
					headers: { ...headers, "Content-Type": "application/json" },
					body: JSON.stringify({
						include_screenshot: includeScreenshot,
						selections,
					}),
				}
			);
			const nextContext =
				/* SAFETY: The successful browser sidecar context route returns the TabManager.context contract; call rejects non-success replies first. */ (await resp.json()) as BrowserContextResult;
			setContext(nextContext);
			if (includeScreenshot && nextContext.screenshot?.image) {
				publishBrowserImage(
					id,
					nextContext.screenshot.image,
					nextContext.page.title
				);
			}
			return nextContext;
		},
		[call, headers, publishBrowserImage]
	);

	const refresh = useCallback(async () => {
		setError(null);
		try {
			const resp = await call(`${base}/tabs`);
			const data =
				/* SAFETY: The browser GET /tabs publisher wraps tabView results in tabs; call rejects non-success replies before this projection. */ (await resp.json()) as {
					tabs: SidecarTab[];
				};
			setTabs(data.tabs);
			setActiveId((prev) =>
				prev && data.tabs.some((tab) => tab.id === prev)
					? prev
					: (data.tabs[0]?.id ?? null)
			);
		} catch (e) {
			setError(
				e instanceof Error
					? tl("Browser sidecar unreachable ({message})", {
							message: e.message,
						})
					: "error"
			);
		}
	}, [call, tl]);

	useEffect(() => {
		refresh().catch(() => undefined);
	}, [refresh]);

	useEffect(() => {
		const onLinkOpened = (event: Event) => {
			// SAFETY: openContributedLink publishes this named event with the full native
			// panel.plugin string plus URL; DOM EventListener erases its detail type.
			const plugin = (event as CustomEvent<{ plugin?: string }>).detail?.plugin;
			if (plugin === BROWSER_PLUGIN_ID) {
				refresh().catch(() => undefined);
			}
		};
		window.addEventListener(CONTRIBUTED_LINK_OPENED_EVENT, onLinkOpened);
		return () =>
			window.removeEventListener(CONTRIBUTED_LINK_OPENED_EVENT, onLinkOpened);
	}, [refresh]);

	const openTab = useCallback(
		async (raw: string) => {
			let url = raw.trim();
			if (!url) {
				return;
			}
			if (!URL_PROTOCOL_RE.test(url)) {
				url = `https://${url}`;
			}
			try {
				const resp = await call(`${base}/tabs`, {
					method: "POST",
					headers: { ...headers, "Content-Type": "application/json" },
					body: JSON.stringify({ url }),
				});
				const data =
					/* SAFETY: The successful browser POST /tabs publisher returns tabView(tab) in tab; error responses are rejected by call. */ (await resp.json()) as {
						tab: SidecarTab;
					};
				setActiveId(data.tab.id);
				setInputVal("");
				await refresh();
			} catch (e) {
				setError(e instanceof Error ? e.message : "open failed");
			}
		},
		[call, headers, refresh]
	);

	// Each request is opened exactly once, keyed by its nonce. `openTab` changes
	// identity whenever the node's credentials refresh, which must not replay a
	// request that was already handled.
	const handledNonceRef = useRef<number | undefined>(undefined);
	useEffect(() => {
		if (!requestedUrl || requestedNonce === handledNonceRef.current) {
			return;
		}
		handledNonceRef.current = requestedNonce;
		openTab(requestedUrl).catch(() => undefined);
	}, [openTab, requestedNonce, requestedUrl]);

	const screenshot = useCallback(
		async (id: string) => {
			try {
				const resp = await call(
					`${base}/tabs/${encodeURIComponent(id)}/screenshot`,
					{
						method: "POST",
					}
				);
				const data =
					/* SAFETY: The browser screenshot route returns its PNG payload under image only on success; call rejects error replies. */ (await resp.json()) as {
						image: string;
					};
				publishBrowserImage(id, data.image);
			} catch (e) {
				setError(e instanceof Error ? e.message : "screenshot failed");
			}
		},
		[call, publishBrowserImage]
	);

	useEffect(() => {
		if (!activeId) {
			setShot(null);
			return;
		}
		if (!active || isFrozen) {
			clearMediaSource(`browser:${activeId}`);
			return;
		}
		// A screenshot can take longer than the interval on a busy page; skip ticks
		// while one is in flight instead of stacking base64 requests behind it.
		let inFlight = false;
		const tick = () => {
			if (inFlight) {
				return;
			}
			inFlight = true;
			screenshot(activeId)
				.catch(() => undefined)
				.finally(() => {
					inFlight = false;
				});
		};
		tick();
		const timer = window.setInterval(tick, 800);
		return () => window.clearInterval(timer);
	}, [active, activeId, isFrozen, screenshot]);

	useEffect(() => {
		return () => {
			if (activeId) {
				clearMediaSource(`browser:${activeId}`);
			}
		};
	}, [activeId]);

	useEffect(() => {
		setContext(null);
		setIsAnnotating(false);
		setIsFrozen(false);
	}, [activeId]);

	const {
		toggleAnnotating,
		annotate,
		deleteAnnotation,
		clearAnnotations,
		askRyu,
	} = useBrowserAnnotationActions({
		activeId,
		askRyuPendingRef,
		call,
		getContext,
		headers,
		isAnnotating,
		openAssistant,
		setAskRyuPending,
		setContext,
		setError,
		setIsAnnotating,
		setIsFrozen,
		setPendingPrompt,
	});

	const activeTab = tabs.find((tab) => tab.id === activeId);
	useAssistantPageContext(
		activeId
			? {
					id: `browser:${activeId}:context`,
					title: `Browser · ${activeTab?.title || activeTab?.url || "tab"}`,
					text: "",
					getText: async () => {
						try {
							return formatBrowserContext(
								await getContext(activeId, [], false)
							);
						} catch {
							return formatBrowserContext(context);
						}
					},
				}
			: null
	);

	const closeTab = useCallback(
		async (id: string) => {
			try {
				await call(`${base}/tabs/${encodeURIComponent(id)}`, {
					method: "DELETE",
				});
				setShot(null);
				clearMediaSource(`browser:${id}`);
				setActiveId((prev) => (prev === id ? null : prev));
				await refresh();
			} catch (e) {
				setError(e instanceof Error ? e.message : "close failed");
			}
		},
		[call, refresh]
	);

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-10 shrink-0 flex-col justify-center border-border border-b px-2">
				<form
					className="flex items-center gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						openTab(inputVal).catch(() => undefined);
					}}
				>
					<HugeiconsIcon
						className="size-3.5 shrink-0 text-muted-foreground"
						icon={Globe02Icon}
					/>
					<input
						aria-label="URL to open"
						className="min-w-0 flex-1 rounded-lg bg-background px-2 py-0.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
						onChange={(e) => setInputVal(e.target.value)}
						placeholder="Open a URL in the browser sidecar…"
						spellCheck={false}
						value={inputVal}
					/>
					<button
						className="rounded-lg px-2 py-0.5 text-muted-foreground text-xs hover:bg-accent"
						onClick={() => refresh().catch(() => undefined)}
						type="button"
					>
						Refresh
					</button>
				</form>
			</div>
			<div className="flex min-h-0 flex-1">
				<ul className="w-48 shrink-0 overflow-y-auto border-border border-r text-xs">
					{tabs.length === 0 && (
						<li className="p-2 text-muted-foreground">No open tabs.</li>
					)}
					{tabs.map((t) => (
						<li
							className={cn(
								"flex items-center gap-1 border-border border-b px-2 py-1.5",
								t.id === activeId && "bg-accent"
							)}
							key={t.id}
						>
							<button
								className="min-w-0 flex-1 truncate text-left"
								onClick={() => {
									setActiveId(t.id);
									screenshot(t.id).catch(() => undefined);
								}}
								title={t.url}
								type="button"
							>
								{t.title || t.url || t.id}
							</button>
							<button
								className="shrink-0 text-muted-foreground hover:text-foreground"
								onClick={() => closeTab(t.id).catch(() => undefined)}
								type="button"
							>
								×
							</button>
						</li>
					))}
				</ul>
				<div className="relative flex min-w-0 flex-1">
					{error && (
						<div className="pointer-events-none absolute top-2 right-2 left-2 z-10 rounded-lg border border-border bg-popover px-2 py-1 text-center text-status-destructive text-xs shadow-lg">
							{error}
						</div>
					)}
					<BrowserAnnotationSurface
						askRyuPending={askRyuPending}
						context={context}
						imageUrl={shot}
						isAnnotating={isAnnotating}
						onAnnotate={annotate}
						onAskRyu={() => askRyu().catch(() => undefined)}
						onClearAnnotations={clearAnnotations}
						onContext={(selections) =>
							activeId
								? getContext(activeId, selections, true).catch((e: unknown) => {
										setError(
											e instanceof Error ? e.message : "browser context failed"
										);
										return null;
									})
								: Promise.resolve(null)
						}
						onDeleteAnnotation={deleteAnnotation}
						onToggleAnnotating={() => toggleAnnotating().catch(() => undefined)}
					/>
				</div>
			</div>
		</div>
	);
}
