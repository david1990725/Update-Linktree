const PRICING_URL = 'https://ai.google.dev/gemini-api/docs/pricing.md';
const DEPRECATIONS_URL = 'https://ai.google.dev/gemini-api/docs/deprecations.md';
const MODEL_DOCS_URL = 'https://ai.google.dev/gemini-api/docs/models/';
const RETIREMENT_BUFFER_DAYS = 30;
// A fixed workload estimate is needed when input and output prices rank differently.
const ESTIMATED_INPUT_TOKENS = 10000;
const ESTIMATED_OUTPUT_TOKENS = 2000;

export function parseStandardPrice(markdown, model) {
  const section = markdown.split(/^## /m).find(part => new RegExp(`\\{%\\s*id="${model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*%\\}`).test(part.split('\n')[0]));
  if (!section || /deprecated|automatically route|shut down/i.test(section.split(/\{%\s*tab title="Standard"/)[0])) return null;
  const standard = section.match(/\{%\s*tab title="Standard"\s*%\}([\s\S]*?)\{%\s*\/tab\s*%\}/)?.[1];
  if (!standard || !/Paid Tier, per 1M tokens in USD/i.test(standard)) return null;
  function extract(label) {
    const row = standard.match(new RegExp(`\\* ${label}([^\\n]*)\\n\\s*\\*[^\\n]*\\n\\s*\\* \\$(\\d+(?:\\.\\d+)?)([^\\n]*)`, 'i'));
    if (!row) return null;
    // Do not silently use a text-only rate for image tokens.
    if (label === 'Input price' && !(/text/i.test(row[3]) && /image/i.test(row[3]))) return null;
    if (/[<>]|\b(?:above|below|over|under|up to)\b/i.test(row[3])) return null;
    return Number(row[2]);
  }
  const input = extract('Input price');
  const output = extract('Output price');
  return input !== null && output !== null && input > 0 && output > 0 ? { input, output } : null;
}

export function retirementStatus(markdown, model, now = Date.now()) {
  const escaped = model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rows = [...markdown.matchAll(new RegExp('^\\s*\\* `' + escaped + '`\\s*\\n\\s*\\* ([^\\n]+)\\n\\s*\\* ([^\\n]+)\\n\\s*\\*([^\\n]*)', 'gm'))];
  if (rows.length !== 1) return { eligible: false, reason: '退役狀態未能確認' };
  const deadline = rows[0][2].trim();
  const note = rows[0][3];
  if (/automatically rout|no longer available/i.test(note)) return { eligible: false, reason: '已公告轉送或停止提供' };
  if (/^No shutdown date announced$/i.test(deadline)) return { eligible: true, shutdownDate: null };
  const date = Date.parse(`${deadline} 00:00:00 UTC`);
  if (!Number.isFinite(date)) return { eligible: false, reason: '停用日期無法辨識' };
  return { eligible: date > now + RETIREMENT_BUFFER_DAYS * 86400000, shutdownDate: new Date(date).toISOString().slice(0, 10) };
}

export function supportsRequiredCapabilities(markdown) {
  const input = markdown.match(/\*\*Inputs\*\*([^\n]+)/i)?.[1] || '';
  return /\bText\b/i.test(input) && /\bImage\b/i.test(input) &&
    /\*\*Output\*\*\s*Text/i.test(markdown) &&
    /\*\*Structured outputs\*\*\s*\{%\s*badge type="supported"\s*\/%\}/i.test(markdown);
}

export async function chooseCheapestModel(ai, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const pricingUrl = options.pricingUrl || PRICING_URL;
  async function getDocument(url, label) {
    let response;
    try { response = await fetchImpl(url, { signal: AbortSignal.timeout(15000) }); }
    catch (error) { throw new Error(`無法取得 Google 官方${label}，已停止自動選擇：${error.message}`); }
    if (!response.ok) throw new Error(`無法取得 Google 官方${label}（HTTP ${response.status}），已停止自動選擇。`);
    return response.text();
  }
  const [pricing, deprecations] = await Promise.all([
    getDocument(pricingUrl, '模型價格'),
    getDocument(DEPRECATIONS_URL, '模型退役資訊')
  ]);
  const pager = await ai.models.list({ config: { pageSize: 100 } });
  const available = [];
  for await (const model of pager) {
    const id = String(model.name || '').replace(/^models\//, '');
    // Stable Flash-Lite text models only: other model families, preview aliases,
    // and image/audio-generation variants have different purposes and pricing.
    if (/^gemini-\d+(?:\.\d+)?-flash-lite$/.test(id) && model.supportedActions?.includes('generateContent')) available.push(id);
  }
  if (!available.length) throw new Error('此 API 金鑰沒有列出任何已確認支援圖片與結構化輸出的候選模型。');
  const candidates = [];
  for (const model of available) {
    const lifecycle = retirementStatus(deprecations, model, options.now ?? Date.now());
    if (!lifecycle.eligible) continue;
    const price = parseStandardPrice(pricing, model);
    if (!price) throw new Error(`無法確認 ${model} 的官方標準價格或模型狀態，已停止自動選擇。`);
    const docs = await getDocument(`${MODEL_DOCS_URL}${encodeURIComponent(model)}.md`, `模型能力（${model}）`);
    if (!supportsRequiredCapabilities(docs)) continue;
    candidates.push({ model, ...price, shutdownDate: lifecycle.shutdownDate, estimatedCost: (price.input * ESTIMATED_INPUT_TOKENS + price.output * ESTIMATED_OUTPUT_TOKENS) / 1000000 });
  }
  candidates.sort((a, b) => a.estimatedCost - b.estimatedCost || a.model.localeCompare(b.model));
  if (!candidates.length) throw new Error('沒有符合圖片、結構化輸出、價格與退役條件的模型；已停止自動選擇。');
  // Listing a model does not establish whether a particular API key can use it.
  // Check in price order with a tiny text request; it can consume API quota.
  while (candidates.length) {
    try {
      await ai.models.generateContent({ model: candidates[0].model, contents: 'Reply OK.', config: { maxOutputTokens: 32, abortSignal: AbortSignal.timeout(20000) } });
      break;
    } catch (error) {
      const status = Number(error?.status);
      const unavailable = status === 503 || (status === 404 && /not found|not available|no longer available/i.test(String(error?.message || '')));
      if (!unavailable) throw new Error(`無法確認模型 ${candidates[0].model} 的存取權限：${error.message}`);
      console.warn(`[Classifier] ${candidates[0].model} 無法使用（HTTP ${status}），略過。`);
      candidates.shift();
    }
  }
  if (!candidates.length) throw new Error('沒有候選模型可供目前的 API 金鑰使用。');
  return { ...candidates[0], candidates, pricingUrl, estimatedInputTokens: ESTIMATED_INPUT_TOKENS, estimatedOutputTokens: ESTIMATED_OUTPUT_TOKENS };
}
