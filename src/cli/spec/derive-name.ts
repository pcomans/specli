const RESERVED_NAMES = [
	"exec",
	"compile",
	"profile",
	"auth",
	"help",
	"version",
];

/**
 * Derives a clean binary name from an already resolved OpenAPI spec.
 * Priority:
 *   1. info.title (kebab-cased, sanitized)
 *   2. Host from spec URL (if URL provided)
 *   3. Fallback to "specli"
 */
export function deriveBinaryName(options: {
	title?: string;
	source: string;
}): string {
	if (typeof options.title === "string" && options.title) {
		const name = sanitizeName(options.title);
		if (name) return name;
	}

	// Try to derive from URL host
	if (/^https?:\/\//i.test(options.source)) {
		try {
			const url = new URL(options.source);
			const hostParts = url.hostname.split(".");
			// Use first meaningful segment (skip www, api prefixes)
			const meaningful = hostParts.find(
				(p) => p !== "www" && p !== "api" && p.length > 2,
			);
			if (meaningful) {
				const name = sanitizeName(meaningful);
				if (name) return name;
			}
		} catch {
			// Invalid URL, fall through
		}
	}

	// Fallback
	return "specli";
}

/**
 * Convert title to valid binary name:
 * - kebab-case
 * - lowercase
 * - remove invalid chars
 * - max 32 chars
 * - avoid reserved names
 */
function sanitizeName(input: string): string {
	let name = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-") // Replace non-alphanumeric with dash
		.replace(/^-+|-+$/g, "") // Trim leading/trailing dashes
		.slice(0, 32); // Limit length

	if (RESERVED_NAMES.includes(name)) {
		name = `${name}-cli`;
	}

	return name;
}
