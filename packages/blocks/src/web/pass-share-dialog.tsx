"use client";

import {
	CheckmarkCircle02Icon,
	Copy01Icon,
	Download04Icon,
	Gif01Icon,
	Image02Icon,
	VideoReplayIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import {
	DEFAULT_PASS_FORMAT_ID,
	PASS_FORMATS,
	type PassFormatId,
	passFormat,
} from "@ryu/ui/components/pass-studio/formats.ts";
import {
	PASS_STILL_TIME,
	PassStudio,
	type PassStudioHandle,
	type PassStudioProps,
} from "@ryu/ui/components/pass-studio/pass-studio.tsx";
import { downloadBlob } from "@ryu/ui/components/pass-studio/record.ts";
import { toast } from "@ryu/ui/components/sileo.tsx";
import {
	Tabs,
	TabsContent,
	TabsIndicator,
	TabsList,
	TabsTrigger,
} from "@ryu/ui/components/tabs.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { SvglIcon } from "./svgl-icon.tsx";

// Preview-then-share for a card, in whichever shape the post wants it.
//
// This is the SHELL both share dialogs are: the format ladder, the ten-second
// recording and its abort, the clipboard write, and the four actions under the
// preview. Which card is being shared is entirely the `studio` prop's business —
// the shell never learns whether it is looking at a waitlist pass or a paid
// tier, which is what stops a fix to the recorder's abort path or to Safari's
// clipboard turn from having to be made twice.
//
// It lives in `@ryu/blocks` rather than `apps/web` because the DESKTOP waitlist
// gate opens the same dialog. That is also why the toasts come from
// `@ryu/ui/components/sileo` rather than importing `sileo` directly: blocks
// does not declare that dependency, and the wrapper is what both shells mount.
//
// Image copies to the clipboard as an actual `image/png`, which is what makes it
// pasteable straight into a post. Video cannot: there is no `video/mp4`
// clipboard path in any browser, so its action is a download and the composer
// opens beside it. GIF is the third shape: smaller and lossier, but it autoplays
// inline in Slack, Discord, iMessage and READMEs, where a video needs a click.

const COPIED_RESET_MS = 2000;
const PERCENT = 100;

type ShareTab = "gif" | "image" | "video";

/**
 * `Omit` over a union collapses to the keys the arms share, which would erase
 * exactly the two seams `PassStudioProps` exists to express. Distributing it
 * keeps `content`/`face` and `seed`/`backdrop` mutually exclusive at the call
 * site, so the shell can be seam-agnostic without either dialog losing the
 * type error that stops it passing both.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
	? Omit<T, K>
	: never;

/** Everything about the card EXCEPT what the shell drives itself. */
export type PassShareStudioProps = DistributiveOmit<
	PassStudioProps,
	"formatId" | "frame" | "paused" | "ref"
>;

export interface PassShareDialogProps {
	description: ReactNode;
	/** `ryu-pass` → `ryu-pass-9x16.png`. Ratio and extension are the shell's. */
	filenameStem: string;
	onOpenChange: (open: boolean) => void;
	onShareOnLinkedIn: () => void;
	onShareOnX: () => void;
	open: boolean;
	/** The card. Build `face`/`backdrop` (or `content`) in a `useMemo` — they are
	 *  the scene's identity, and a fresh object rebuilds it. */
	studio: PassShareStudioProps;
	title: ReactNode;
}

export function PassShareDialog({
	description,
	filenameStem,
	onOpenChange,
	onShareOnLinkedIn,
	onShareOnX,
	open,
	studio,
	title,
}: PassShareDialogProps) {
	const tl = useLiteralMessages();
	const reduceMotion = useReducedMotion();
	const studioRef = useRef<PassStudioHandle | null>(null);
	const [tab, setTab] = useState<ShareTab>("image");
	const [formatId, setFormatId] = useState<PassFormatId>(
		DEFAULT_PASS_FORMAT_ID
	);
	const [copied, setCopied] = useState(false);
	const [busy, setBusy] = useState(false);
	const [progress, setProgress] = useState(0);
	// Encoding can take longer than the loop on a slow device. Closing the dialog has to
	// stop it, or it finishes against a torn-down studio and drops a file in the
	// user's downloads long after they walked away from the idea.
	const recordingRef = useRef<AbortController | null>(null);

	const format = passFormat(formatId);

	const filename = (extension: string) =>
		`${filenameStem}-${format.ratio.replace(":", "x")}.${extension}`;

	const copyImage = async () => {
		setBusy(true);
		try {
			// `ClipboardItem` is fed a promise rather than an awaited blob: Safari
			// only honours a clipboard write inside the gesture that started it, and
			// awaiting first puts the write on a later task where it is rejected.
			// Passing the promise keeps the whole thing in this turn.
			await navigator.clipboard.write([
				new ClipboardItem({
					"image/png":
						studioRef.current?.exportStill() ??
						Promise.reject(new Error("The card is still rendering")),
				}),
			]);
			setCopied(true);
			setTimeout(() => setCopied(false), COPIED_RESET_MS);
		} catch {
			toast.error("Couldn't copy the image", {
				description: "Download it instead, or right-click the preview.",
			});
		} finally {
			setBusy(false);
		}
	};

	const downloadImage = async () => {
		setBusy(true);
		try {
			const blob = await studioRef.current?.exportStill();
			if (blob) {
				downloadBlob(blob, filename("png"));
			}
		} catch {
			toast.error("Couldn't render the image");
		} finally {
			setBusy(false);
		}
	};

	const downloadMotion = async (kind: "gif" | "video") => {
		setBusy(true);
		setProgress(0);
		const controller = new AbortController();
		recordingRef.current = controller;
		const onProgress = (fraction: number) => {
			if (!controller.signal.aborted) {
				setProgress(fraction);
			}
		};
		try {
			const recording =
				kind === "gif"
					? await studioRef.current?.exportGif(onProgress, controller.signal)
					: await studioRef.current?.exportLoop(onProgress, controller.signal);
			if (controller.signal.aborted) {
				return;
			}
			if (recording) {
				downloadBlob(recording.blob, filename(recording.extension));
				if (recording.extension === "webm") {
					// Firefox records only WebM, which X and Instagram reject. Better to
					// say so at the download than to let the upload fail later.
					toast.info("Saved as WebM", {
						description:
							"This browser can't record MP4. Chrome or Safari will give you a file X and Instagram accept.",
					});
				}
			}
		} catch (error) {
			if (controller.signal.aborted) {
				return;
			}
			// The background-tab case is reported specifically: it is the one failure
			// a member can actually do something about, and its symptom (a still
			// image where a turning card should be) looks identical to a bug.
			const backgrounded = String(error).includes("background");
			toast.error(
				backgrounded
					? "Recording stopped — the window went to the background"
					: kind === "gif"
						? "Couldn't make the GIF"
						: "Couldn't record the video",
				{
					description:
						"Keep this window in the foreground until the file is ready.",
				}
			);
		} finally {
			if (recordingRef.current === controller) {
				recordingRef.current = null;
				setBusy(false);
				setProgress(0);
			}
		}
	};

	const handleOpenChange = (next: boolean) => {
		if (!next) {
			recordingRef.current?.abort();
			setTab("image");
			setFormatId(DEFAULT_PASS_FORMAT_ID);
			setCopied(false);
			setProgress(0);
		}
		onOpenChange(next);
	};

	return (
		<Dialog onOpenChange={handleOpenChange} open={open}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>

				<Tabs
					onValueChange={(value) =>
						// SAFETY: this private Tabs root selects only its authored
						// image/video/gif triggers below, which are the ShareTab alternatives.
						setTab(value as ShareTab)
					}
					spacing="comfortable"
					value={tab}
				>
					{/* `mx-auto` on a `w-fit` list: the strip is the dialog's primary
					    control here, not a filter above content, so it reads as centred
					    under the title rather than hanging off the left edge. */}
					<TabsList className="mx-auto" manageLayout={false} variant="pills-lg">
						<TabsIndicator />
						<TabsTrigger disabled={busy} value="image">
							<HugeiconsIcon icon={Image02Icon} size={15} />
							Image
						</TabsTrigger>
						<TabsTrigger disabled={busy} value="video">
							<HugeiconsIcon icon={VideoReplayIcon} size={15} />
							Video
						</TabsTrigger>
						<TabsTrigger disabled={busy} value="gif">
							<HugeiconsIcon icon={Gif01Icon} size={15} />
							GIF
						</TabsTrigger>
					</TabsList>

					{/* One ratio row for both tabs rather than one each: the choice is
					    about where the post is going, not about which file it is, and
					    two rows would let the two disagree. */}
					<div className="flex flex-wrap justify-center gap-1.5">
						{PASS_FORMATS.map((option) => (
							<button
								className={cn(
									"rounded-full border px-3 py-1 font-medium text-xs transition-colors",
									option.id === formatId
										? "border-transparent bg-foreground text-background"
										: "border-border text-muted-foreground hover:text-foreground"
								)}
								disabled={busy}
								key={option.id}
								onClick={() => setFormatId(option.id)}
								title={option.label}
								type="button"
							>
								{option.ratio}
							</button>
						))}
					</div>

					{/* The studio is mounted ONCE, outside the panels. Both tabs are the
					    same scene — moving it inside a panel would tear down the shader
					    hosts on every tab change and re-warm the metal ring from black. */}
					<PassStudio
						{...studio}
						formatId={formatId}
						// The still tab holds the exact frame it exports. An animated
						// preview beside a one-frame download makes the picture a
						// surprise — you cannot choose an angle you cannot see.
						frame={tab === "image" ? PASS_STILL_TIME : undefined}
						// The preview is page decoration and stops when asked. The
						// exported file is not, and still turns.
						paused={Boolean(reduceMotion) || busy}
						ref={studioRef}
					/>

					<TabsContent value="image">
						<p className="text-center text-muted-foreground text-xs">
							{format.ratio} · {format.label} · {format.width}×{format.height}
						</p>
					</TabsContent>
					<TabsContent value="video">
						<p className="text-center text-muted-foreground text-xs">
							{tl(
								"{ratio} · {label} · a 10-second loop, recorded here. Keep this window in the foreground while it renders.",
								{ label: format.label, ratio: format.ratio }
							)}
						</p>
					</TabsContent>
					<TabsContent value="gif">
						<p className="text-center text-muted-foreground text-xs">
							{tl(
								"{ratio} · a looping GIF that autoplays in Slack, Discord, iMessage and READMEs. Keep this window in the foreground while it renders.",
								{ ratio: format.ratio }
							)}
						</p>
					</TabsContent>
				</Tabs>

				<DialogFooter>
					{tab === "image" ? (
						<Button
							className="w-full sm:w-auto"
							disabled={busy}
							onClick={copyImage}
							size="lg"
							type="button"
							variant="secondary"
						>
							<HugeiconsIcon
								icon={copied ? CheckmarkCircle02Icon : Copy01Icon}
								size={18}
							/>
							{copied ? "Copied" : "Copy image"}
						</Button>
					) : null}
					<Button
						className="w-full sm:w-auto"
						disabled={busy}
						onClick={
							tab === "image" ? downloadImage : () => downloadMotion(tab)
						}
						size="lg"
						type="button"
						variant="secondary"
					>
						<HugeiconsIcon icon={Download04Icon} size={18} />
						{busy && tab !== "image"
							? tl("Exporting {percent}%", {
									percent: Math.round(progress * PERCENT),
								})
							: "Download"}
					</Button>
					<Button
						className="w-full sm:w-auto"
						disabled={busy}
						onClick={onShareOnLinkedIn}
						size="lg"
						type="button"
						variant="secondary"
					>
						Share on
						<SvglIcon
							alt="LinkedIn"
							size={18}
							spec={{ dark: "linkedin_dark", light: "linkedin" }}
						/>
					</Button>
					<Button
						className="w-full sm:w-auto"
						disabled={busy}
						onClick={onShareOnX}
						size="lg"
						type="button"
					>
						Share on
						{/* One white mark in BOTH themes. The button is the primary
						    variant, so its face is brand blue whichever theme is on —
						    the theme-paired spec was flipping in a black glyph on a blue
						    button in dark mode, which is the one place it cannot read. */}
						<SvglIcon alt="X" size={16} spec="x_dark" />
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
