// The two shared shapes of the provider settings: the list row that opens a
// page, and the frame of an opened page (back control, title, one status, one
// line under it). Both are built from the settings primitives every other
// pane uses, so the provider pages look like the rest of the window.

import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { useLiteralMessages, useLocalizedString } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { DirectionalIcon } from "@ryu/ui/components/directional-icon.tsx";
import { type ReactNode, useEffect, useRef } from "react";
import { SettingsItem } from "../shared/settings-items.tsx";

/** The attribute a row's button carries, so "back" can find it again. */
export const PAGE_ROW_ATTRIBUTE = "data-provider-page-row";

interface ProviderNavRowProps {
	/** A status or a current value, shown before the chevron. */
	end?: ReactNode;
	/** The logo or icon tile in front of the name. */
	mark?: ReactNode;
	onOpen: () => void;
	/** Names the row for the focus return. Unique on the list. */
	rowId: string;
	/** The one quiet line under the name. */
	summary?: ReactNode;
	title: ReactNode;
}

/**
 * One row of the list: mark, name, a one line summary, a status at the end.
 * The whole row is one button, so it is one tab stop and Enter or Space opens
 * the page. The summary is inside the button and so is part of its name.
 */
export function ProviderNavRow({
	end,
	mark,
	onOpen,
	rowId,
	summary,
	title,
}: ProviderNavRowProps) {
	return (
		<SettingsItem
			actions={
				<span className="flex items-center gap-2">
					{end}
					<DirectionalIcon
						className="size-4 text-muted-foreground"
						icon={ArrowRight01Icon}
					/>
				</span>
			}
			// `relative` is load-bearing: the button's full-row overlay below
			// positions against this row.
			className="relative cursor-pointer"
			navigation
			title={
				<button
					className="flex w-full items-center gap-3 rounded-sm text-start outline-none focus-visible:ring-2 focus-visible:ring-ring"
					data-provider-page-row={rowId}
					onClick={onOpen}
					type="button"
				>
					{/* The mark repeats the name that follows it. A logo is hidden from
					    readers already; an initial that stands in for one must not
					    become the first word of the button's name. */}
					{mark ? (
						<span aria-hidden="true" className="contents">
							{mark}
						</span>
					) : null}
					<span className="flex min-w-0 flex-col gap-0.5">
						<span className="min-w-0 truncate">{title}</span>
						{summary ? (
							<span className="min-w-0 truncate font-normal text-detail text-muted-foreground">
								{summary}
							</span>
						) : null}
					</span>
					{/* Stretches the button across the row, so the status and the
					    chevron are part of the one click target without sitting
					    inside the button. */}
					<span aria-hidden="true" className="absolute inset-0" />
				</button>
			}
		/>
	);
}

interface ProviderPageFrameProps {
	/** One status beside the title. */
	badge?: ReactNode;
	children: ReactNode;
	/** One plain line under the title. */
	hint?: ReactNode;
	/** The logo in front of the title. */
	mark?: ReactNode;
	onBack: () => void;
	/** The name of the list the back control returns to, in English. */
	parentTitle: string;
	title: string;
}

/**
 * An opened page. Focus moves to the title when the page appears, so a screen
 * reader announces where the user is and the next Tab enters the page; the
 * back control sits right before the title, one Shift+Tab away.
 */
export function ProviderPageFrame({
	badge,
	children,
	hint,
	mark,
	onBack,
	parentTitle,
	title,
}: ProviderPageFrameProps) {
	const tl = useLiteralMessages();
	const parent = useLocalizedString(parentTitle) ?? parentTitle;
	const backLabel = tl("Back to {pageTitle}", { pageTitle: parent });
	const heading = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		heading.current?.focus();
	}, []);

	return (
		<div className="flex flex-col gap-6" data-provider-page={title}>
			<div className="flex flex-col gap-1">
				<div className="-ms-2 flex flex-wrap items-center gap-2">
					<Button
						aria-label={backLabel}
						onClick={onBack}
						size="icon-sm"
						title={backLabel}
						type="button"
						variant="ghost-muted"
					>
						<DirectionalIcon className="size-4" icon={ArrowLeft01Icon} />
					</Button>
					{mark ? (
						<span aria-hidden="true" className="contents">
							{mark}
						</span>
					) : null}
					<h3
						className="rounded-sm font-semibold text-lg tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring"
						ref={heading}
						tabIndex={-1}
					>
						{title}
					</h3>
					{badge}
				</div>
				{hint ? (
					<p className="text-detail text-muted-foreground">{hint}</p>
				) : null}
			</div>
			{children}
		</div>
	);
}
