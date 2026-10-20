import { clampMaxTokensToContext } from '@earendil-works/pi-ai/api/simple-options';
import type { Api, Model, AuthResult, TranscriptContext } from '@earendil-works/pi-ai';
import { canonical } from './protocol.js';
import { getProviderModel, ROUTING_FIELDS, type ProviderRoute } from './provider-config.js';
export function materialize(model: Model<Api>, auth: AuthResult): Model<Api> {
  let baseUrl = auth.auth.baseUrl ?? model.baseUrl;
  for (const [key, value] of Object.entries(auth.env ?? {}))
    baseUrl = baseUrl.replaceAll('{' + key + '}', value);
  if (model.provider === 'azure') {
    const env = auth.env ?? {};
    baseUrl =
      env.AZURE_OPENAI_BASE_URL ??
      (env.AZURE_OPENAI_RESOURCE_NAME
        ? `https://${env.AZURE_OPENAI_RESOURCE_NAME}.openai.azure.com/openai/v1`
        : baseUrl);
  }
  if (model.provider === 'google-vertex') {
    const location = auth.env?.GOOGLE_CLOUD_LOCATION ?? 'global';
    if (!/^[a-z0-9-]+$/.test(location)) throw new Error('Invalid Google Cloud location');
    baseUrl =
      location === 'global'
        ? 'https://aiplatform.googleapis.com'
        : `https://${location}-aiplatform.googleapis.com`;
  }
  if (model.provider === 'amazon-bedrock') {
    const region =
      /^arn:aws[^:]*:bedrock:([^:]+):/.exec(model.id)?.[1] ??
      auth.env?.AWS_REGION ??
      auth.env?.AWS_DEFAULT_REGION;
    if (region) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(region)) throw new Error('Invalid AWS region');
      baseUrl = `https://bedrock-runtime.${region}.amazonaws.com${region.startsWith('cn-') ? '.cn' : ''}`;
    }
  }
  const url = new URL(baseUrl);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    /[{}]/.test(baseUrl)
  )
    throw new Error('Provider endpoint is not configured');
  return {
    ...model,
    baseUrl: baseUrl.replace(/\/$/, ''),
    headers: model.headers,
    compat: {
      ...model.compat,
      supportsMidConvoSystemMessages: false,
      supportsMidConvoToolChanges: false,
      supportsMidConvoEffort: false,
      supportsAdditionalTools: false,
      supportsToolSearch: false,
      supportsOpenAIGrammarTools: false,
      allowedFallbackModels: [],
    },
  };
}

/** Non-secret routing configuration becomes part of durable session identity. */
export function bindProviderConfiguration(route: ProviderRoute, auth: AuthResult): ProviderRoute {
  const catalog = getProviderModel(route);
  if (!catalog) throw new Error('Pinned provider model missing');
  const model = materialize(catalog, auth);
  const configuration = Object.fromEntries(
    ROUTING_FIELDS.flatMap((key) => (auth.env?.[key] ? [[key, auth.env[key]!]] : [])),
  );
  const changed =
    route.provider !== 'anthropic' ||
    model.baseUrl !== catalog.baseUrl ||
    Object.keys(configuration).length > 0;
  const binding = changed ? { endpoint: model.baseUrl, configuration } : undefined;
  if (route.connection && canonical(route.connection) !== canonical(binding))
    throw new Error(
      'Provider endpoint or routing configuration changed; use the original configuration or a new session',
    );
  return binding ? { ...route, connection: binding } : route;
}

/** Leave room for the answer instead of emitting Pi's minimum 1,024-token thinking budget under a smaller ceiling. */
export function generationOptions(
  model: Model<Api>,
  context: TranscriptContext,
  cap: number,
  reasoning?: import('./provider-config.js').ReasoningLevel,
) {
  const maxTokens = clampMaxTokensToContext(model, context, cap);
  return {
    maxTokens,
    reasoning: maxTokens >= 2048 && reasoning !== 'off' ? (reasoning ?? 'low') : undefined,
  };
}
