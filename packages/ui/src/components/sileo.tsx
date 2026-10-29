"use client";

import type { useTheme } from "next-themes";
import type { ComponentProps } from "react";
import { type SileoOptions, Toaster as SileoToaster, sileo } from "sileo";
import {
	isNativeFunction,
	isNativeText,
} from "../lib/native-primitive-observation.ts";
// Installs the ryu slot rules on the shared `sileo` singleton as a side effect.
import {
	DEFAULT_TOASTER_OPTIONS,
	type ToastOptions,
} from "../lib/sileo-setup.ts";
import { TOASTER_SLOT } from "../lib/toast-press.ts";

type NativeSileoToasterProps = ComponentProps<typeof SileoToaster>;
type ToasterProps = Omit<NativeSileoToasterProps, "theme"> & {
	theme?: ReturnType<typeof useTheme>["resolvedTheme"];
};

// The mounted Toaster sets sileo's GLOBAL `store.options` to
// DEFAULT_TOASTER_OPTIONS (lib/sileo-setup.ts explains each value), merged under
// the caller's own `options`.
//
// sileo only mounts its `aria-live` viewport while a toast is showing. A modal
// dialog hides everything outside itself from assistive tech when it opens,
// sparing only the `[aria-live]` regions that exist at that moment — so a toast
// raised from inside an open dialog was born into the hidden subtree and never
// announced. This anchor is always mounted: `aria-live="off"` makes it count as
// a live region for that check without announcing anything itself (sileo's own
// region still does). `z-[60]` lifts toasts above the z-50 modal backdrop (globals.css makes them
// click-through while a modal or popup is open), which
// otherwise dimmed and blurred the very error the dialog had just raised.
const Toaster = ({ options, ...props }: ToasterProps) => {
	return (
		<div
			aria-live="off"
			className="pointer-events-none fixed top-0 left-0 z-[60]"
			data-slot={TOASTER_SLOT}
		>
			<SileoToaster
				options={{ ...DEFAULT_TOASTER_OPTIONS, ...options }}
				// SAFETY: The complete native Sileo props are retained. Its installed
				// runtime accepts NextThemes' full string/undefined theme input: only
				// light/dark bypass matchMedia; all other strings preserve its system
				// fallback, raw truthiness and effect dependency. The declaration's
				// three-literal theme input is narrower; this does not prove membership.
				{...(props as NativeSileoToasterProps)}
			/>
		</div>
	);
};

// sileo's toast API takes an options object; this adapter also accepts a plain
// string (mapped to the `title`) so callers can write `toast.error("...")` like
// sonner. Exposed as `toast` so app code stays toast-library-agnostic.
type ToastInput = string | ToastOptions;

// Callers overwhelmingly write sonner's two-argument form —
// `toast.success("Saved", { description: "…" })` — so the rest object is
// merged over the title here. Without it those calls type-error (70 of them in
// apps/desktop alone) and, worse, the whole second argument was DROPPED at
// runtime: every one of those descriptions silently never rendered.
const asOptions = (input: ToastInput, rest?: ToastOptions): ToastOptions => {
	const base: ToastOptions = isNativeText(input) ? { title: input } : input;
	return rest ? { ...base, ...rest } : base;
};

// sileo's own `promise` helper, exposed with the wrapper's `ToastInput`
// (string-or-options) shape so callers write `loading: "…"` like every other
// helper here. `success`/`error`/`action` accept either a static input or a
// function mapping the settled value/error to the terminal toast.
// Promise rejection values are an opaque argument in the actual public Sileo
// callback protocol. This owner forwards the COMPLETE native argument tuple,
// extending only the adapter's existing string-or-options return domain.
type NativePromiseOptions<T> = Parameters<typeof sileo.promise<T>>[1];
type ToastPromiseErrorHandler<T> = (
	...args: Parameters<Exclude<NativePromiseOptions<T>["error"], SileoOptions>>
) => ToastInput;

function toastPromise<T>(
	promise: Promise<T> | (() => Promise<T>),
	opts: {
		action?: ToastInput | ((data: T) => ToastInput);
		error: ToastInput | ToastPromiseErrorHandler<T>;
		loading: ToastInput;
		success?: ToastInput | ((data: T) => ToastInput);
	}
) {
	return sileo.promise(promise, {
		loading: asOptions(opts.loading),
		// SAFETY: The asserted callback is the callable member of this complete
		// adapter input union, selected at branch time by its native function-brand guard.
		// Its T result input and ToastInput output are the owner's declared ports;
		// this preserves the original deferred property lookup timing.
		success: isNativeFunction(opts.success)
			? (data: T) => asOptions((opts.success as (d: T) => ToastInput)(data))
			: asOptions(opts.success ?? opts.loading),
		// SAFETY: The callable branch retains the complete native Sileo rejection
		// argument tuple through ToastPromiseErrorHandler. It does not decode or
		// narrow the opaque error value, and preserves deferred lookup timing.
		error: isNativeFunction(opts.error)
			? (err) => asOptions((opts.error as ToastPromiseErrorHandler<T>)(err))
			: asOptions(opts.error),
		...(opts.action
			? {
					// SAFETY: This callable member has the same complete declared T input
					// and ToastInput output as the adapter action port. Its existing
					// earlier function guard selects this branch; deferred lookup and any
					// caller mutation/getter behavior stay unchanged.
					action: isNativeFunction(opts.action)
						? (data: T) =>
								asOptions((opts.action as (d: T) => ToastInput)(data))
						: asOptions(opts.action),
				}
			: undefined),
	});
}

const toast = {
	show: (input: ToastInput, rest?: ToastOptions) =>
		sileo.show(asOptions(input, rest)),
	message: (input: ToastInput, rest?: ToastOptions) =>
		sileo.show(asOptions(input, rest)),
	success: (input: ToastInput, rest?: ToastOptions) =>
		sileo.success(asOptions(input, rest)),
	error: (input: ToastInput, rest?: ToastOptions) =>
		sileo.error(asOptions(input, rest)),
	warning: (input: ToastInput, rest?: ToastOptions) =>
		sileo.warning(asOptions(input, rest)),
	info: (input: ToastInput, rest?: ToastOptions) =>
		sileo.info(asOptions(input, rest)),
	dismiss: (id: string) => sileo.dismiss(id),
	promise: toastPromise,
};

export { Toaster, toast };
