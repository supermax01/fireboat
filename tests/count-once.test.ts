// Count once (schema 0.4): the byte cap bounds the model copy, the larger of the text
// content and the compact structuredContent JSON; the complete result obeys the wire invariant 3 x cap + 4096.
// SDK cases use a real MCP SDK client over a stdio-shaped transport and measure every claim independently.
import assert from 'node:assert/strict';
import test from 'node:test';
import { FhirGateway } from '../packages/core/src/index.js';
import { exceedsByteBudget, modelCopyBytes, validateDeliverable02, wireByteCeiling, type GatewayEnvelope02 } from '../packages/core/src/contracts.js';
import { hba1c, lab, withGateway, withSdk, type Rec } from './s57-sdk-helpers.js';
import { measuredModelCopy, measuredWire, wireCeiling } from './count-once-helpers.js';

const textBytes = (wire: Rec) => Buffer.byteLength((wire.content as Rec[]).map(block => String(block.text)).join('\n'));
const structuredBytes = (wire: Rec) => Buffer.byteLength(JSON.stringify(wire.structuredContent));
const page = (count: number, size: number, extra: Rec = {}) => Array.from({ length: count }, (_, i) => lab(`count-once-${i}`, { note: [{ text: 'n'.repeat(size) }], ...extra }));
const search = (max_bytes: number) => ({ resource_type: 'Observation', params: hba1c, page_size: 100, output: { format: 'fhir', max_bytes } });
const ids = (e: Rec): string[] => (e.data.resources as Rec[]).map(resource => resource.id as string);

test('count once: the wire ceiling and the shared fitting test bound both measures', () => {
  assert.equal(wireByteCeiling(4096), 16384); assert.equal(wireByteCeiling(131072), 397312);
  const fits = { bytes_returned: 4096, byte_limit: 4096, wire_bytes: 16384 };
  assert.equal(exceedsByteBudget(fits), false);
  assert.equal(exceedsByteBudget({ ...fits, bytes_returned: 4097 }), true, 'model copy over the cap');
  assert.equal(exceedsByteBudget({ ...fits, wire_bytes: 16385 }), true, 'complete result over the wire invariant, model copy within the cap');
  assert.equal(exceedsByteBudget(fits, 128), true, 'the reserve applies to the model copy');
  assert.equal(exceedsByteBudget({ ...fits, bytes_returned: 100, wire_bytes: 16300 }, 128), true, 'the reserve applies to the wire invariant');
  assert.equal(exceedsByteBudget({ ...fits, bytes_returned: 100, wire_bytes: 16200 }, 128), false);
});

test('count once: the model copy is the larger copy, with several text blocks joined by LF', () => {
  const structuredContent = { a: 'x'.repeat(100) };
  const json = JSON.stringify(structuredContent);
  assert.equal(modelCopyBytes({ content: [{ type: 'text', text: json }], structuredContent }), Buffer.byteLength(json));
  assert.equal(modelCopyBytes({ content: [{ type: 'text', text: 'slim' }], structuredContent }), Buffer.byteLength(json), 'a slim text copy: the structured copy counts');
  assert.equal(modelCopyBytes({ content: [{ type: 'text', text: `${json}\u0085` }], structuredContent }), Buffer.byteLength(json) + 2, 'a larger text copy counts in UTF-8 bytes');
  assert.equal(modelCopyBytes({ content: [{ type: 'text', text: json }, { type: 'text', text: 'tail' }], structuredContent }), Buffer.byteLength(`${json}\ntail`), 'several text blocks are LF-joined');
});

test('count once: the default is 49152 one-copy bytes when limits are unset', async () => {
  const gateway = new FhirGateway({ mode: 'synthetic', source: { alias: 'local', baseUrl: 'http://127.0.0.1:9/fhir' }, patientId: 'synthetic-a' });
  try {
    assert.equal(gateway.describeOperatorPolicy().defaultBytes, 49152);
    assert.equal(gateway.describeOperatorPolicy().maxBytes, 131072);
    const refused = await gateway.execute('fhir_search', { resource_type: 'Observation', bogus: true });
    assert.equal(refused.error?.code, 'INVALID_ARGUMENTS'); assert.equal(refused.budget.byte_limit, 49152);
  } finally { gateway.close(); }
  for (const era of ['modern', 'legacy'] as const) await withGateway({}, gateway => withSdk(gateway, era, async sdk => {
    const { e } = await sdk.call('fhir_search', { resource_type: 'Observation', params: hba1c });
    assert.equal(e.error, undefined); assert.equal(e.budget.byte_limit, 49152);
  }));
});

