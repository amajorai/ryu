"use client";

// The shell's own "open this link?" prompt for `ui.openExternal`.
//
// An app frame can ask the shell to open an address in the person's browser
// without holding any grant. The shell asks the person first, here: the prompt
// is drawn by the HOST document, outside the sandboxed frame, so the app can
// neither style it nor click it. The address shown is built from the vetted
// URL (see `@ryu/app-host/open-external-gate`), never from text of the app,
// and its host name is shown whole.

import {
	createOpenExternalAsk,
	type ExternalDestination,
	type OpenExternalAsk,
	promptAppName,
} from "@ryu/app-host/open-external-gate";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog.tsx";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

/** The address line of the prompt: scheme, the whole host name, then the
 *  shortened rest. It wraps (`break-all`) instead of cutting, so a long
 *  lookalike host is readable to its last label. */
export function OpenExternalDestinationText({
	destination,
}: {
	destination: ExternalDestination;
}) {
	return (
		<p
			className="select-text break-all rounded-md border bg-muted/40 p-2 font-mono text-sm"
			data-testid="open-external-destination"
			dir="ltr"
		>
			<span className="text-muted-foreground">{`${destination.scheme}://`}</span>
			<strong className="font-semibold" data-testid="open-external-host">
				{destination.host}
			</strong>
			<span className="text-muted-foreground">{destination.rest}</span>
		</p>
	);
}

/** Tells the hook whether its dialog is in the tree. The shell renders the
 *  dialog beside the frame, so when the frame goes (the panel unmounts, the
 *  widget closes) this goes with it and the open prompt is answered no. */
function PromptPresence({
	onChange,
}: {
	onChange: (present: boolean) => void;
}) {
	useEffect(() => {
		onChange(true);
		return () => onChange(false);
	}, [onChange]);
	return null;
}

/**
 * One prompt per app frame mount. `ask` is the gate's asking half (rate limit
 * and one prompt at a time included) and never changes identity; `dialog` goes
 * into the HOST's tree beside the frame. Cancel, a closed dialog and a dialog
 * that leaves the tree all answer no, and so does a call made while the dialog
 * is not in the tree.
 */
export function useOpenExternalAsk(appName: string): {
	ask: OpenExternalAsk;
	dialog: ReactNode;
} {
	const tl = useLiteralMessages();
	const [destination, setDestination] = useState<ExternalDestination | null>(
		null
	);
	const [open, setOpen] = useState(false);
	const pending = useRef<((accepted: boolean) => void) | null>(null);

	const finish = useCallback((accepted: boolean) => {
		const resolve = pending.current;
		pending.current = null;
		setOpen(false);
		resolve?.(accepted);
	}, []);
	const present = useRef(false);
	const onPresence = useCallback((next: boolean) => {
		present.current = next;
		if (!next) {
			pending.current?.(false);
			pending.current = null;
			setOpen(false);
		}
	}, []);

	const ask = useMemo(
		() =>
			createOpenExternalAsk({
				confirm: (next) =>
					new Promise<boolean>((resolve) => {
						if (!present.current) {
							resolve(false);
							return;
						}
						pending.current?.(false);
						pending.current = resolve;
						setDestination(next);
						setOpen(true);
					}),
			}),
		[]
	);

	const dialog = (
		<>
			<PromptPresence onChange={onPresence} />
			<AlertDialog
				onOpenChange={(next) => {
					if (!next) {
						finish(false);
					}
				}}
				open={open}
			>
				{/* Above a fullscreen or picture-in-picture widget (z-[100]). */}
				<AlertDialogContent
					className="z-[120]"
					data-testid="open-external-confirm"
				>
					<AlertDialogHeader>
						<AlertDialogTitle>{tl("Open external link?")}</AlertDialogTitle>
						<AlertDialogDescription>
							{/* An element, not a string: the description localizes string
							    children by lookup, and the app's name must not go through one. */}
							<span>
								{tl(
									"“{appName}” wants to open this address in your browser. Check the address before you continue.",
									{ appName: promptAppName(appName) }
								)}
							</span>
						</AlertDialogDescription>
					</AlertDialogHeader>
					{destination ? (
						<OpenExternalDestinationText destination={destination} />
					) : null}
					<AlertDialogFooter>
						{/* Cancel comes first in the tab order. */}
						<AlertDialogCancel
							data-testid="open-external-cancel"
							onClick={() => finish(false)}
						>
							{tl("Cancel")}
						</AlertDialogCancel>
						<AlertDialogAction
							data-testid="open-external-accept"
							onClick={() => finish(true)}
						>
							{tl("Open link")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
	return { ask, dialog };
}
