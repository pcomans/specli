import { describe, expect, test } from "bun:test";

import { loadSpec, type SpecFs } from "./loader.js";

const minimalSpec = JSON.stringify({
	openapi: "3.0.0",
	info: { title: "Test API", version: "1.0.0" },
	paths: {
		"/users": {
			get: {
				operationId: "listUsers",
				responses: { "200": { description: "OK" } },
			},
		},
	},
});

const minimalYamlSpec = `
openapi: "3.0.0"
info:
  title: Test API from YAML
  version: "1.0.0"
paths:
  /users:
    get:
      operationId: listUsers
      responses:
        "200":
          description: OK
`;

describe("loadSpec", () => {
	test("loads spec from custom fs (JSON)", async () => {
		let readPath = "";
		const customFs: SpecFs = {
			readFile: async (path) => {
				readPath = path;
				return minimalSpec;
			},
		};

		const loaded = await loadSpec({
			spec: "/path/to/spec.json",
			fs: customFs,
		});

		expect(readPath).toBe("/path/to/spec.json");
		expect(loaded.source).toBe("file");
		expect(loaded.doc.openapi).toBe("3.0.0");
		expect(loaded.doc.info?.title).toBe("Test API");
	});

	test("loads spec from custom fs (YAML)", async () => {
		const customFs: SpecFs = {
			readFile: async () => minimalYamlSpec,
		};

		const loaded = await loadSpec({
			spec: "/path/to/spec.yaml",
			fs: customFs,
		});

		expect(loaded.source).toBe("file");
		expect(loaded.doc.openapi).toBe("3.0.0");
		expect(loaded.doc.info?.title).toBe("Test API from YAML");
	});

	test("does not use custom fs for URLs", async () => {
		let fsCalled = false;
		const customFs: SpecFs = {
			readFile: async () => {
				fsCalled = true;
				return minimalSpec;
			},
		};

		const originalFetch = globalThis.fetch;
		let fetchCount = 0;
		globalThis.fetch = (async () => {
			fetchCount += 1;
			return new Response(minimalSpec, {
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		try {
			const loaded = await loadSpec({
				spec: "https://spec.example/openapi.json",
				fs: customFs,
			});

			expect(fsCalled).toBe(false);
			expect(fetchCount).toBe(1);
			expect(loaded.source).toBe("url");
			expect(loaded.doc.openapi).toBeDefined();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("uses embedded spec text over file path", async () => {
		let fsCalled = false;
		const customFs: SpecFs = {
			readFile: async () => {
				fsCalled = true;
				return "should not be used";
			},
		};

		const loaded = await loadSpec({
			spec: "/path/to/spec.json",
			embeddedSpecText: minimalSpec,
			fs: customFs,
		});

		expect(fsCalled).toBe(false);
		expect(loaded.source).toBe("embedded");
		expect(loaded.doc.info?.title).toBe("Test API");
	});

	test("custom fs errors are propagated", async () => {
		const customFs: SpecFs = {
			readFile: async () => {
				throw new Error("File not found: /nonexistent.json");
			},
		};

		await expect(
			loadSpec({
				spec: "/nonexistent.json",
				fs: customFs,
			}),
		).rejects.toThrow("File not found: /nonexistent.json");
	});

	test("rejects Swagger 2 at the shared resolution boundary", async () => {
		await expect(
			loadSpec({
				embeddedSpecText: JSON.stringify({
					swagger: "2.0",
					info: { title: "Legacy", version: "1.0.0" },
					paths: {},
				}),
			}),
		).rejects.toThrow("not a valid OpenAPI 3 document");
	});

	test("generates consistent spec ID from custom fs", async () => {
		const customFs: SpecFs = {
			readFile: async () => minimalSpec,
		};

		const loaded1 = await loadSpec({ spec: "/a.json", fs: customFs });
		const loaded2 = await loadSpec({ spec: "/b.json", fs: customFs });

		// Same content should produce same fingerprint and ID
		expect(loaded1.fingerprint).toBe(loaded2.fingerprint);
		expect(loaded1.id).toBe(loaded2.id);
	});
});
