import { describe, expect, test } from "bun:test";

import { deriveBinaryName } from "./derive-name.js";

describe("deriveBinaryName", () => {
	test("uses the resolved title without acquiring the source", () => {
		expect(
			deriveBinaryName({
				title: "Resolved Customer API",
				source: "https://ignored.example/openapi.json",
			}),
		).toBe("resolved-customer-api");
	});

	test("preserves reserved-name suffixing and the 32-character limit", () => {
		expect(deriveBinaryName({ title: "compile", source: "local.json" })).toBe(
			"compile-cli",
		);
		expect(
			deriveBinaryName({
				title: "abcdefghijklmnopqrstuvwxyz0123456789",
				source: "local.json",
			}),
		).toBe("abcdefghijklmnopqrstuvwxyz012345");
	});

	test("falls back to a meaningful URL hostname segment", () => {
		expect(
			deriveBinaryName({
				source: "https://api.example.com/openapi.json",
			}),
		).toBe("example");
	});

	test("falls back to specli for a local source without a title", () => {
		expect(deriveBinaryName({ source: "openapi.json" })).toBe("specli");
	});
});
