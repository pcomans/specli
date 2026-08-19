import { isReservedRootCommandName } from "../core/root-command-names.js";
import { kebabCase } from "../core/strings.js";
import type { NormalizedOperation } from "../core/types.js";

export type PlannedOperation = NormalizedOperation & {
	resource: string;
	action: string;
	/** CLI-friendly path arg names (kebab-case) */
	pathArgs: string[];
	/** Original path template variable names (for URL substitution) */
	rawPathArgs: string[];
};

type PathAnalysis = {
	leafLiteral: string[];
	terminalIsMember: boolean;
	hasNestedStaticLeaf: boolean;
	resourceEvidence: string[][];
	structuredResourceEvidence: string[][];
};

type StructuredIdentifier = {
	left: string[];
	right: string[];
	full: string;
};

type OperationCandidate = {
	op: NormalizedOperation;
	resource: string;
	actions: string[];
	pathArgs: string[];
	rawPathArgs: string[];
};

const PATH_TEMPLATE_EXPRESSION = /\{[^{}]+\}/;
const COMMAND_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function getPathSegments(path: string): string[] {
	return path
		.split("/")
		.map((segment) => segment.trim())
		.filter(Boolean);
}

function getPathArgs(path: string): string[] {
	const args: string[] = [];
	const pattern = /\{([^}]+)\}/g;

	for (let match = pattern.exec(path); match; match = pattern.exec(path)) {
		const name = match[1];
		if (name) args.push(name);
	}

	return args;
}

function tokenizeIdentifier(value: string): string[] {
	const separated = value
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2");
	const normalized = kebabCase(separated);
	return normalized ? normalized.split("-") : [];
}

function normalizeIdentifier(value: string): string {
	return tokenizeIdentifier(value).join("-");
}

function literalPathTokens(segment: string): string[] {
	const lastDot = segment.lastIndexOf(".");
	const resourcePart = lastDot > 0 ? segment.slice(0, lastDot) : segment;
	return tokenizeIdentifier(resourcePart);
}

function hasPathTemplate(segment: string): boolean {
	return PATH_TEMPLATE_EXPRESSION.test(segment);
}

function sequenceKey(tokens: string[]): string {
	return tokens.join("\0");
}

function uniqueSequences(sequences: string[][]): string[][] {
	const seen = new Set<string>();
	const unique: string[][] = [];

	for (const tokens of sequences) {
		if (tokens.length === 0) continue;
		const key = sequenceKey(tokens);
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(tokens);
	}

	return unique;
}

function structuredPathResourceEvidence(
	segments: string[],
	leafLiteral: string[],
	resourceEvidence: string[][],
): string[][] {
	const evidence = [leafLiteral, ...resourceEvidence];
	const firstTemplate = segments.findIndex((segment) =>
		hasPathTemplate(segment),
	);
	if (firstTemplate < 0) return uniqueSequences(evidence);

	// The literal immediately before the first template begins the nested
	// resource structure. Earlier transport/version ancestors stay out, while
	// later literals remain discoverable across any run of templates.
	for (
		let index = Math.max(0, firstTemplate - 1);
		index < segments.length;
		index++
	) {
		const segment = segments[index];
		if (segment && !hasPathTemplate(segment)) {
			evidence.push(literalPathTokens(segment));
		}
	}

	return uniqueSequences(evidence);
}

function analyzePath(path: string): PathAnalysis {
	const segments = getPathSegments(path);
	const terminal = segments.at(-1);
	const terminalIsMember = Boolean(terminal && hasPathTemplate(terminal));
	const terminalLiteral = terminalIsMember ? undefined : terminal;
	const leafLiteral = terminalLiteral
		? literalPathTokens(terminalLiteral)
		: (() => {
				for (let index = segments.length - 1; index >= 0; index--) {
					const segment = segments[index];
					if (segment && !hasPathTemplate(segment)) {
						return literalPathTokens(segment);
					}
				}
				return [];
			})();
	const hasNestedStaticLeaf = Boolean(
		terminalLiteral &&
			segments.slice(0, -1).some((segment) => hasPathTemplate(segment)),
	);

	const resourceEvidence: string[][] = [];
	if (terminalIsMember && leafLiteral.length > 0) {
		resourceEvidence.push(leafLiteral);
	}

	for (let start = 0; start < segments.length - 1; start++) {
		const first = segments[start];
		const following = segments[start + 1];
		if (
			!first ||
			hasPathTemplate(first) ||
			!following ||
			!hasPathTemplate(following)
		) {
			continue;
		}

		const chain: string[][] = [literalPathTokens(first)];
		let cursor = start + 2;
		while (cursor < segments.length) {
			const literal = segments[cursor];
			if (!literal || hasPathTemplate(literal)) break;
			chain.push(literalPathTokens(literal));

			const separator = segments[cursor + 1];
			if (!separator || !hasPathTemplate(separator)) break;
			cursor += 2;
		}

		if (chain.some((tokens) => tokens.length === 0)) continue;
		for (let suffix = 0; suffix < chain.length - 1; suffix++) {
			resourceEvidence.push(chain.slice(suffix).flat());
		}
	}

	return {
		leafLiteral,
		terminalIsMember,
		hasNestedStaticLeaf,
		resourceEvidence: uniqueSequences(resourceEvidence),
		structuredResourceEvidence: structuredPathResourceEvidence(
			segments,
			leafLiteral,
			resourceEvidence,
		),
	};
}

