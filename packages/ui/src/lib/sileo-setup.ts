import { type SileoOptions, sileo } from "sileo";

// The ryu rules for sileo's shared singleton: default toast timing, and the slot
// ids that keep toasts from replacing each other. They are a side effect of
// loading this module, kept apart from the Toaster so any entry point can
// install them (`components/sileo.tsx` imports it, so every app that mounts the
// shared Toaster gets them).

// sileo clamps `autopilot.collapse` to the toast's own duration, so asking for an
// absurdly large collapse delay means "stay expanded until the toast exits" for
// ANY duration a caller passes.
const COLLAPSE_AT_END_OF_LIFE = Number.MAX_SAFE_INTEGER;

// The mounted Toaster sets sileo's GLOBAL `store.options`, which every toast
// merges over — including the ~40 call sites that import `sileo` directly and
// bypass the `toast` wrapper in components/sileo.tsx. So this is the one place
// we can force sane timing for ALL toasts at once:
//   - `duration: 6000` — a readable 6s lifetime.
//   - `autopilot` — sileo's default collapses the toast 2s BEFORE it is
//     dismissed, which reads as if it vanished early. We keep auto-expand (it is
//     the only thing that reveals a toast's `description` without a hover) but
//     push the collapse to the end of life, so a toast stays open the whole time
//     it is on screen. Turning autopilot off entirely — the previous fix — hid
//     every description behind a hover.
// Caller-supplied `options` still win via the spread.
//
// Deliberately NO `fill` override: sileo pairs its default fills with its own
// per-theme text colors (dark mode = light `#f2f2f2` surface + black text, light
// mode = dark `#1a1a1a` surface + white text). Overriding `fill` to `--muted`
// used to break that pairing — black text on a dark surface — and cost a
// dependency patch + a CSS cascade fight to undo. Leave the fill alone.
export const DEFAULT_TOASTER_OPTIONS = {
	autopilot: { collapse: COLLAPSE_AT_END_OF_LIFE, expand: 150 },
	duration: 6000,
	styles: { title: "ryu-sileo-title" },
} as const;

// `SileoOptions` omits `id`, but the runtime reads it (`merged.id ?? "sileo-default"`)
// and it is the only handle on which slot a toast lands in, so we type it here.
export type ToastOptions = SileoOptions & { id?: string };
type RawToast = (opts: SileoOptions) => string;

// sileo defaults every id-less toast to the shared id "sileo-default", so two
// toasts fired in succession collapse into one slot — the second REPLACES the
// first, which is why a toast could flash for a moment and vanish before it was
// readable. We give each toast a CONTENT-derived id instead, which fixes both
// failure modes:
//   - distinct messages get distinct ids, so they stack instead of stomping;
//   - a component that re-fires the SAME message in a render/effect loop reuses
//     one slot (sileo replaces it in place, restarting its full duration)
//     instead of spawning a flickering pile.
const toastContentId = (base: ToastOptions) => {
	const key = `${base.title ?? ""} ${base.description ?? ""}`;
	// Cheap stable hash so the id is a short, DOM-safe string.
	let hash = 0;
	for (let i = 0; i < key.length; i += 1) {
		hash = (hash * 31 + key.charCodeAt(i)) | 0;
	}
	return `ryu-toast-${(hash >>> 0).toString(36)}`;
};

// ...but content ids alone are WRONG for progress toasts. Auth flows fire a chain
// of `{ type: "loading", duration: null }` toasts ("Verifying captcha..." →
// "Signing in...") and then a terminal `success`/`error`, and they never dismiss
// anything: they rely on every step landing in ONE slot so each step replaces the
// previous and the terminal toast (which has a real duration) retires it. Give
// those steps content ids and each becomes its own never-expiring toast — the
// stack of stuck spinners on the web login. So progress toasts share a single
// slot, and the next terminal toast takes that slot over, exactly as the flows
// (and sileo's own `promise` helper) assume.
const PROGRESS_ID = "ryu-toast-progress";
let progressSlotLive = false;

const withSlotId = (base: ToastOptions, isProgress: boolean): ToastOptions => {
	// The caller named the slot (e.g. to update one specific toast) — respect it.
	if (base.id !== undefined) {
		return base;
	}
	if (isProgress) {
		progressSlotLive = true;
		return { ...base, id: PROGRESS_ID };
	}
	// Terminal toast while a progress toast is on screen: replace it in place.
	if (progressSlotLive) {
		progressSlotLive = false;
		return { ...base, id: PROGRESS_ID };
	}
	return { ...base, id: toastContentId(base) };
};

// ~40 call sites import `sileo` directly from "sileo" and never pass an id, so
// they all share the lib's "sileo-default" slot. That shared slot is why "press
// Update and nothing happens": a flow that shows a progress toast, dismisses it,
// and immediately fires an error toast reuses ONE id — the dismiss races the new
// toast and swallows it. Patching the shared instance here (this module is
// loaded once, with the mounted Toaster) gives every direct caller the same slot
// rules as the `toast` wrapper in components/sileo.tsx, without touching 40
// files.
type PatchedSileo = typeof sileo & { __ryuSlotsPatched?: true };
const patchTarget: PatchedSileo = sileo;

if (!patchTarget.__ryuSlotsPatched) {
	const raw = {
		show: sileo.show,
		success: sileo.success,
		error: sileo.error,
		warning: sileo.warning,
		info: sileo.info,
		action: sileo.action,
		dismiss: sileo.dismiss,
		clear: sileo.clear,
	} as const;

	const route = (fn: RawToast, opts: ToastOptions, isProgress: boolean) =>
		fn(withSlotId(opts, isProgress));

	// `show` is the only entry point that can carry `type: "loading"`; the typed
	// helpers below always describe a terminal state.
	sileo.show = (opts) => route(raw.show, opts, opts.type === "loading");
	sileo.success = (opts) => route(raw.success, opts, false);
	sileo.error = (opts) => route(raw.error, opts, false);
	sileo.warning = (opts) => route(raw.warning, opts, false);
	sileo.info = (opts) => route(raw.info, opts, false);
	sileo.action = (opts) => route(raw.action, opts, false);
	sileo.dismiss = (id) => {
		if (id === PROGRESS_ID) {
			progressSlotLive = false;
		}
		raw.dismiss(id);
	};
	sileo.clear = (position) => {
		progressSlotLive = false;
		raw.clear(position);
	};

	patchTarget.__ryuSlotsPatched = true;
}
