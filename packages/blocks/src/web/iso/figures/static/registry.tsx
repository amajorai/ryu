"use client";

import dynamic from "next/dynamic";
import type { StaticDrawing } from "./static-figure.tsx";
import { StaticFigure } from "./static-figure.tsx";

/*
 * The static product figures, each loaded on demand so a page ships only its
 * own drawing. Names are what product data and `ProductFigure` refer to.
 */

const staticFigure = (
	name: string,
	load: () => Promise<{ drawing: StaticDrawing }>
) =>
	dynamic(() =>
		load().then((module) => {
			function Figure() {
				return <StaticFigure drawing={module.drawing} name={name} />;
			}
			return Figure;
		})
	);

export const STATIC_FIGURES = {
	"aaas-drafting": staticFigure(
		"aaas-drafting",
		() => import("./aaas-drafting.tsx")
	),
	"agent-console": staticFigure(
		"agent-console",
		() => import("./agent-console.tsx")
	),
	"agents-kit": staticFigure("agents-kit", () => import("./agents-kit.tsx")),
	"bot-transfer": staticFigure(
		"bot-transfer",
		() => import("./bot-transfer.tsx")
	),
	"chrome-dock": staticFigure("chrome-dock", () => import("./chrome-dock.tsx")),
	"cli-terminal": staticFigure(
		"cli-terminal",
		() => import("./cli-terminal.tsx")
	),
	"cloud-cabinet": staticFigure(
		"cloud-cabinet",
		() => import("./cloud-cabinet.tsx")
	),
	"compute-meter": staticFigure(
		"compute-meter",
		() => import("./compute-meter.tsx")
	),
	"connect-switchboard": staticFigure(
		"connect-switchboard",
		() => import("./connect-switchboard.tsx")
	),
	"connections-cards": staticFigure(
		"connections-cards",
		() => import("./connections-cards.tsx")
	),
	"desktop-dock": staticFigure(
		"desktop-dock",
		() => import("./desktop-dock.tsx")
	),
	"devices-tray": staticFigure(
		"devices-tray",
		() => import("./devices-tray.tsx")
	),
	"extensions-rack": staticFigure(
		"extensions-rack",
		() => import("./extensions-rack.tsx")
	),
	"hire-toolbox": staticFigure(
		"hire-toolbox",
		() => import("./hire-toolbox.tsx")
	),
	"island-companion": staticFigure(
		"island-companion",
		() => import("./island-companion.tsx")
	),
	"mail-pigeonholes": staticFigure(
		"mail-pigeonholes",
		() => import("./mail-pigeonholes.tsx")
	),
	"marketplace-vending": staticFigure(
		"marketplace-vending",
		() => import("./marketplace-vending.tsx")
	),
	"mcp-strip": staticFigure("mcp-strip", () => import("./mcp-strip.tsx")),
	"messaging-phone": staticFigure(
		"messaging-phone",
		() => import("./messaging-phone.tsx")
	),
	"mobile-charger": staticFigure(
		"mobile-charger",
		() => import("./mobile-charger.tsx")
	),
	"notify-tower": staticFigure(
		"notify-tower",
		() => import("./notify-tower.tsx")
	),
	"os-windows": staticFigure("os-windows", () => import("./os-windows.tsx")),
	"red-team-rig": staticFigure(
		"red-team-rig",
		() => import("./red-team-rig.tsx")
	),
	"sdk-typecase": staticFigure(
		"sdk-typecase",
		() => import("./sdk-typecase.tsx")
	),
	"share-belt": staticFigure("share-belt", () => import("./share-belt.tsx")),
	"sites-plotter": staticFigure(
		"sites-plotter",
		() => import("./sites-plotter.tsx")
	),
	"skills-cartridges": staticFigure(
		"skills-cartridges",
		() => import("./skills-cartridges.tsx")
	),
} as const;
