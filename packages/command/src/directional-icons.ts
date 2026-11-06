import {
	ArrowLeft01Icon,
	ArrowLeft02Icon,
	ArrowLeft03Icon,
	ArrowLeft04Icon,
	ArrowLeft05Icon,
	ArrowLeftBigIcon,
	ArrowLeftDoubleIcon,
	ArrowLeftIcon,
	ArrowRight01Icon,
	ArrowRight02Icon,
	ArrowRight03Icon,
	ArrowRight04Icon,
	ArrowRight05Icon,
	ArrowRightBigIcon,
	ArrowRightDoubleIcon,
	ArrowRightIcon,
	ArrowTurnBackwardIcon,
	ArrowTurnForwardIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	Login01Icon,
	Login02Icon,
	Login03Icon,
	LoginCircle01Icon,
	LoginCircle02Icon,
	LoginSquare01Icon,
	LoginSquare02Icon,
	Logout01Icon,
	Logout02Icon,
	Logout03Icon,
	Logout04Icon,
	Logout05Icon,
	LogoutCircle01Icon,
	LogoutCircle02Icon,
	LogoutSquare01Icon,
	LogoutSquare02Icon,
	MailReply01Icon,
	MailReply02Icon,
	MailReplyAll01Icon,
	MailReplyAll02Icon,
	MailReplyAllIcon,
	MailReplyIcon,
	Redo01Icon,
	Redo02Icon,
	Redo03Icon,
	RedoDotIcon,
	RedoIcon,
	ReplyAllIcon,
	ReplyIcon,
	SendHorizontalIcon,
	SendIcon,
	Sent02Icon,
	SentIcon,
	Undo02Icon,
	Undo03Icon,
	UndoDotIcon,
	UndoIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";

/**
 * Hugeicons glyphs that point along the reading direction. Palette actions
 * carry their icon as data, so the renderer cannot see the export name; it
 * checks the icon against this set and mirrors a match under `dir="rtl"`.
 * Two-headed arrows (`ArrowLeftRight`) and diagonal "open externally" arrows
 * (`ArrowUpRight`) read the same either way and are left out.
 */
const HORIZONTAL_ICONS: ReadonlySet<IconSvgElement> = new Set([
	ArrowLeft01Icon,
	ArrowLeft02Icon,
	ArrowLeft03Icon,
	ArrowLeft04Icon,
	ArrowLeft05Icon,
	ArrowLeftBigIcon,
	ArrowLeftDoubleIcon,
	ArrowLeftIcon,
	ArrowRight01Icon,
	ArrowRight02Icon,
	ArrowRight03Icon,
	ArrowRight04Icon,
	ArrowRight05Icon,
	ArrowRightBigIcon,
	ArrowRightDoubleIcon,
	ArrowRightIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
]);

/**
 * Reply, undo/redo and turn-back/turn-forward glyphs curl along the reading
 * direction, so "reply" and "undo" read as "forward" and "redo" unless they
 * mirror under `dir="rtl"` too.
 */
const TURN_ICONS: ReadonlySet<IconSvgElement> = new Set([
	ArrowTurnBackwardIcon,
	ArrowTurnForwardIcon,
	MailReply01Icon,
	MailReply02Icon,
	MailReplyAll01Icon,
	MailReplyAll02Icon,
	MailReplyAllIcon,
	MailReplyIcon,
	Redo01Icon,
	Redo02Icon,
	Redo03Icon,
	RedoDotIcon,
	RedoIcon,
	ReplyAllIcon,
	ReplyIcon,
	Undo02Icon,
	Undo03Icon,
	UndoDotIcon,
	UndoIcon,
]);

/**
 * The paper-plane Send glyph flies toward the inline end, and the Log-in and
 * Log-out glyphs draw an arrow through a door, so they mirror under
 * `dir="rtl"` too (Material marks send and logout as auto-mirrored).
 */
const SEND_AND_SESSION_ICONS: ReadonlySet<IconSvgElement> = new Set([
	Login01Icon,
	Login02Icon,
	Login03Icon,
	LoginCircle01Icon,
	LoginCircle02Icon,
	LoginSquare01Icon,
	LoginSquare02Icon,
	Logout01Icon,
	Logout02Icon,
	Logout03Icon,
	Logout04Icon,
	Logout05Icon,
	LogoutCircle01Icon,
	LogoutCircle02Icon,
	LogoutSquare01Icon,
	LogoutSquare02Icon,
	SendHorizontalIcon,
	SendIcon,
	Sent02Icon,
	SentIcon,
]);

/**
 * Whether `icon` is a horizontal arrow or chevron, a reply, undo/redo or turn
 * glyph, or a send or log-in/log-out glyph, that should mirror in RTL.
 */
export function isDirectionalIcon(icon: IconSvgElement): boolean {
	return (
		HORIZONTAL_ICONS.has(icon) ||
		TURN_ICONS.has(icon) ||
		SEND_AND_SESSION_ICONS.has(icon)
	);
}
