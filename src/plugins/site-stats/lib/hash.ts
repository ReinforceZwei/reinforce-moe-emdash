import { createHash } from "node:crypto";

/**
 * Visitor identity for one day. Salted and day-keyed, so the key cannot be reversed by
 * brute-forcing IPv4 space and cannot link one person across days. Never stored with the IP.
 */
export function visitorKey(salt: string, day: string, ip: string, ua: string): string {
	return createHash("sha256").update(`${salt}|${day}|${ip}|${ua}`).digest("hex").slice(0, 24);
}
