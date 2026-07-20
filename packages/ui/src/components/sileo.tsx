"use client";

import type { ComponentProps } from "react";
import { Toaster as SileoToaster, sileo } from "sileo";

type ToasterProps = ComponentProps<typeof SileoToaster>;

const Toaster = ({ ...props }: ToasterProps) => {
	return <SileoToaster {...props} />;
};

// sileo's toast API takes an options object; this adapter also accepts a plain
// string (mapped to the `title`) so callers can write `toast.error("...")` like
// sonner. Exposed as `toast` so app code stays toast-library-agnostic.
type ToastInput = string | Parameters<typeof sileo.show>[0];

const normalize = (input: ToastInput) =>
	typeof input === "string" ? { title: input } : input;

const toast = {
	show: (input: ToastInput) => sileo.show(normalize(input)),
	message: (input: ToastInput) => sileo.show(normalize(input)),
	success: (input: ToastInput) => sileo.success(normalize(input)),
	error: (input: ToastInput) => sileo.error(normalize(input)),
	warning: (input: ToastInput) => sileo.warning(normalize(input)),
	info: (input: ToastInput) => sileo.info(normalize(input)),
	dismiss: sileo.dismiss,
};

export { Toaster, toast };
