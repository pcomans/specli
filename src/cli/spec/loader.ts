import SwaggerParser from "@apidevtools/swagger-parser";

import type { LoadedSpec, OpenApiDoc } from "../core/types.js";
import { getSpecId } from "./id.js";
import {
	type ResolveSpecBundleOptions,
	resolveSpecBundle,
	type SpecFs,
} from "./resolved-bundle.js";

export type { SpecFs };
export type LoadSpecOptions = ResolveSpecBundleOptions;

export async function loadSpec(options: LoadSpecOptions): Promise<LoadedSpec> {
	const resolved = await resolveSpecBundle(options);
	// Swagger Parser mutates object inputs. Hashing completed before this turns
	// the same compact bundle into a graph.
	const doc = (await SwaggerParser.dereference(resolved.bundled)) as OpenApiDoc;

	const id = getSpecId({ doc, fingerprint: resolved.fingerprint });

	return {
		source: resolved.source,
		id,
		fingerprint: resolved.fingerprint,
		doc,
	};
}
