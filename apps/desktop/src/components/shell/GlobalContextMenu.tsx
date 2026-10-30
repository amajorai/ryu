import {
	ArrowShrink02Icon,
	Bug01Icon,
	ClipboardPasteIcon,
	ConsoleIcon,
	Copy01Icon,
	FullScreenIcon,
	LaptopIcon,
	MinusSignIcon,
	MoonIcon,
	PlusSignIcon,
	Refresh01Icon,
	ScissorIcon,
	Settings01Icon,
	SunIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { ClassicThemeIcon } from "@ryu/ui/components/classic-theme-icon.tsx";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuGroup,
	ContextMenuItem,
	ContextMenuPortal,
	ContextMenuSeparator,
	ContextMenuShortcut,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useTheme } from "next-themes";
import {
	type ReactNode,
	useEffect,
	useEffectEvent,
	useRef,
	useState,
} from "react";
import { isDeveloperMode } from "@/src/hooks/useDeveloperMode.ts";
import {
	DEFAULT_SCALE,
	SCALE_STEP,
	setScale,
} from "@/src/hooks/useThemePreset.ts";
import {
	getConsoleBufferText,
	isConsoleCaptureActive,
} from "@/src/lib/console-buffer.ts";
import { toggleFullscreen, useFullscreen } from "@/src/lib/fullscreen.ts";
import { openFeedbackWidget } from "@/src/lib/userjot.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";
import {
	buildBugReportContext,
	canEditSelection,
	captureViewportPng,
	clampScale,
	copyScreenshotToClipboard,
	isEditableTarget,
	isMac,
	mod,
	readScale,
	toggleDevtools,
} from "./GlobalContextMenu-actions.ts";

interface GlobalContextMenuProps {
	children: ReactNode;
}

/**
 * App-wide right-click menu. Replaces the WebView/Tauri native menu (Inspect,
 * Reload, etc.) with Electron-style Edit / View / App actions. Nested
 * ContextMenus (sidebar chats, tabs, …) still win — Base UI stops propagation
 * on their triggers.
 */
