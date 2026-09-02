/**
 * Loads every Lambda bundle cdk synth produced, the way the runtime will.
 *
 * Bundling can succeed and still emit code that dies on import: esbuild
 * resolves imports at build time, but a CommonJS dependency doing require()
 * at *runtime* becomes a shim that throws ("Dynamic require of X is not
 * supported"). That shipped once already and took every JWT-using function
 * with it, because nothing between synth and production ever executed a bundle.
 */
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const outdir = resolve(process.argv[2] ?? "cdk/cdk.out");

function findBundles(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...findBundles(path));
    // Only our NodejsFunction output, which is ESM (index.mjs). CDK's own
    // custom-resource handlers are CommonJS index.js, are vendor code with
    // their own runtime contract, and cannot be imported here anyway because
    // cdk/package.json declares "type": "module".
    else if (entry === "index.mjs") found.push(path);
  }
  return found;
}

const bundles = findBundles(outdir);
if (bundles.length === 0) {
  // Also guards against the bundle format changing to CJS without this check
  // being updated, which would otherwise silently verify nothing.
  console.error(`No index.mjs bundles under ${outdir} — did cdk synth run?`);
  process.exit(1);
}

let failed = 0;
for (const bundle of bundles) {
  try {
    await import(pathToFileURL(bundle).href);
    console.log(`ok    ${bundle}`);
  } catch (error) {
    failed++;
    console.error(`FAIL  ${bundle}\n      ${error.message}`);
  }
}

console.log(`\n${bundles.length - failed}/${bundles.length} bundles loaded`);
if (failed > 0) process.exit(1);
