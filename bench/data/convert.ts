// bench:convert -- --dataset <mimic|synthea-dev>
// Verifies the inputs, then writes converted/<dataset>/ (data/convert-lib.ts) and
// manifests/convert-<dataset>.json. The Synthea holdout is converted by bench:holdout with the same core.
import { devDatasetArg, parseCommon } from '../lib/cli.js';
import { results } from '../lib/paths.js';
import { log, writeManifest } from '../infra/manifest.js';
import { verifyInputs } from './checksums.js';
import { convertDataset } from './convert-lib.js';

const { values } = parseCommon();
const dataset = devDatasetArg(values.dataset);

const inputs = await verifyInputs(dataset);
log(`${dataset}: ${inputs.files.length} input files verified against ${inputs.sums_file}`);

const body = await convertDataset({ dataset, files: inputs.files, outDir: results.converted(dataset) });
const { dataset: _d, ...rest } = body;
const manifestPath = await writeManifest(`convert-${dataset}`, { dataset, inputs, ...rest });
log(`${dataset}: manifest ${manifestPath}`);
