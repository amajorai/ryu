export interface ColorTheme {
	dark: {
		primary: string;
	};
	label: string;
	light: {
		primary: string;
	};
	name: string;
}

export const colorThemes: ColorTheme[] = [
	{
		name: "default",
		label: "Default",
		light: {
			primary: "0.2088 0.0429 0.5296",
		},
		dark: {
			primary: "0.2088 0.0429 0.5296",
		},
	},
	{
		name: "blue",
		label: "Blue",
		light: {
			primary: "221.2 91.2% 52.5%",
		},
		dark: {
			primary: "221.2 91.2% 52.5%",
		},
	},
	{
		name: "red",
		label: "Red",
		light: {
			primary: "0 72.2% 50.6%",
		},
		dark: {
			primary: "0 72.2% 50.6%",
		},
	},
	{
		name: "green",
		label: "Green",
		light: {
			primary: "142.1 76.2% 36.3%",
		},
		dark: {
			primary: "142.1 76.2% 36.3%",
		},
	},
	{
		name: "yellow",
		label: "Yellow",
		light: {
			primary: "47.9 95.8% 53.1%",
		},
		dark: {
			primary: "47.9 95.8% 53.1%",
		},
	},
	{
		name: "violet",
		label: "Violet",
		light: {
			primary: "263.4 70% 50.4%",
		},
		dark: {
			primary: "263.4 70% 50.4%",
		},
	},
	{
		name: "rose",
		label: "Rose",
		light: {
			primary: "346.8 77.2% 49.8%",
		},
		dark: {
			primary: "346.8 77.2% 49.8%",
		},
	},
	{
		name: "orange",
		label: "Orange",
		light: {
			primary: "24.6 95% 53.1%",
		},
		dark: {
			primary: "24.6 95% 53.1%",
		},
	},
];
