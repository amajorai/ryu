// The contract every legacy tab component implements. Its hosts (the Store and
// Groups surfaces, the Settings overlay) render a tab only while it is shown, so
// an unmounted tab's hooks/keyboard handlers are not running. A tab still receives
// `active` so transient overlays/inputs can re-assert focus and so it can gate its
// own keyboard while a host keeps it mounted but unfocused.

export interface TabProps {
	/** True while this tab is the visible/active one. Gate keyboard on it so the
	 * tab stays correct while its host keeps it mounted but out of focus. */
	active: boolean;
}