function parseStructuredIdentifier(
	operationId: string | undefined,
): StructuredIdentifier | undefined {
	const trimmed = operationId?.trim();
	if (!trimmed || (!trimmed.includes(".") && !trimmed.includes("/"))) {
		return undefined;
	}

	const parts = trimmed.split(/[./]/);
	if (parts.length < 2 || parts.some((part) => part.trim() === "")) {
		return undefined;
	}

	const left = tokenizeIdentifier(parts[0] ?? "");
	const right = tokenizeIdentifier(parts.slice(1).join("-"));
	const full = normalizeIdentifier(trimmed);
	return left.length > 0 && right.length > 0 && full
		? { left, right, full }
		: undefined;
}

function firstTagResource(op: NormalizedOperation): string | undefined {
	for (const tag of op.tags) {
		const normalized = kebabCase(tag);
		if (normalized) return normalized;
	}
	return undefined;
}

function reserveRootResource(resource: string): string {
	let reserved = resource;
	while (isReservedRootCommandName(reserved)) {
		reserved = `openapi-${reserved}`;
	}
	return reserved;
}

function resourceSuffixes(resource: string): string[][] {
	const tokens = resource.split("-").filter(Boolean);
	return tokens.map((_, index) => tokens.slice(index));
}

function startsWithTokens(value: string[], prefix: string[]): boolean {
	return prefix.every((token, index) => value[index] === token);
}

function endsWithTokens(value: string[], suffix: string[]): boolean {
	const offset = value.length - suffix.length;
	return suffix.every((token, index) => value[offset + index] === token);
}

function includesSequence(evidence: string[][], subject: string[]): boolean {
	const subjectKey = sequenceKey(subject);
	return evidence.some((tokens) => sequenceKey(tokens) === subjectKey);
}

function resolveStructuredIdentifier(
	structured: StructuredIdentifier,
	tagResource: string | undefined,
	path: PathAnalysis,
): { resource?: string; action?: string; fullOperationId: string } {
	const evidence = tagResource
		? resourceSuffixes(tagResource)
		: uniqueSequences([
				...path.structuredResourceEvidence,
				...resourceSuffixes(path.leafLiteral.join("-")),
			]);
	const leftIsResource = includesSequence(evidence, structured.left);
	const rightIsResource = includesSequence(evidence, structured.right);

	if (leftIsResource === rightIsResource) {
		return { fullOperationId: structured.full };
	}

	const resourceTokens = leftIsResource ? structured.left : structured.right;
	const actionTokens = leftIsResource ? structured.right : structured.left;
	return {
		resource: tagResource ?? resourceTokens.join("-"),
		action: actionTokens.join("-"),
		fullOperationId: structured.full,
	};
}

function extractAuthoredAction(
	operationId: string | undefined,
	sourceResource: string,
	path: PathAnalysis,
): { action?: string; fullOperationId?: string } {
	if (!operationId) return {};

	const tokens = tokenizeIdentifier(operationId);
	if (tokens.length === 0) return {};

	const fullOperationId = tokens.join("-");
	const evidence = uniqueSequences([
		...resourceSuffixes(sourceResource),
		...path.resourceEvidence,
	]);
	const matches: Array<{ removed: number; action: string }> = [];

	for (const subject of evidence) {
		if (subject.length >= tokens.length) continue;
		if (startsWithTokens(tokens, subject)) {
			matches.push({
				removed: subject.length,
				action: tokens.slice(subject.length).join("-"),
			});
		}
		if (endsWithTokens(tokens, subject)) {
			matches.push({
				removed: subject.length,
				action: tokens.slice(0, -subject.length).join("-"),
			});
		}
	}

	if (matches.length === 0) {
		return { action: fullOperationId, fullOperationId };
	}

	const longest = Math.max(...matches.map((match) => match.removed));
	const actions = new Set(
		matches
			.filter((match) => match.removed === longest)
			.map((match) => match.action),
	);

	return {
		action: actions.size === 1 ? [...actions][0] : fullOperationId,
		fullOperationId,
	};
}

