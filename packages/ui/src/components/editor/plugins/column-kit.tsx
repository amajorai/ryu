"use client";

import { ColumnItemPlugin, ColumnPlugin } from "@platejs/layout/react";

import {
	ColumnElement,
	ColumnGroupElement,
} from "@ryu/ui/components/editor/ui/column-node.tsx";

export const ColumnKit = [
	ColumnPlugin.withComponent(ColumnGroupElement),
	ColumnItemPlugin.withComponent(ColumnElement),
];
