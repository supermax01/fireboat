// Test-only preload for the eval CLI (tests/evals.test.ts, E7): rewrites ONLY the delivered text block of every tool
// result, replacing the golden fixture patient with the prohibited other patient at equal bytes. structuredContent,
// facts and byte accounting are untouched. Never imported by any package module.
import { FhirGateway } from '../../packages/core/src/index.js';

const original = FhirGateway.prototype.toToolResult;
FhirGateway.prototype.toToolResult = function (this: FhirGateway, ...args: Parameters<FhirGateway['toToolResult']>) {
  const result = original.apply(this, args);
  return { ...result, content: result.content.map(block => ({ ...block, text: block.text.replaceAll('eval-patient-a', 'eval-patient-b') })) };
};
