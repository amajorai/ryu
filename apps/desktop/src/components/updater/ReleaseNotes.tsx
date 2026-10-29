// apps/desktop/src/components/updater/ReleaseNotes.tsx
//
// The toast body for "an update is available". sileo's `description` takes a
// ReactNode, so the update toasts render this instead of dumping the release
// body's raw markdown source into a string slot (`### Install`, `| macOS |`,
// fenced `curl | sh` blocks — see `lib/release-notes.ts` for what that looked
// like and why selection matters more than formatting).
//
// Deliberately NOT a markdown renderer. The summariser hands over typed segments,
// so this file only decides typography — no HTML is constructed from network
// text, and no markdown engine is pulled into a toast.

import { safeHttpUrl } from "@ryu/marketplace/catalog/safe-url";
import type { ReactNode } from "react";
import {
	type NoteSection,
	type NoteSegment,
	type ReleaseNotesSummary,
	summarizeReleaseNotes,
} from "@/src/lib/release-notes.ts";

function Segments({ segments }: { segments: NoteSegment[] }) {
	return (
		<>
			{segments.map((segment, index) => {
				// Segments are positional runs of one immutable string — there is no
				// id to key on, and the array is never reordered or spliced.
				const key = `${index}:${segment.text}`;
				if (segment.code) {
					return (
						<code
							className="rounded bg-black/10 px-1 py-px font-mono text-sm dark:bg-white/10"
							key={key}
						>
							{segment.text}
						</code>
					);
				}
				if (segment.bold) {
					return (
						<span className="font-medium" key={key}>
							{segment.text}
						</span>
					);
				}
				return <span key={key}>{segment.text}</span>;
			})}
		</>
	);
}

function Section({ section }: { section: NoteSection }) {
	return (
		<div className="space-y-0.5">
			{section.title ? (
				<div className="font-medium text-sm opacity-70">{section.title}</div>
			) : null}
			<ul className="space-y-0.5">
				{section.items.map((item, index) => (
					<li
						className="flex gap-1.5 leading-snug"
						// Same positional-key reasoning as `Segments`.
						key={`${index}:${item.map((s) => s.text).join("")}`}
					>
						<span aria-hidden="true" className="opacity-50">
							•
						</span>
						<span>
							<Segments segments={item} />
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

export interface ReleaseNotesProps {
	/** The release page, for the "full release notes" escape when clipped. */
	htmlUrl?: string | null;
	summary: ReleaseNotesSummary;
}

export function ReleaseNotes({ htmlUrl, summary }: ReleaseNotesProps) {
	const safeHtmlUrl = safeHttpUrl(htmlUrl);
	return (
		<div className="space-y-1.5">
			{summary.sections.map((section, index) => (
				<Section key={`${index}:${section.title ?? ""}`} section={section} />
			))}
			{/* sileo's `button` slot is singular and already spent on "Update now",
			    so the escape to the unabridged notes has to be an inline link. */}
			{summary.truncated && safeHtmlUrl ? (
				<a
					className="inline-block underline underline-offset-2 opacity-70 hover:opacity-100"
					href={safeHtmlUrl}
					rel="noopener"
					target="_blank"
				>
					Full release notes
				</a>
			) : null}
		</div>
	);
}

export interface UpdateToastBodyOptions {
	/** Shown when the release carries no summarisable notes. */
	fallback: string;
	/** Sentence appended under the notes (e.g. the security-waiver explanation). */
	footnote?: string;
	htmlUrl?: string | null;
	notes?: string | null;
}

/**
 * The description every "update available" toast passes to sileo.
 *
 * One definition because all three call sites (launch updater, App Updates tab,
 * Gateway Updates tab) previously each rendered `verdict.notes` their own way —
 * two dumped raw markdown and the third threw the notes away entirely and
 * hardcoded a sentence.
 */
export function updateToastBody({
	fallback,
	footnote,
	htmlUrl,
	notes,
}: UpdateToastBodyOptions): ReactNode {
	const summary = summarizeReleaseNotes(notes);
	if (!summary) {
		return footnote ? `${fallback} ${footnote}` : fallback;
	}
	return (
		<div className="space-y-1.5">
			<ReleaseNotes htmlUrl={htmlUrl} summary={summary} />
			{footnote ? <div className="opacity-70">{footnote}</div> : null}
		</div>
	);
}

/**
 * The sileo slot an update toast lands in.
 *
 * REQUIRED whenever `description` is a ReactNode: the shared toast wrapper
 * derives an id from `` `${title} ${description}` `` when the caller supplies
 * none, and a ReactNode stringifies to `[object Object]` — so every
 * ReactNode-bodied toast would collide into one slot and stomp each other. See
 * `toastContentId` in packages/ui/src/components/sileo.tsx.
 *
 * Keyed by version so re-checking the same release reuses one slot instead of
 * stacking a duplicate toast.
 */
export function updateToastId(version: string): string {
	return `ryu-update-${version}`;
}
