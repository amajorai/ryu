// The desktop shell's one banner pattern: an inline `h-8` strip under the
// header with a muted (or status-coloured) icon, one sentence and at most one
// ghost `sm` action. System banners (connection, reconnect retry, Safe Mode,
// updates) and page-level notices in other packets reuse it instead of
// growing their own pills, shadows or tinted cards.

export {
	StatusStrip as ShellBanner,
	type StatusStripProps as ShellBannerProps,
	type StatusStripTone as ShellBannerTone,
} from "@ryu/ui/components/connection-status-strip.tsx";
