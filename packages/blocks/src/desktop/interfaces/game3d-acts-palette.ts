/**
 * Scene colours of the act layer's kit props (game3d-meters, -alarm,
 * -signs, -apprentice, and the act items carried in game3d-life.tsx). The
 * one place their literal colours live; games may pass a `skin` to tint
 * them toward their own palette.
 */
export const ACT_ART = {
	/** Alarm lantern glass, lit (red: error, billing; amber: limited). */
	alarmAmber: "#ffb43a",
	alarmRed: "#ff4a3d",
	/** An unlit, older failure. */
	alarmDim: "#7b6f6a",
	alarmMetal: "#4a4f5c",
	/** The interrupted flag. */
	flagGrey: "#b9bec7",
	/** The schedule-failed calendar tag and its cross. */
	calendar: "#fff6e0",
	calendarCross: "#d9483b",
	/** Wait bands, as timer fill colours. */
	bandFresh: "#7cc6ff",
	bandWaiting: "#ffd24a",
	bandLong: "#ff9a2e",
	bandStale: "#c46f6f",
	bandExpiring: "#ff4a3d",
	bandUnknown: "#c9ccd3",
	/** Timer glass and frame. */
	timerGlass: "#eaf6ff",
	timerFrame: "#a8743f",
	/** A candle timer's wax and wick (WaitTimer3D shape "candle"). */
	candleWax: "#fbf3df",
	candleWick: "#3b2f2a",
	/** Progress pips: done, to do, estimate (hatched). */
	pipDone: "#5fcf6a",
	pipTodo: "#e6e0d3",
	pipEstimate: "#9fd8a6",
	/** Run cues: the "longer than usual" ring and the stalled hourglass. */
	cueAmber: "#ffb43a",
	cueStalled: "#9aa3b2",
	/** Signs, posts and notes. */
	board: "#3f5a46",
	boardChalk: "#f4f1e8",
	post: "#a8743f",
	note: "#fff2a8",
	notePin: "#d9483b",
	/** Ask letters: a destructive choice gets the red seal. */
	letter: "#fff6e0",
	sealRed: "#d9483b",
	sealAmber: "#f2a33a",
	/** Count stickers and the unread envelope. */
	sticker: "#ff6b5a",
	envelope: "#fffaf0",
	glow: "#fff2a8",
	tabletScreen: "#8fd3ff",
	tray: "#c99a62",
} as const;
