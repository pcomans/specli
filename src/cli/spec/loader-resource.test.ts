import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("shared DAG completes in an isolated 128 MiB Node process", async () => {
	const temp = await mkdtemp(path.join(os.tmpdir(), "specli-dag-"));
	const entry = path.join(temp, "probe.ts");
	const bundlePath = path.join(temp, "probe.mjs");
	const loaderPath = path.resolve("src/cli/spec/loader.ts");
	const resolvedBundlePath = path.resolve("src/cli/spec/resolved-bundle.ts");
	const source = `
import { pathToFileURL } from "node:url";
import { loadSpec } from ${JSON.stringify(loaderPath)};
import { parserChildFilePath } from ${JSON.stringify(resolvedBundlePath)};

const schemas = { Level0: { type: "string" } };
for (let level = 1; level <= 35; level += 1) {
  schemas[\`Level\${level}\`] = {
    type: "object",
    properties: {
      left: { $ref: \`#/components/schemas/Level\${level - 1}\` },
      right: { $ref: \`#/components/schemas/Level\${level - 1}\` },
    },
  };
}
const spec = {
  openapi: "3.1.0",
  info: { title: "DAG API", version: "1.0.0" },
  paths: {
    "/dag": {
      get: {
        operationId: "getDag",
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Level35" },
              },
            },
          },
        },
      },
    },
  },
  components: { schemas },
};
const loaded = await loadSpec({ embeddedSpecText: JSON.stringify(spec) });
const repeated = await loadSpec({ embeddedSpecText: JSON.stringify(spec) });
const structuralFileUrlsPreserved = [
  parserChildFilePath("file:///virtual/question%3Fchild.json"),
  parserChildFilePath("file:///virtual/slash%2Fchild.json"),
].every((value, index) => value.replaceAll("\\\\", "/").endsWith(
  index === 0 ? "/question%3Fchild.json" : "/slash%2Fchild.json",
));
const nativeRootResults = [];
for (const rootPath of [
  "/virtual/root%23.json",
  "/virtual/root%20.json",
  "/virtual/root%ZZ.json",
  "/virtual/root% value.json",
  "/virtual/root space.json",
  "/virtual/racine café 文档.json",
]) {
  const rootText = JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Native Root API", version: "1.0.0" },
    paths: {},
  });
  for (const rootSource of [rootPath, pathToFileURL(rootPath).href]) {
    const reads = [];
    const rootLoaded = await loadSpec({
      spec: rootSource,
      fs: {
        async readFile(filePath) {
          reads.push(filePath);
          if (filePath !== rootPath) throw new Error(\`wrong root: \${filePath}\`);
          return rootText;
        },
      },
    });
    nativeRootResults.push({ expected: rootPath, reads, id: rootLoaded.id });
  }
}
let malformedRootRejected = false;
let malformedRootReads = 0;
try {
  await loadSpec({
    spec: "file:///virtual/root%ZZ.json",
    fs: { async readFile() { malformedRootReads += 1; return ""; } },
  });
} catch {
  malformedRootRejected = true;
}
const malformedChildReads = [];
let malformedChildRejected = false;
try {
  await loadSpec({
    spec: "/virtual/root.json",
    fs: {
      async readFile(filePath) {
        malformedChildReads.push(filePath);
        return JSON.stringify({
          openapi: "3.1.0",
          info: { title: "Malformed URL API", version: "1.0.0" },
          paths: {},
          components: {
            schemas: { Thing: { $ref: "file:///virtual/bad%ZZ.json#/Thing" } },
          },
        });
      },
    },
  });
} catch {
  malformedChildRejected = true;
}
process.stdout.write(JSON.stringify({
  id: loaded.id,
  fingerprint: loaded.fingerprint,
  repeatedFingerprint: repeated.fingerprint,
  structuralFileUrlsPreserved,
  nativeRootResults,
  malformedRootRejected,
  malformedRootReads,
  malformedChildRejected,
  malformedChildReads: malformedChildReads.length,
}));
`;

	try {
		await writeFile(entry, source);
		const result = await Bun.build({
			entrypoints: [entry],
			target: "node",
		});
		expect(result.success).toBe(true);
		expect(result.outputs).toHaveLength(1);
		const buildOutput = result.outputs[0];
		if (!buildOutput)
			throw new Error("Bun.build did not produce the probe bundle");
		await writeFile(
			bundlePath,
			new Uint8Array(await buildOutput.arrayBuffer()),
		);

		const child = Bun.spawn({
			cmd: ["node", "--max-old-space-size=128", bundlePath],
			stdout: "pipe",
			stderr: "pipe",
		});
		const timeout = setTimeout(() => child.kill(), 10_000);
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		clearTimeout(timeout);

		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
		const probeOutput = JSON.parse(stdout) as {
			id: string;
			fingerprint: string;
			repeatedFingerprint: string;
			structuralFileUrlsPreserved: boolean;
			nativeRootResults: Array<{
				expected: string;
				reads: string[];
				id: string;
			}>;
			malformedRootRejected: boolean;
			malformedRootReads: number;
			malformedChildRejected: boolean;
			malformedChildReads: number;
		};
		expect(probeOutput.id).toBe("dag-api");
		expect(probeOutput.fingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(probeOutput.repeatedFingerprint).toBe(probeOutput.fingerprint);
		expect(probeOutput.structuralFileUrlsPreserved).toBe(true);
		expect(probeOutput.nativeRootResults).toHaveLength(12);
		for (const result of probeOutput.nativeRootResults) {
			expect(result.reads).toEqual([result.expected]);
			expect(result.id).toBe("native-root-api");
		}
		expect(probeOutput.malformedRootRejected).toBe(true);
		expect(probeOutput.malformedRootReads).toBe(0);
		expect(probeOutput.malformedChildRejected).toBe(true);
		expect(probeOutput.malformedChildReads).toBe(1);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
}, 20_000);