for (const era of ['modern', 'legacy'] as const) {
  test(`count once ${era}: a page whose model copy is just under the cap is delivered whole, with a wire result about twice the cap`, async () => {
    await withGateway({ pages: [page(12, 2400)] }, gateway => withSdk(gateway, era, async sdk => {
      const control = await sdk.call('fhir_search', search(131072));
      assert.equal(control.e.error, undefined); assert.equal(ids(control.e).length, 12);
      // The fitter keeps a 128-byte reserve for the final timing fields and reserves the larger retention-failure
      // shape (a RESULT_NOT_RETAINED warning), so this cap leaves only a few hundred bytes spare.
      const cap = control.e.budget.bytes_returned + 400;
      const { e, wire } = await sdk.call('fhir_search', search(cap));
      assert.equal(e.error, undefined); assert.deepEqual(ids(e), ids(control.e), 'every record delivered');
      assert.equal(e.pagination.has_more, false);
      assert.equal(e.budget.byte_limit, cap);
      assert.ok(e.budget.bytes_returned <= cap && e.budget.bytes_returned > cap - 512, 'model copy just under the cap (within 512 bytes)');
      assert.equal(e.budget.bytes_returned, measuredModelCopy(wire));
      assert.equal(e.budget.wire_bytes, measuredWire(wire));
      assert.ok(e.budget.wire_bytes > 1.9 * cap, `wire result ${e.budget.wire_bytes} is about twice the ${cap}-byte cap`);
      assert.ok(e.budget.wire_bytes <= wireCeiling(cap));
    }));
  });

  test(`count once ${era}: a page just over the cap is fitted down and drains without loss`, async () => {
    await withGateway({ pages: [page(12, 2400)] }, gateway => withSdk(gateway, era, async sdk => {
      const control = await sdk.call('fhir_search', search(131072));
      const cap = control.e.budget.bytes_returned; // Under the reserve, the whole page no longer fits.
      const first = await sdk.call('fhir_search', search(cap));
      assert.equal(first.e.error, undefined);
      assert.ok(ids(first.e).length > 0 && ids(first.e).length < 12, 'fitted down');
      assert.ok(first.e.budget.bytes_returned <= cap - 128);
      assert.ok(first.e.pagination.next_cursor);
      const delivered = [...ids(first.e)];
      let cursor = first.e.pagination.next_cursor as string | undefined;
      while (cursor) {
        const next = await sdk.call('fhir_page', { cursor, output: { format: 'fhir', max_bytes: cap } });
        assert.equal(next.e.error, undefined); assert.ok(next.e.budget.bytes_returned <= cap - 128);
        delivered.push(...ids(next.e)); cursor = next.e.pagination.next_cursor;
      }
      assert.deepEqual(delivered, ids(control.e));
    }));
  });

  test(`count once ${era}: the wire invariant holds for text heavy in quotes and backslashes`, async () => {
    await withGateway({ pages: [page(6, 0, { note: [{ text: '"\\'.repeat(1500) }] })] }, gateway => withSdk(gateway, era, async sdk => {
      for (const cap of [4096, 16384, 131072]) {
        const { e, wire } = await sdk.call('fhir_search', search(cap));
        assert.equal(e.error, undefined);
        assert.ok(e.budget.bytes_returned <= cap);
        assert.equal(e.budget.wire_bytes, measuredWire(wire));
        assert.ok(e.budget.wire_bytes <= wireCeiling(cap), `${cap}: wire ${e.budget.wire_bytes}`);
        if (ids(e).length) assert.ok(e.budget.wire_bytes > 2.5 * e.budget.bytes_returned, `${cap}: escape-dense text roughly triples on the wire`);
      }
    }));
  });

  test(`count once ${era}: in structured-evidence-v1 the larger structured copy is what is bounded`, async () => {
    await withGateway({ structured: true, pages: [page(12, 2400)] }, gateway => withSdk(gateway, era, async sdk => {
      const control = await sdk.call('fhir_search', search(131072));
      assert.equal(control.e.error, undefined); assert.equal(ids(control.e).length, 12);
      const structured = structuredBytes(control.wire), text = textBytes(control.wire);
      assert.equal(control.e.transform.delivery_profile, 'structured-evidence-v1');
      assert.ok(structured > 2 * text, `structured ${structured} is the larger copy (text ${text})`);
      assert.equal(control.e.budget.bytes_returned, structured);
      // A cap between the two copies fits the slim text but not the structured copy: the page is fitted down.
      const cap = Math.floor((structured + text) / 2);
      const fitted = await sdk.call('fhir_search', search(cap));
      assert.equal(fitted.e.error, undefined);
      assert.ok(ids(fitted.e).length < 12, 'fitted down on the structured copy');
      assert.ok(structuredBytes(fitted.wire) <= cap);
      assert.equal(fitted.e.budget.bytes_returned, Math.max(structuredBytes(fitted.wire), textBytes(fitted.wire)));
    }));
  });

  test(`count once ${era}: a labelled full-text fallback counts its larger text copy`, async () => {
    await withGateway({ structured: true }, gateway => withSdk(gateway, era, async sdk => {
      const { e, wire } = await sdk.call('fhir_capabilities', { topic: 'context' });
      assert.equal(e.error, undefined);
      const text = textBytes(wire), structured = structuredBytes(wire);
      assert.ok((wire.content as Rec[])[0]!.text.startsWith('delivery_profile: "full-text-v1"\n'), 'capabilities fall back to labelled full text');
      assert.ok(text > structured, 'the labelled text copy is the larger one');
      assert.equal(e.budget.bytes_returned, text);
    }));
  });
}

