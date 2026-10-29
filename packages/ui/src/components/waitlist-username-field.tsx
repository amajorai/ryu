"use client";

import { Edit03Icon, SeatSelectorIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useId, useState } from "react";
import { cn } from "../lib/utils.ts";
import { Button } from "./button.tsx";
import { METAL_EDGE_TILE_RING_PX, MetalEdge } from "./metal-edge.tsx";

/**
 * "Reserve your handle" field for the waitlist screens. Presentational only —
 * it owns no auth: the web and desktop screens each hold their own Better Auth
 * client (`authClient.isUsernameAvailable` + `authClient.updateUser`) and pass
 * the result in, because those two clients are configured differently (cookie
 * vs. bearer) and neither belongs in the shared UI package.
 *
 * Once reserved the field collapses to a confirmation line, with a "Change
 * handle" action that puts the input back. It does NOT stay permanently
 * collapsed: a handle claimed in a hurry is exactly the kind of thing people
 * want to correct, and the claim is reversible on the server anyway
 * (`updateUser` just writes the new one).
 */

/** Same shape Better Auth's username plugin enforces (3-32, word chars). */
export const WAITLIST_USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;
/**
 * The field's corner radius (Tailwind `rounded-3xl`) in the CSS px `metal-fx`
 * wants it in, and the fill's radius inside the ring's gutter.
 */
const FIELD_RADIUS_PX = 24;
const USERNAME_MAX_LENGTH = 32;
const LEADING_AT = /^@+/;

/** Strip a typed "@", lowercase, and trim to the shape the server accepts. */
export const normalizeWaitlistUsername = (raw: string): string =>
	raw
		.trim()
		.replace(LEADING_AT, "")
		.toLowerCase()
		.slice(0, USERNAME_MAX_LENGTH);

export interface WaitlistUsernameFieldProps {
	className?: string;
	/** Inline error from the last attempt (taken, invalid, network). */
	error?: string | null;
	onChange: (value: string) => void;
	onSubmit: () => void;
	/**
	 * Release the reserved handle. Optional: the desktop screen does not offer it,
	 * and without it the reserved state shows only "Change handle".
	 */
	onUnreserve?: () => void;
	/** In flight: checking availability and claiming. */
	pending?: boolean;
	/** Already reserved — renders the confirmation instead of the input. */
	reserved?: string | null;
	value: string;
}

