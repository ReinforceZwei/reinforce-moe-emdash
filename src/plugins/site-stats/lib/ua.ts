import Bowser from "bowser";

export interface UaInfo {
	browser: string;
	os: string;
	device: "desktop" | "mobile" | "tablet" | "other";
}

export function parseUa(ua: string): UaInfo {
	const r = Bowser.parse(ua);
	const type = r.platform.type;
	return {
		browser: r.browser.name || "Other",
		os: r.os.name || "Other",
		device: type === "desktop" || type === "mobile" || type === "tablet" ? type : "other",
	};
}
