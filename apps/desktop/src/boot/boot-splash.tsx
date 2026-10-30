import { Logo } from "@ryu/ui/components/logo.tsx";

/**
 * The one startup placeholder: a static 32px mark, centred, inside a drag
 * region. Every gate in the startup chain (startup choice, session, waitlist,
 * MFA, node setup) and every lazily loaded screen falls back to it, so a cold
 * start shows one calm mark instead of a different animated orb per gate.
 */
export function BootSplash() {
	return (
		<div
			className="flex size-full items-center justify-center"
			data-slot="boot-splash"
			data-tauri-drag-region
		>
			<Logo size="32px" variant="outline-static" />
		</div>
	);
}