export function WaitlistUsernameField({
	className,
	error,
	onChange,
	onSubmit,
	onUnreserve,
	pending = false,
	reserved,
	value,
}: WaitlistUsernameFieldProps) {
	const inputId = useId();
	const errorId = useId();
	const normalized = normalizeWaitlistUsername(value);
	const valid = WAITLIST_USERNAME_RE.test(normalized);
	const [editing, setEditing] = useState(false);

	// What closes the editor after a submit. `reserved` changing is the obvious
	// signal, but it is not sufficient: re-confirming the handle you already have
	// is a legitimate submit that leaves `reserved` untouched, and watching only
	// that left the editor open forever. So the close is driven off the request
	// finishing without an error instead, with the `reserved` watch kept for the
	// case where the parent swaps the handle out from under us.
	const [lastReserved, setLastReserved] = useState(reserved);
	if (reserved !== lastReserved) {
		setLastReserved(reserved);
		setEditing(false);
	}
	const [wasPending, setWasPending] = useState(pending);
	if (pending !== wasPending) {
		setWasPending(pending);
		if (wasPending && !(pending || error)) {
			setEditing(false);
		}
	}

	if (reserved && !editing) {
		// No heading here: the screen's own PageHeader already says which handle is
		// reserved, and a second title inside the field stacked two headlines down
		// the column. This state is just the two things you can do about it.
		return (
			<div className={cn("flex flex-col gap-2", className)}>
				<div className="flex flex-col gap-2 sm:flex-row">
					<Button
						className="flex-1"
						onClick={() => {
							// Prefill with the current handle so "change" starts from what they
							// have rather than from an empty field.
							onChange(reserved);
							setEditing(true);
						}}
						size="lg"
						type="button"
						variant="secondary"
					>
						<HugeiconsIcon icon={Edit03Icon} size={18} />
						Change handle
					</Button>
					{onUnreserve ? (
						<Button
							className="flex-1"
							loading={pending}
							onClick={onUnreserve}
							size="lg"
							type="button"
							variant="destructive"
						>
							{pending ? (
								"Releasing"
							) : (
								<>
									<HugeiconsIcon icon={SeatSelectorIcon} size={18} />
									Unreserve
								</>
							)}
						</Button>
					) : null}
				</div>
				{error ? (
					<p
						className="text-status-destructive text-xs"
						id={errorId}
						role="alert"
					>
						{error}
					</p>
				) : null}
			</div>
		);
	}

	return (
		<form
			className={cn("flex flex-col gap-2", className)}
			onSubmit={(event) => {
				event.preventDefault();
				if (!(pending || !valid)) {
					onSubmit();
				}
			}}
		>
			{/* No visible label: the step's own heading already says "Reserve your
			    handle" directly above this field, and a second instruction under it
			    was the same sentence twice. Screen readers still get one. */}
			<label className="sr-only" htmlFor={inputId}>
				Reserve your handle
			</label>
			{/* Stacked, not side by side. This column is `max-w-sm`, and in a row the
			    Reserve button left the field about sixty pixels wide — too little to
			    read the handle you are typing. */}
			<div className="flex flex-col gap-2">
				{/* The "@" is a prefix inside the control, not part of the value, so a
				    user who types it anyway is normalized rather than rejected. */}
				{/* Same field shape as the sign-in form's inputs — `h-16 border-0
				    bg-muted` — so arriving from login doesn't feel like a different
				    product. The radius follows `Input`'s `rounded-3xl` for the same
				    reason. */}
				{/* The same metal edge the pass and the invite row wear, so the one
				    field on this screen that decides your handle reads as part of the
				    same object rather than as a plain form control beside it. The fill
				    sits inside the ring's own gutter (see `MetalEdge`) and is rounded by
				    the outer radius less the ring, or the band thins at the corners. */}
				{/* The flex item is this wrapper, not the ring: `metal-fx`'s root is
				    `display: inline-flex`, so it sizes to its content and its own
				    `w-full` has nothing to resolve against until a flexed parent gives
				    it a width. Without this the field collapsed to about 60px. */}
				<div className="min-w-0 flex-1">
					<MetalEdge
						borderRadius={FIELD_RADIUS_PX}
						ringPx={METAL_EDGE_TILE_RING_PX}
						small
					>
						<div
							// `w-full`, not `flex-1`: the parent is now the ring's own column
							// gutter, so a flex-grow here grows nothing and the field collapsed
							// to its content width.
							className="flex h-16 w-full min-w-0 items-center rounded-[23px] border-0 bg-muted px-4 focus-within:ring-3 focus-within:ring-ring"
						>
							<span
								aria-hidden="true"
								className="text-muted-foreground text-sm"
							>
								@
							</span>
							<input
								aria-describedby={error ? errorId : undefined}
								aria-invalid={Boolean(error)}
								autoCapitalize="none"
								autoComplete="off"
								autoCorrect="off"
								className="min-w-0 flex-1 bg-transparent px-1 text-base outline-none placeholder:text-muted-foreground"
								id={inputId}
								maxLength={USERNAME_MAX_LENGTH}
								onChange={(event) => onChange(event.target.value)}
								placeholder="yourname"
								spellCheck={false}
								value={value}
							/>
						</div>
					</MetalEdge>
				</div>
				{/* `h-16` to match the field beside it — `size="lg"` is h-14, which
					    left the pair a notch out of alignment. */}
				<Button
					className="h-16 w-full"
					disabled={!valid}
					loading={pending}
					size="lg"
					type="submit"
				>
					{pending ? (
						"Reserving"
					) : (
						<>
							<HugeiconsIcon icon={SeatSelectorIcon} size={18} />
							Reserve
						</>
					)}
				</Button>
			</div>
			{error ? (
				<p className="text-status-destructive text-xs" id={errorId}>
					{error}
				</p>
			) : (
				<p className="text-muted-foreground text-xs">
					3–32 letters, numbers or underscores.
				</p>
			)}
		</form>
	);
}
