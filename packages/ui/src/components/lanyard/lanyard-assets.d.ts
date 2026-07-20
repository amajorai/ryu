// Ambient asset-module declarations. This file MUST stay a global script (no
// top-level import/export) — wildcard `declare module "*.ext"` only registers a
// global ambient module from a script file; inside a module file it is read as
// an augmentation of a (non-existent) module and ignored.
declare module "*.glb" {
	const src: string;
	export default src;
}

declare module "*.png" {
	const src: string;
	export default src;
}
