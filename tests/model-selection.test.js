import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStandardPrice, retirementStatus, supportsRequiredCapabilities, chooseCheapestModel } from '../src/model-selection.js';

const section = (id, input, output) => `## ${id}  {% id="${id}" %}\n{% tab title="Standard" %}\nPaid Tier, per 1M tokens in USD\n* Input price (text, image, video)\n* Free of charge\n* $${input} (text / image / video)\n\n* Output price (including thinking tokens)\n* Free of charge\n* $${output}\n{% /tab %}\n`;
const row = (id, shutdown) => `* \`${id}\`\n* July 21, 2026\n* ${shutdown}\n*\n`;
const m1 = 'gemini-3.1-flash-lite', m2 = 'gemini-3.5-flash-lite', m3 = 'gemini-4.1-flash-lite';
const pricing = section(m1, '0.10', '0.40') + section(m2, '0.25', '1.50') + section(m3, '0.05', '0.30');
const deprecations = row(m1, 'May 7, 2027') + row(m2, 'No shutdown date announced') + row(m3, 'No shutdown date announced');
const docs = '**Inputs** Text, Image, Video\n**Output** Text\n**Structured outputs**\n{% badge type="supported" /%}';
const fetcher = async url => ({ ok: true, text: async () => url.includes('pricing') ? pricing : url.includes('deprecations') ? deprecations : docs });
const models = (ids, unavailable = []) => ({ models: {
  list: async () => ({ async *[Symbol.asyncIterator]() { for (const id of ids) yield { name: `models/${id}`, supportedActions: ['generateContent'] }; } }),
  generateContent: async ({ model }) => { if (unavailable.includes(model)) { const e = new Error('no longer available'); e.status = 404; throw e; } return {}; }
} });
const now = Date.parse('2026-11-03T00:00:00Z');

test('selects the cheapest automatically discovered compatible model', async () => {
  const selected = await chooseCheapestModel(models([m1, m2, m3]), { fetchImpl: fetcher, now });
  assert.equal(selected.model, m3);
  assert.equal(selected.input, 0.05);
});
test('skips models shortly before their announced shutdown date', async () => {
  assert.equal(retirementStatus(deprecations, m1, Date.parse('2027-04-10T00:00:00Z')).eligible, false);
  assert.equal((await chooseCheapestModel(models([m1, m2]), { fetchImpl: fetcher, now: Date.parse('2027-04-10T00:00:00Z') })).model, m2);
});
test('probes access because listed models can be unavailable to the key', async () => {
  assert.equal((await chooseCheapestModel(models([m1, m2], [m1]), { fetchImpl: fetcher, now })).model, m2);
});
test('uses the next candidate if the cheapest model reports temporary high demand', async () => {
  const ai = models([m1, m2]);
  ai.models.generateContent = async ({ model }) => { if (model === m1) { const e = new Error('high demand'); e.status = 503; throw e; } return {}; };
  assert.equal((await chooseCheapestModel(ai, { fetchImpl: fetcher, now })).model, m2);
});
test('rejects unrecognizable lifecycle, pricing, and missing image or structured output', () => {
  assert.equal(retirementStatus('', m1, now).eligible, false);
  assert.equal(parseStandardPrice(section(m1, '0.1', '0.4').replace('text / image / video', 'text'), m1), null);
  assert.equal(supportsRequiredCapabilities(docs.replace('Image', 'Audio')), false);
  assert.equal(supportsRequiredCapabilities(docs.replace('type="supported"', 'type="not-supported"')), false);
});
test('stops if Google pricing cannot be retrieved', async () => {
  await assert.rejects(chooseCheapestModel(models([m1]), { fetchImpl: async () => ({ ok: false, status: 503 }), now }), /503/);
});
