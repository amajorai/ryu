import { cn } from "@ryu/ui/lib/utils.ts";
import { cva } from "class-variance-authority";
import drawingStyles from "./button-drawing.module.css";

/** The shared circular chrome used by image viewer buttons and download links. */
export const imageViewerControlClasses =
	"grid size-9 place-items-center rounded-full border border-image-viewer-foreground/10 bg-image-viewer-background/50 text-image-viewer-foreground outline-none backdrop-blur-sm transition-image-viewer-control duration-150 hover:border-image-viewer-foreground/25 hover:bg-image-viewer-background/70 focus-visible:ring-2 focus-visible:ring-image-viewer-foreground/60";

const buttonVariantClasses = cva(
	"group/button corner-squircle inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-4xl border border-transparent bg-clip-padding font-medium text-sm outline-none transition-[color,background-color,border-color,box-shadow,opacity,scale,translate] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring active:not-aria-[haspopup]:translate-y-px active:duration-75 disabled:pointer-events-none disabled:opacity-50 has-[>div.flex-col]:items-stretch aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
	{
		variants: {
			typography: { default: "", compact: "text-xs", caption: "type-caption" },
			radius: { default: "", pill: "rounded-full", small: "rounded-sm" },
			variant: {
				default:
					"bg-primary text-primary-foreground hover:bg-primary/80 active:bg-primary/70",
				mono: "bg-foreground text-background hover:bg-foreground/90 active:bg-foreground/80",
				outline:
					"border-border bg-background hover:bg-muted hover:text-foreground active:bg-[color-mix(in_oklch,var(--muted),var(--foreground)_6%)] aria-expanded:bg-muted aria-expanded:text-foreground dark:bg-transparent dark:active:bg-input/50 dark:hover:bg-input/30",
				secondary:
					"bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] active:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_10%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
				ghost:
					"hover:bg-muted hover:text-foreground active:bg-[color-mix(in_oklch,var(--muted),var(--foreground)_6%)] aria-expanded:bg-muted aria-expanded:text-foreground dark:active:bg-muted dark:hover:bg-muted/50",
				"ghost-muted":
					"text-muted-foreground hover:bg-muted hover:text-foreground active:bg-[color-mix(in_oklch,var(--muted),var(--foreground)_6%)] aria-expanded:bg-muted aria-expanded:text-foreground dark:active:bg-muted dark:hover:bg-muted/50",
				destructive:
					"bg-destructive/10 text-status-destructive hover:bg-destructive/20 focus-visible:border-destructive focus-visible:ring-destructive active:bg-destructive/30 dark:bg-destructive/20 dark:active:bg-destructive/40 dark:hover:bg-destructive/30",
				link: "text-primary underline-offset-4 hover:underline active:text-primary/70",
				loading:
					"relative bg-primary text-primary-foreground hover:bg-primary/80 active:bg-primary/70",
				progress:
					"relative overflow-hidden bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] active:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_10%)]",
			},
			size: {
				"transcript-follow-icon": "corner-round size-9 h-8 w-8",
				"transcript-follow-unread":
					"h-8 h-8 gap-1 gap-1.5 px-3 px-3 has-data-[icon=inline-start]:ps-2 has-data-[icon=inline-end]:pe-2",
				compact:
					"h-7 gap-1 px-3 text-xs has-data-[icon=inline-start]:ps-2 has-data-[icon=inline-end]:pe-2",
				dense:
					"h-7 gap-1 px-2 text-xs has-data-[icon=inline-start]:ps-2 has-data-[icon=inline-end]:pe-2",
				default:
					"h-9 gap-1.5 px-3 has-data-[icon=inline-start]:ps-2.5 has-data-[icon=inline-end]:pe-2.5",
				xs: "h-6 gap-1 px-2.5 text-xs has-data-[icon=inline-start]:ps-2 has-data-[icon=inline-end]:pe-2 [&_svg:not([class*='size-'])]:size-3",
				sm: "h-8 gap-1 px-3 has-data-[icon=inline-start]:ps-2 has-data-[icon=inline-end]:pe-2",
				tiny: "h-6 gap-1 px-2 text-xs has-data-[icon=inline-start]:ps-2 has-data-[icon=inline-end]:pe-2",
				"compact-panel":
					"type-compact h-7 gap-1 px-3 has-data-[icon=inline-start]:ps-2 has-data-[icon=inline-end]:pe-2",
				caption:
					"type-caption h-7 gap-1 px-3 has-data-[icon=inline-start]:ps-2 has-data-[icon=inline-end]:pe-2",
				"micro-dense":
					"type-compact h-7 gap-1 px-1.5 has-data-[icon=inline-start]:ps-2 has-data-[icon=inline-end]:pe-2",
				micro:
					"type-compact h-6 gap-1 px-1.5 has-data-[icon=inline-start]:ps-2 has-data-[icon=inline-end]:pe-2",
				lg: "h-14 gap-2 px-6 has-data-[icon=inline-start]:ps-5 has-data-[icon=inline-end]:pe-5",
				icon: "corner-round size-9",
				"icon-xs": "corner-round size-6 [&_svg:not([class*='size-'])]:size-3",
				"icon-sm": "corner-round size-8",
				"icon-lg": "corner-round size-10",
			},
			spacing: {
				default: "",
				standard: "gap-2",
				comfortable: "gap-3",
				regular: "gap-1.5",
				"body-preview": "px-0 py-1",
			},
			edge: { joined: "border-r-0" },
			appearance: {
				"download-primary": "gap-1.5",
				"download-primary-transparent":
					"gap-1.5 border-foreground/15 bg-transparent backdrop-blur-sm",
				"download-trigger": "px-0",
				"download-trigger-transparent":
					"border-foreground/15 bg-transparent px-0 backdrop-blur-sm",
				"extension-quick-send": "size-8 rounded-xl",
				"store-engine-update": "text-primary hover:text-primary",
				"settings-back": "h-7 px-2",
				"managed-shader": "hover:!text-inherit",
				"goal-verdict-success":
					"size-7 shrink-0 rounded-full text-status-success",
				"goal-verdict-warning":
					"size-7 shrink-0 rounded-full text-status-warning",
				"attachment-remove-visible":
					"relative size-4 rounded-full text-muted-foreground opacity-100 after:absolute after:-inset-1 after:content-[''] hover:text-foreground",
				"attachment-remove-hidden":
					"relative size-4 rounded-full text-muted-foreground opacity-0 after:absolute after:-inset-1 after:content-[''] hover:text-foreground",
				"composer-mode": [
					"h-auto w-full items-center justify-start gap-1.5 rounded-2xl px-1.5 py-1 text-left font-medium text-sm",
					"items-start",
				],
				"composer-mode-active": [
					"h-auto w-full items-center justify-start gap-1.5 rounded-2xl px-1.5 py-1 text-left font-medium text-sm",
					"items-start bg-accent",
				],
				"composer-settings":
					"h-7 gap-1 rounded-md px-1.5 text-[12px] text-muted-foreground leading-4",
				"composer-settings-foreground": [
					"h-7 gap-1 rounded-md px-1.5 text-[12px] text-muted-foreground leading-4",
					"text-foreground hover:bg-muted",
				],
				"workbench-status": "type-caption h-5 px-1.5",
				"workbench-tab-close":
					"size-5 opacity-0 focus-visible:opacity-100 group-hover/workbench-tab:opacity-100",
				"worktree-handoff":
					"gap-1.5 border-border/70 text-muted-foreground text-xs hover:bg-muted/60 hover:text-foreground",
				"question-option":
					"h-auto w-full justify-start gap-2 rounded-md px-2 py-1.5 text-left font-normal",
				"question-navigation": "h-6 px-2",
				"question-submit": "h-6 px-2.5",
				"collapse-toggle": "h-6 px-2 text-xs",
				"goal-save": "size-6 text-muted-foreground/80",
				"goal-action": "size-6 text-muted-foreground/70",
				"answer-now":
					"h-auto px-0 text-muted-foreground text-xs underline hover:text-foreground",
				"banner-customize":
					"border-white/25 bg-black/35 text-white backdrop-blur hover:bg-black/55 hover:text-white",
				"markdown-diagram-expand": "rounded-md",
				"markdown-table-expand": "bg-background/90 shadow-sm",
				"picker-install": "h-6 gap-1 px-2 text-xs",
				"picker-remove":
					"size-6 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/recent:opacity-100",
				"marketplace-hero-cta": "shadow-sm ring-1 ring-black/10",
				"composer-info-action": "h-6 px-2 text-xs",
				"composer-info-dismiss":
					"text-muted-foreground/70 hover:text-foreground",
				"composer-info-dismiss-destructive":
					"text-status-destructive/70 hover:text-status-destructive",
				"composer-save-temporary": "h-7 px-2 text-xs",
				"composer-draft-delete": "opacity-0 group-hover:opacity-100",
				"service-action": "h-7 px-2",
				"service-retry":
					"h-7 px-2 text-status-warning hover:text-status-warning",
				"service-update": "h-7 px-2 text-status-info hover:text-status-info",
				"academy-reset": "h-7 px-2 text-xs",
				"code-copy":
					"h-8 px-2 opacity-100 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 sm:opacity-0",
				"cancel-request": "text-muted-foreground hover:text-status-destructive",
				"mark-read":
					"opacity-60 transition-opacity hover:opacity-100 group-hover:opacity-100",
				"organization-switch": "h-8 gap-1.5 px-2 font-medium text-sm",
				"recipient-remove": "size-6 rounded-full p-0",
				"plain-label": "font-normal",
				"account-return": "text-muted-foreground",
				"password-reveal": "px-3 py-2 hover:bg-transparent",
				"agent-model-option":
					"h-auto w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left font-medium text-sm",
				"agent-model-picker": "w-full justify-between font-normal",
				"agent-integration-option":
					"h-auto w-full justify-start gap-2 rounded-none px-3.5 py-2.5 font-normal",
				"bot-decision": "type-caption h-7 px-2",
				"bot-feed-action": "type-compact h-7 gap-1 px-2",
				"bot-feed-action-liked": "type-compact h-7 gap-1 px-2 text-primary",
				"bot-feed-submit": "type-compact h-7 px-2",
				"bot-retry": "type-compact h-7 px-2.5",
				"bot-goal-action": "h-8 text-xs",
				"bot-summary": "type-compact h-6 px-1.5",
				"account-menu-menubar":
					"flex size-[24px] items-center justify-center rounded-lg p-0 text-white/70 transition-colors hover:bg-white/10 hover:text-white",
				"account-menu-sidebar":
					"flex w-full items-center justify-start gap-2 rounded-xl py-1.5 pr-2 pl-1 text-left transition-colors hover:bg-muted",
				"composer-stop":
					"size-7 rounded-full bg-foreground text-background hover:bg-foreground/90 disabled:opacity-100",
				"composer-call":
					"size-7 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-100",
				"composer-recording":
					"size-7 rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-100",
				"composer-pending":
					"size-7 rounded-full bg-muted text-muted-foreground disabled:opacity-100",
				"composer-dictation":
					"size-7 rounded-full bg-muted text-foreground hover:bg-muted/70 disabled:opacity-100",
				"composer-send":
					"size-7 rounded-full bg-primary text-primary-foreground disabled:opacity-100",
				"voice-call-end":
					"h-8 gap-1.5 rounded-full bg-destructive px-3 text-destructive-foreground hover:bg-destructive/90",
				"voice-call-muted":
					"bg-destructive/15 text-status-destructive hover:bg-destructive/20 hover:text-status-destructive",
				"dictation-pending": "size-7 text-muted-foreground",
				"dictation-recording":
					"size-7 text-status-destructive hover:text-status-destructive",
				"dictation-ready": "size-7 text-muted-foreground hover:text-foreground",
				"drawing-tool": drawingStyles.tool,
				"drawing-action": drawingStyles.action,
				"drawing-swatch": drawingStyles.swatch,
				"drawing-close": drawingStyles.close,
				"drawing-attach": drawingStyles.attach,
				"transcript-copy": "size-6 rounded-md opacity-50 hover:opacity-100",
				"transcript-version":
					"size-5 rounded-md opacity-60 hover:opacity-100 disabled:opacity-25",
				"transcript-more": "size-6 rounded-md opacity-60 hover:opacity-100",
				"transcript-follow":
					"rounded-full border-border bg-background/85 text-muted-foreground shadow-sm backdrop-blur-sm transition-colors hover:text-foreground",
				"queued-message-action": "size-5 rounded-sm text-muted-foreground/70",
				"queue-send-all": "h-5 rounded-sm px-1.5",
				"clipboard-format-copy":
					"type-caption h-7 gap-1 rounded-md px-1.5 text-muted-foreground hover:text-foreground",
				"composer-suggestion":
					"h-7 rounded-md px-2 text-muted-foreground hover:text-foreground",
				"plan-approve": "h-7 px-2.5 text-xs",
				"island-consent-declined": "bg-secondary text-foreground",
				"island-panel": "bg-muted text-foreground hover:bg-accent",
				"island-tab-active": "bg-accent text-foreground hover:bg-accent",
				"island-kind-active": "bg-secondary text-foreground hover:bg-secondary",
				"island-kind-inactive": "text-muted-foreground hover:text-foreground",

				default: "",
				"image-viewer": imageViewerControlClasses,
				"theme-field":
					"flex cursor-pointer rounded border-border px-2 font-mono text-xs transition-opacity hover:opacity-90",
				"theme-swatch":
					"flex cursor-pointer rounded-md border-2 border-border transition-[scale,border-color] hover:scale-105 hover:border-ring/50",
				"theme-swatch-selected":
					"flex cursor-pointer rounded-md border-2 border-ring ring-2 ring-ring ring-offset-1 ring-offset-background transition-[scale] hover:scale-105",
				"support-warning":
					"border-warning/30 bg-warning/10 text-status-warning hover:bg-support-warning-hover",
			},
		},
		compoundVariants: [
			{
				appearance: ["download-trigger", "download-trigger-transparent"],
				size: "default",
				className: "h-9 w-9",
			},
			{
				appearance: ["download-trigger", "download-trigger-transparent"],
				size: "sm",
				className: "h-8 w-8",
			},
			{
				appearance: ["download-trigger", "download-trigger-transparent"],
				size: "lg",
				className: "h-14 w-12",
			},
		],
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	}
);

/** Server-safe class contract shared by the interactive Button and link-style
 * consumers that need the same visual treatment during server rendering. The
 * output is merged so a variant's border colour (e.g. outline's `border-border`)
 * replaces the base `border-transparent` even when callers skip `cn()`. */
export function buttonVariants(
	props?: Parameters<typeof buttonVariantClasses>[0]
): string {
	return cn(buttonVariantClasses(props));
}
