import path from "node:path";
import { fileURLToPath } from "node:url";

import SwaggerParser from "@apidevtools/swagger-parser";
import type { OpenAPI } from "openapi-types";

import { sha256Hex } from "../core/crypto.js";
import { stableStringify } from "../core/stable-json.js";
import type { SpecSource } from "../core/types.js";
import { parseYamlContent, readFileText } from "../runtime/compat.js";

const EMBEDDED_BASE = "specli://embedded/openapi.json";
const REF_PARSER_FILENAME_ESCAPE = /%(?:23|24|26|2C|40)/g;

/** Custom filesystem interface for reading specification files. */
export type SpecFs = {
	readFile: (path: string) => Promise<string>;
};

export type ResolveSpecBundleOptions = {
	spec?: string;
	embeddedSpecText?: string;
	fs?: SpecFs;
};

export type ResolvedSpecBundle = {
	source: SpecSource;
	bundled: OpenAPI.Document;
	canonicalText: string;
	fingerprint: string;
};

function isProbablyUrl(input: string): boolean {
	return /^https?:\/\//i.test(input);
}

function parseSpecText(text: string): unknown {
	const trimmed = text.trimStart();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		return JSON.parse(text);
	}

	return parseYamlContent(text);
}

/**
 * Match Ref Parser's filesystem-path conversion: decode URI text while
 * retaining structural separators, then decode its filesystem-safe filename
 * escape set. `decodeURI` also gives Node and Bun the same malformed-escape
 * rejection behavior.
 */
function decodeParserPlainPath(input: string): string {
	return decodeURI(input).replace(REF_PARSER_FILENAME_ESCAPE, (encoded) =>
		decodeURIComponent(encoded),
	);
}

function decodeParserFileUrl(input: string): string {
	const fileUrl = new URL(input);
	if (fileUrl.protocol !== "file:") {
		throw new TypeError(`Expected a file: URL, received ${fileUrl.protocol}`);
	}

	const decoded = decodeParserPlainPath(fileUrl.href);
	let native = decoded[7] === "/" ? decoded.slice(8) : decoded.slice(7);
	if (process.platform === "win32") {
		if (native[1] === "/") native = `${native[0]}:${native.slice(1)}`;
		native = native.replaceAll("/", "\\");
		if (native.slice(1, 3) === ":\\") {
			native = `${native[0]?.toUpperCase()}${native.slice(1)}`;
		}
		return native;
	}

	return `/${native}`;
}

/** Convert a parser-produced child location to the native SpecFs path. */
export function parserChildFilePath(input: string): string {
	const native = input.toLowerCase().startsWith("file:")
		? decodeParserFileUrl(input)
		: decodeParserPlainPath(input);
	return path.resolve(path.normalize(native));
}

/**
 * Normalize a caller-provided SpecFs root. Plain roots are already native
 * paths; only an explicit file URL is decoded as a URL.
 */
export function customFsRootPath(spec: string): string {
	let native = spec;
	if (spec.toLowerCase().startsWith("file:")) {
		// Bun's fileURLToPath accepts malformed percent escapes that Node rejects.
		// Validate the URI spelling first so both runtimes share the root contract.
		decodeURI(spec);
		native = fileURLToPath(spec);
	}
	return path.resolve(path.normalize(native));
}

function assertOpenApi3Document(
	value: unknown,
): asserts value is OpenAPI.Document {
	const version = (value as { openapi?: unknown } | null)?.openapi;
	if (typeof version !== "string" || !version.startsWith("3.")) {
		throw new Error("Loaded spec is not a valid OpenAPI 3 document");
	}
}

function customFsResolverOptions(fs: SpecFs): SwaggerParser.Options {
	return {
		resolve: {
			file: {
				async read(file: SwaggerParser.FileInfo) {
					return fs.readFile(parserChildFilePath(file.url));
				},
			},
		},
	};
}

/**
 * Resolve one complete, serializable OpenAPI snapshot. Both dynamic loading and
 * compilation use this boundary so source acquisition and reference resolution
 * cannot drift.
 */
export async function resolveSpecBundle(
	options: ResolveSpecBundleOptions,
): Promise<ResolvedSpecBundle> {
	const { spec, embeddedSpecText, fs } = options;

	let source: SpecSource;
	let bundled: OpenAPI.Document;

	if (typeof embeddedSpecText === "string") {
		source = "embedded";
		const parsed = parseSpecText(embeddedSpecText) as OpenAPI.Document;
		bundled = await SwaggerParser.bundle(EMBEDDED_BASE, parsed, {});
	} else if (spec && isProbablyUrl(spec)) {
		source = "url";
		bundled = await SwaggerParser.bundle(spec);
	} else if (spec) {
		source = "file";
		if (fs) {
			const basePath = customFsRootPath(spec);
			const parsed = parseSpecText(
				await fs.readFile(basePath),
			) as OpenAPI.Document;
			bundled = await SwaggerParser.bundle(
				basePath,
				parsed,
				customFsResolverOptions(fs),
			);
		} else {
			const parsed = parseSpecText(
				await readFileText(spec),
			) as OpenAPI.Document;
			bundled = await SwaggerParser.bundle(spec, parsed, {});
		}
	} else {
		throw new Error(
			"Missing spec. Provide --spec <url|path> or build with an embedded spec.",
		);
	}

	assertOpenApi3Document(bundled);
	const canonicalText = stableStringify(bundled);
	const fingerprint = await sha256Hex(canonicalText);

	return { source, bundled, canonicalText, fingerprint };
}