export function GlobalContextMenu({ children }: GlobalContextMenuProps) {
	const { theme, resolvedTheme, setTheme } = useTheme();
	const openSettings = useSettingsDialog((s) => s.openSettings);
	const isFullscreen = useFullscreen();
	const [hasSelection, setHasSelection] = useState(false);
	const [editableFocused, setEditableFocused] = useState(false);
	const contextMenuOpenRef = useRef(false);
	const editableTargetRef = useRef<HTMLElement | null>(null);
	const [showDevTools, setShowDevTools] = useState(
		() => Boolean(import.meta.env.DEV) || isDeveloperMode()
	);

	// Kill the WebView2 / WKWebView native context menu everywhere. Nested
	// Base UI menus still open — they receive the event after capture and call
	// stopPropagation so this shell menu does not also open.
	useEffect(() => {
		const killNative = (event: MouseEvent) => {
			const target = event.target;
			if (
				target instanceof Element &&
				(target.closest("iframe") || target.tagName === "WEBVIEW")
			) {
				return;
			}
			event.preventDefault();
		};
		document.addEventListener("contextmenu", killNative, true);
		return () => {
			document.removeEventListener("contextmenu", killNative, true);
		};
	}, []);

	const refreshEditState = useEffectEvent(() => {
		const active = document.activeElement;
		if (isEditableTarget(active)) {
			editableTargetRef.current = active;
		} else if (!contextMenuOpenRef.current) {
			editableTargetRef.current = null;
		}
		setHasSelection(canEditSelection());
		setEditableFocused(isEditableTarget(active));
		setShowDevTools(Boolean(import.meta.env.DEV) || isDeveloperMode());
	});

	useEffect(() => {
		const onSelectionChange = () => {
			// Base UI moves focus into the menu when it opens. Keep the edit state
			// captured from the right-click target until the menu closes so its
			// Copy/Cut/Paste choices remain available for the original selection.
			if (contextMenuOpenRef.current) {
				return;
			}
			refreshEditState();
		};
		document.addEventListener("selectionchange", onSelectionChange);
		document.addEventListener("focusin", onSelectionChange);
		document.addEventListener("focusout", onSelectionChange);
		return () => {
			document.removeEventListener("selectionchange", onSelectionChange);
			document.removeEventListener("focusin", onSelectionChange);
			document.removeEventListener("focusout", onSelectionChange);
		};
	}, []);

	const handleCut = () => {
		editableTargetRef.current?.focus();
		document.execCommand("cut");
	};
	const handleCopy = () => {
		editableTargetRef.current?.focus();
		document.execCommand("copy");
	};
	const handlePaste = async () => {
		const target = editableTargetRef.current;
		target?.focus();
		if (document.execCommand("paste")) {
			return;
		}
		try {
			const text = await navigator.clipboard.readText();
			const el = target ?? document.activeElement;
			if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
				const start = el.selectionStart ?? el.value.length;
				const end = el.selectionEnd ?? el.value.length;
				el.setRangeText(text, start, end, "end");
				el.dispatchEvent(new Event("input", { bubbles: true }));
			} else if (el instanceof HTMLElement && el.isContentEditable) {
				document.execCommand("insertText", false, text);
			}
		} catch {
			toast.error("Couldn't paste from the clipboard.");
		}
	};
	const handleSelectAll = () => {
		editableTargetRef.current?.focus();
		document.execCommand("selectAll");
	};

	const handleZoomIn = () => {
		setScale(clampScale(readScale() + SCALE_STEP));
	};
	const handleZoomOut = () => {
		setScale(clampScale(readScale() - SCALE_STEP));
	};
	const handleZoomReset = () => {
		setScale(DEFAULT_SCALE);
	};

	// Real OS fullscreen (Electron's View → Toggle Full Screen), not a zoom or a
	// DOM overlay — see lib/fullscreen.ts for why it goes through a command.
	const handleToggleFullscreen = async () => {
		try {
			await toggleFullscreen();
		} catch {
			toast.error("Couldn't toggle full screen in this window.");
		}
	};

	const handleReload = () => {
		window.location.reload();
	};

	const handleCopyConsole = async () => {
		const text = getConsoleBufferText();
		if (!text) {
			toast.info("Console buffer is empty.");
			return;
		}
		try {
			await navigator.clipboard.writeText(text);
			toast.success("Console copied");
		} catch {
			toast.error("Couldn't copy the console.");
		}
	};

	const handleReportBug = async () => {
		const context = buildBugReportContext();
		const shot = await captureViewportPng();

		let description =
			"Page context is on the clipboard — paste it into the feedback form.";

		if (shot) {
			try {
				await navigator.clipboard.write([
					new ClipboardItem({
						"image/png": shot,
						"text/plain": new Blob([context], { type: "text/plain" }),
					}),
				]);
				description =
					"Screenshot and page context are on the clipboard — paste them into the feedback form.";
			} catch {
				const shotCopied = await copyScreenshotToClipboard(shot);
				if (shotCopied) {
					description =
						"Screenshot is on the clipboard — paste it into the feedback form.";
				} else {
					try {
						await navigator.clipboard.writeText(context);
					} catch {
						// best-effort
					}
				}
			}
		} else {
			try {
				await navigator.clipboard.writeText(context);
			} catch {
				// best-effort
			}
		}

		openFeedbackWidget(resolvedTheme === "dark" ? "dark" : "light").catch(
			() => {
				toast.error({
					title: "Couldn't open feedback",
					description: "Please try again, or email us at support@ryu.app.",
				});
			}
		);

		toast.info({
			title: "Report a bug",
			description,
		});
	};

	const canCut = hasSelection && editableFocused;
	const canCopy = hasSelection;
	const canPaste = editableFocused;

	return (
		<ContextMenu
			onOpenChange={(open) => {
				contextMenuOpenRef.current = open;
				refreshEditState();
			}}
		>
			<ContextMenuTrigger className="flex h-screen min-h-0 w-full min-w-0 flex-col">
				{children}
			</ContextMenuTrigger>
			<ContextMenuPortal>
				<ContextMenuContent className="w-56">
					<ContextMenuGroup>
						<ContextMenuItem disabled={!canCut} onClick={handleCut}>
							<HugeiconsIcon icon={ScissorIcon} />
							Cut
							<ContextMenuShortcut>{mod}+X</ContextMenuShortcut>
						</ContextMenuItem>
						<ContextMenuItem disabled={!canCopy} onClick={handleCopy}>
							<HugeiconsIcon icon={Copy01Icon} />
							Copy
							<ContextMenuShortcut>{mod}+C</ContextMenuShortcut>
						</ContextMenuItem>
						<ContextMenuItem disabled={!canPaste} onClick={handlePaste}>
							<HugeiconsIcon icon={ClipboardPasteIcon} />
							Paste
							<ContextMenuShortcut>{mod}+V</ContextMenuShortcut>
						</ContextMenuItem>
						<ContextMenuItem onClick={handleSelectAll}>
							Select All
							<ContextMenuShortcut>{mod}+A</ContextMenuShortcut>
						</ContextMenuItem>
					</ContextMenuGroup>

					<ContextMenuSeparator />

					<ContextMenuGroup>
						<ContextMenuItem onClick={handleZoomIn}>
							<HugeiconsIcon icon={PlusSignIcon} />
							Zoom In
							<ContextMenuShortcut>{mod}+=</ContextMenuShortcut>
						</ContextMenuItem>
						<ContextMenuItem onClick={handleZoomOut}>
							<HugeiconsIcon icon={MinusSignIcon} />
							Zoom Out
							<ContextMenuShortcut>{mod}+-</ContextMenuShortcut>
						</ContextMenuItem>
						<ContextMenuItem onClick={handleZoomReset}>
							Actual Size
							<ContextMenuShortcut>{mod}+0</ContextMenuShortcut>
						</ContextMenuItem>
						<ContextMenuItem onClick={() => void handleToggleFullscreen()}>
							<HugeiconsIcon
								icon={isFullscreen ? ArrowShrink02Icon : FullScreenIcon}
							/>
							{isFullscreen ? "Exit Full Screen" : "Enter Full Screen"}
							{/* F11, not ⌃⌘F: eventToChord folds Ctrl and Cmd into one `Mod`
							    token, so a Cmd+Ctrl chord can never match a real keydown
							    (packages/hotkeys/src/chord.ts). Rebindable in Settings →
							    Keyboard Shortcuts; this label shows the default. */}
							<ContextMenuShortcut>F11</ContextMenuShortcut>
						</ContextMenuItem>
						<ContextMenuSub>
							<ContextMenuSubTrigger>
								<ClassicThemeIcon className="size-4 shrink-0" />
								<span>Appearance</span>
							</ContextMenuSubTrigger>
							<ContextMenuSubContent>
								<ContextMenuItem onClick={() => setTheme("light")}>
									<HugeiconsIcon className="h-4 w-4" icon={SunIcon} />
									Light
									{theme === "light" ? (
										<span className="ml-auto text-muted-foreground text-xs">
											Current
										</span>
									) : null}
								</ContextMenuItem>
								<ContextMenuItem onClick={() => setTheme("dark")}>
									<HugeiconsIcon className="h-4 w-4" icon={MoonIcon} />
									Dark
									{theme === "dark" ? (
										<span className="ml-auto text-muted-foreground text-xs">
											Current
										</span>
									) : null}
								</ContextMenuItem>
								<ContextMenuItem onClick={() => setTheme("system")}>
									<HugeiconsIcon className="h-4 w-4" icon={LaptopIcon} />
									System
									{theme === "system" ? (
										<span className="ml-auto text-muted-foreground text-xs">
											Current
										</span>
									) : null}
								</ContextMenuItem>
								<ContextMenuSeparator />
								<ContextMenuItem onClick={() => openSettings("appearance")}>
									<HugeiconsIcon icon={Settings01Icon} />
									Appearance settings
								</ContextMenuItem>
							</ContextMenuSubContent>
						</ContextMenuSub>
					</ContextMenuGroup>

					<ContextMenuSeparator />

					<ContextMenuGroup>
						<ContextMenuItem onClick={() => openSettings()}>
							<HugeiconsIcon icon={Settings01Icon} />
							Settings
							<ContextMenuShortcut>{mod}+,</ContextMenuShortcut>
						</ContextMenuItem>
						<ContextMenuItem onClick={handleReload}>
							<HugeiconsIcon icon={Refresh01Icon} />
							Reload
							<ContextMenuShortcut>{mod}+R</ContextMenuShortcut>
						</ContextMenuItem>
					</ContextMenuGroup>

					{showDevTools ? (
						<>
							<ContextMenuSeparator />
							<ContextMenuGroup>
								<ContextMenuItem onClick={() => void toggleDevtools()}>
									<HugeiconsIcon icon={ConsoleIcon} />
									Toggle DevTools
									<ContextMenuShortcut>
										{isMac ? "⌥⌘I" : "Ctrl+Shift+I"}
									</ContextMenuShortcut>
								</ContextMenuItem>
								{isConsoleCaptureActive() ? (
									<ContextMenuItem onClick={() => void handleCopyConsole()}>
										<HugeiconsIcon icon={Copy01Icon} />
										Copy console
									</ContextMenuItem>
								) : null}
							</ContextMenuGroup>
						</>
					) : null}

					<ContextMenuSeparator />

					<ContextMenuItem onClick={() => void handleReportBug()}>
						<HugeiconsIcon icon={Bug01Icon} />
						Report a bug…
					</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenuPortal>
		</ContextMenu>
	);
}