test('count once: the final gate refuses a complete result over the wire invariant even when the model copy fits', async () => {
  // A structured-evidence text copy of raw control characters is 1 UTF-8 byte each in the model copy but 6 bytes
  // each once JSON-escaped on the wire. No shipped renderer emits raw control characters; this pins the gate itself.
  await withGateway({ structured: true }, gateway => withSdk(gateway, 'modern', async sdk => {
    const { e, capture } = await sdk.call('fhir_search', search(24576));
    assert.equal(e.error, undefined);
    assert.equal(capture.deliveryProfile, 'structured-evidence-v1');
    const forge = (count: number) => {
      const env = structuredClone(capture.result.structuredContent) as GatewayEnvelope02;
      const text = `delivery_profile: "structured-evidence-v1"\n${'\u0001'.repeat(count)}`;
      let result: Rec = {};
      for (let i = 0; i < 6; i++) {
        result = { ...structuredClone(capture.result), content: [{ type: 'text', text }], structuredContent: env };
        env.budget.bytes_returned = measuredModelCopy(result); env.budget.wire_bytes = measuredWire(result);
      }
      result = { ...structuredClone(capture.result), content: [{ type: 'text', text }], structuredContent: env };
      const frozen = (value: unknown): unknown => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(frozen); Object.freeze(value); } return value; };
      return { env, context: frozen({ ...capture, renderedText: text, result }) as typeof capture };
    };
    const within = forge(2000);
    assert.ok(within.env.budget.wire_bytes <= wireCeiling(24576));
    assert.deepEqual(validateDeliverable02('fhir_search', within.env, within.context), { ok: true });
    const over = forge(24000);
    assert.ok(over.env.budget.bytes_returned <= 24576 && over.env.budget.wire_bytes > wireCeiling(24576));
    assert.deepEqual(validateDeliverable02('fhir_search', over.env, over.context), { ok: false, reason: 'INVALID_FINAL_BYTES' });
    // The gate measures each claim itself: a text-only or structured-only claim is refused.
    const slim = forge(200);
    assert.ok(textBytes(slim.context.result as Rec) < structuredBytes(slim.context.result as Rec));
    const textOnly = structuredClone(slim.env); textOnly.budget.bytes_returned = textBytes(slim.context.result as Rec);
    assert.deepEqual(validateDeliverable02('fhir_search', textOnly, slim.context), { ok: false, reason: 'INVALID_FINAL_BYTES' });
    const large = forge(23000);
    assert.ok(textBytes(large.context.result as Rec) > structuredBytes(large.context.result as Rec));
    const structuredOnly = structuredClone(large.env); structuredOnly.budget.bytes_returned = structuredBytes(large.context.result as Rec);
    assert.deepEqual(validateDeliverable02('fhir_search', structuredOnly, large.context), { ok: false, reason: 'INVALID_FINAL_BYTES' });
  }));
});
