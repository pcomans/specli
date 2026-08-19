import type {
	NormalizedOperation,
	NormalizedParameter,
	NormalizedRequestBody,
	OpenApiDoc,
} from "../core/types.js";

function operationKey(method: string, path: string): string {
	return `${method.toUpperCase()} ${path}`;
}

const HTTP_METHODS = [
	"get",
	"post",
	"put",
	"patch",
	"delete",
	"options",
	"head",
	"trace",
] as const;

type RawParameter = {
	in?: string;
	name?: string;
	required?: boolean;
	description?: string;
	schema?: unknown;
};

type RawRequestBody = {
	required?: boolean;
	content?: Record<string, { schema?: unknown } | undefined>;
};

type RawResponse = {
	content?: Record<string, { schema?: unknown } | undefined>;
};

type RawOperation = {
	operationId?: string;
	tags?: string[];
	summary?: string;
	description?: string;
	deprecated?: boolean;
	security?: OpenApiDoc["security"];
	parameters?: RawParameter[];
	requestBody?: RawRequestBody;
	responses?: Record<string, RawResponse | undefined>;
};

type RawPathItem = {
	parameters?: RawParameter[];
} & Partial<Record<(typeof HTTP_METHODS)[number], RawOperation>>;

function normalizeParam(p: RawParameter): NormalizedParameter | undefined {
	if (!p || typeof p !== "object") return undefined;
	const loc = p.in;
	const name = p.name;
	if (
		loc !== "path" &&
		loc !== "query" &&
		loc !== "header" &&
		loc !== "cookie"
	) {
		return undefined;
	}
	if (!name) return undefined;

	return {
		in: loc,
		name,
		required: Boolean(p.required || loc === "path"),
		description: p.description,
		schema: p.schema,
	};
}

function mergeParameters(
	pathParams: RawParameter[] | undefined,
	opParams: RawParameter[] | undefined,
): NormalizedParameter[] {
	const merged = new Map<string, NormalizedParameter>();

	for (const p of pathParams ?? []) {
		const normalized = normalizeParam(p);
		if (!normalized) continue;
		merged.set(`${normalized.in}:${normalized.name}`, normalized);
	}

	for (const p of opParams ?? []) {
		const normalized = normalizeParam(p);
		if (!normalized) continue;
		merged.set(`${normalized.in}:${normalized.name}`, normalized);
	}

	return [...merged.values()];
}

function normalizeRequestBody(
	rb: RawRequestBody | undefined,
): NormalizedRequestBody | undefined {
	if (!rb) return undefined;

	const content = rb.content ?? {};
	const contentTypes = Object.keys(content);
	const schemasByContentType: Record<string, unknown | undefined> = {};

	for (const contentType of contentTypes) {
		schemasByContentType[contentType] = content[contentType]?.schema;
	}

	return {
		required: Boolean(rb.required),
		contentTypes,
		schemasByContentType,
	};
}

const SUCCESS_RESPONSE_KEY = /^2(?:[0-9]{2}|XX)$/;
const COMPOSITION_KEYWORDS = ["oneOf", "anyOf", "allOf", "not"] as const;

function isDirectArraySchema(schema: unknown): boolean {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		return false;
	}

	const record = schema as Record<string, unknown>;
	const directTypeIsArray =
		record.type === "array" ||
		(Array.isArray(record.type) &&
			record.type.length === 1 &&
			record.type[0] === "array");
	if (!directTypeIsArray || record.nullable === true) return false;

	return !COMPOSITION_KEYWORDS.some((keyword) => keyword in record);
}

function getSuccessResponseCardinality(
	responses: RawOperation["responses"],
): NormalizedOperation["successResponseCardinality"] {
	let schemaCount = 0;

	for (const [status, response] of Object.entries(responses ?? {})) {
		if (!SUCCESS_RESPONSE_KEY.test(status)) continue;
		if (!response || typeof response !== "object" || Array.isArray(response)) {
			return undefined;
		}
		if (response.content === undefined) continue;
		if (
			!response.content ||
			typeof response.content !== "object" ||
			Array.isArray(response.content)
		) {
			return undefined;
		}

		for (const mediaType of Object.values(response.content)) {
			if (
				!mediaType ||
				typeof mediaType !== "object" ||
				Array.isArray(mediaType) ||
				mediaType.schema === undefined
			) {
				return undefined;
			}
			schemaCount++;
			if (!isDirectArraySchema(mediaType.schema)) return undefined;
		}
	}

	return schemaCount > 0 ? "collection" : undefined;
}

export function indexOperations(doc: OpenApiDoc): NormalizedOperation[] {
	const out: NormalizedOperation[] = [];
	const paths = doc.paths ?? {};

	for (const [path, rawPathItem] of Object.entries(paths)) {
		if (!rawPathItem || typeof rawPathItem !== "object") continue;

		const pathItem = rawPathItem as RawPathItem;

		for (const method of HTTP_METHODS) {
			const op = pathItem[method];
			if (!op) continue;

			const parameters = mergeParameters(pathItem.parameters, op.parameters);
			const normalizedMethod = method.toUpperCase();
			out.push({
				key: operationKey(normalizedMethod, path),
				method: normalizedMethod,
				path,
				operationId: op.operationId,
				successResponseCardinality: getSuccessResponseCardinality(op.responses),
				tags: op.tags ?? [],
				summary: op.summary,
				description: op.description,
				deprecated: op.deprecated,
				security: (op.security ?? doc.security) as OpenApiDoc["security"],
				parameters,
				requestBody: normalizeRequestBody(op.requestBody),
			});
		}
	}

	out.sort((a, b) => {
		if (a.path !== b.path) return a.path.localeCompare(b.path);
		return a.method.localeCompare(b.method);
	});

	return out;
}