function protocolFallback(method: string, path: PathAnalysis): string {
	switch (method) {
		case "get":
			return !path.terminalIsMember && path.leafLiteral.length > 0
				? "list"
				: "get";
		case "post":
			return "create";
		case "patch":
			return "update";
		case "put":
			return "replace";
		case "delete":
			return "delete";
		default:
			return method;
	}
}

function preferredAction(
	op: NormalizedOperation,
	authoredAction: string | undefined,
	path: PathAnalysis,
): string {
	const method = kebabCase(op.method);
	if (authoredAction && authoredAction !== method) return authoredAction;

	if (authoredAction && method === "get") {
		if (
			op.successResponseCardinality === "collection" ||
			path.hasNestedStaticLeaf
		) {
			return "list";
		}
		return "get";
	}

	return protocolFallback(method, path);
}

function operationIdentity(op: NormalizedOperation): string {
	const bytes = new TextEncoder().encode(
		`${op.method.toUpperCase()}\0${op.path}`,
	);
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function buildCandidates(op: NormalizedOperation): OperationCandidate {
	const path = analyzePath(op.path);
	const tagResource = firstTagResource(op);
	const structured = parseStructuredIdentifier(op.operationId);
	const structuredResolution = structured
		? resolveStructuredIdentifier(structured, tagResource, path)
		: undefined;
	const sourceResource =
		(tagResource ??
			structuredResolution?.resource ??
			path.leafLiteral.join("-")) ||
		"api";
	const resource = reserveRootResource(sourceResource);
	const authored = structuredResolution
		? {
				action:
					structuredResolution.action ?? structuredResolution.fullOperationId,
				fullOperationId: structuredResolution.fullOperationId,
			}
		: extractAuthoredAction(op.operationId, sourceResource, path);
	const preferred = preferredAction(op, authored.action, path);
	const terminalPrefix = authored.fullOperationId || preferred;
	const actionCandidates = [
		preferred,
		authored.fullOperationId,
		`${terminalPrefix}-op-${operationIdentity(op)}`,
	].filter((action): action is string => Boolean(action));
	const actions = [...new Set(actionCandidates)];
	const rawPathArgs = getPathArgs(op.path);

	return {
		op,
		resource,
		actions,
		pathArgs: rawPathArgs.map((argument) => kebabCase(argument)),
		rawPathArgs,
	};
}

function pairKey(resource: string, action: string): string {
	return `${resource}\0${action}`;
}

function allocateCommandNames(
	candidates: OperationCandidate[],
): PlannedOperation[] {
	const candidateIndices = candidates.map(() => 0);

	while (true) {
		const groups = new Map<string, number[]>();
		for (let index = 0; index < candidates.length; index++) {
			const candidate = candidates[index];
			if (!candidate) continue;
			const action = candidate.actions[candidateIndices[index] ?? 0];
			if (!action) throw new Error("Internal naming invariant: missing action");
			const key = pairKey(candidate.resource, action);
			const group = groups.get(key) ?? [];
			group.push(index);
			groups.set(key, group);
		}

		const collisions = [...groups.values()].filter((group) => group.length > 1);
		if (collisions.length === 0) break;

		let advanced = false;
		for (const group of collisions) {
			for (const index of group) {
				const candidate = candidates[index];
				if (!candidate) continue;
				const current = candidateIndices[index] ?? 0;
				if (current >= candidate.actions.length - 1) continue;
				candidateIndices[index] = current + 1;
				advanced = true;
			}
		}

		if (!advanced) {
			throw new Error("Internal naming invariant: terminal command collision");
		}
	}

	const planned = candidates.map((candidate, index) => {
		const action = candidate.actions[candidateIndices[index] ?? 0];
		if (!action) throw new Error("Internal naming invariant: missing action");
		return {
			...candidate.op,
			resource: candidate.resource,
			action,
			pathArgs: candidate.pathArgs,
			rawPathArgs: candidate.rawPathArgs,
		};
	});

	const finalPairs = new Set<string>();
	for (const operation of planned) {
		if (
			!COMMAND_SEGMENT.test(operation.resource) ||
			!COMMAND_SEGMENT.test(operation.action)
		) {
			throw new Error("Internal naming invariant: invalid command segment");
		}
		const key = pairKey(operation.resource, operation.action);
		if (finalPairs.has(key)) {
			throw new Error("Internal naming invariant: duplicate command");
		}
		finalPairs.add(key);
	}

	return planned;
}

export function planOperations(ops: NormalizedOperation[]): PlannedOperation[] {
	return allocateCommandNames(ops.map(buildCandidates));
}
