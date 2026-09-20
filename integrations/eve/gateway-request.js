export const endpoint = 'https://ai-gateway.vercel.sh/v4/ai/language-model';

// Anthropic strict tools do not accept string length or array maximum bounds.
// Keep those constraints in descriptions and in the original local Zod schema.
function strictToolSchema(schema) {
  const { minLength, maxLength, maxItems, ...result } = schema;
  const bounds = [minLength === undefined ? '' : `Minimum string length: ${minLength}.`,
    maxLength === undefined ? '' : `Maximum string length: ${maxLength}.`,
    maxItems === undefined ? '' : `Maximum array length: ${maxItems}.`].filter(Boolean);
  if (bounds.length) result.description = [result.description, ...bounds].filter(Boolean).join(' ');
  if (result.properties) result.properties = Object.fromEntries(Object.entries(result.properties).map(([name, value]) => [name, strictToolSchema(value)]));
  if (result.items) result.items = strictToolSchema(result.items);
  if (result.anyOf) result.anyOf = result.anyOf.map(strictToolSchema);
  return result;
}

export function gatewayRequest(url, init, model) {
    if (String(url) !== endpoint || init?.method !== 'POST' || typeof init.body !== 'string'
        || new Headers(init.headers).get('ai-language-model-id') !== model) throw new Error('GATEWAY_REQUEST_DENIED');
    let body;
    try { body = JSON.parse(init.body); } catch { throw new Error('GATEWAY_REQUEST_DENIED'); }
    if (body.maxOutputTokens !== 2048 || !Array.isArray(body.prompt)
        || body.prompt.some(message => !['system', 'user'].includes(message.role)
          || (typeof message.content !== 'string' && (!Array.isArray(message.content) || message.content.some(part => part.type !== 'text'))))
        || !Array.isArray(body.tools) || body.tools.length !== 1 || body.tools[0].type !== 'function'
        || body.tools[0].name !== 'final_output' || body.tools[0].inputSchema?.type !== 'object') throw new Error('GATEWAY_REQUEST_DENIED');
    // Eve 0.47.3's final_output tool omits strict. Enable the v4 tool flag
    // without adding a repair step or relaxing application-side validation.
    body.tools = [{ ...body.tools[0], strict: true, inputSchema: strictToolSchema(body.tools[0].inputSchema) }];
    // An explicit request-scoped empty BYOK map excludes saved account keys.
    // Keep it present: omission permits Gateway's account-level BYOK routing.
    body.providerOptions = { gateway: { only: ['anthropic'], models: [], byok: {} } };
    body.reasoning = 'low';
    const serialized = JSON.stringify(body);
    return { body, serialized };
}
