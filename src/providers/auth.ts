import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import {
  defaultProviderAuthContext,
  type Credential,
  type CredentialStore,
  type CredentialInfo,
  type AuthOperationOptions,
  type AuthResult,
  type AuthInteraction,
} from '@earendil-works/pi-ai';
import { loadSharedConfigFiles } from '@smithy/core/config';
import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  chmodSync,
  openSync,
  closeSync,
  constants,
  fstatSync,
  readFileSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { credentialPath, loadApiKey, validateApiKey } from './credentials.js';
import { getProvider, getProviderModel } from './config.js';
import type { ProviderRoute } from '../core/index.js';

export const authDirectory = () => join(homedir(), '.config', 'salaam', 'credentials');
function providerId(id: string) {
  if (!getProvider(id) || !/^[a-z0-9-]+$/.test(id)) throw new Error('Unknown Pi provider');
  return id;
}
function secureDirectory(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.())
    throw new Error('Unsafe credential directory');
  chmodSync(dir, 0o700);
}
function privateRead(path: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('Unsafe provider credential file', { cause: error });
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > 65536)
      throw new Error('Provider credential file must be private (mode 600)');
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}
/** Serialize OAuth refresh across daemon and CLI processes; OS locks release on death. */
export class ProviderCredentialStore implements CredentialStore {
  constructor(readonly dir = authDirectory()) {}
  private path(id: string) {
    return join(this.dir, providerId(id) + '.json');
  }
  async read(id: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const raw = privateRead(this.path(id));
    if (raw !== undefined) {
      const value = JSON.parse(raw) as Credential;
      if (!['api_key', 'oauth'].includes(value.type))
        throw new Error('Invalid stored provider credential');
      return value;
    }
    // Preserve existing Salaam installs without reading Pi's credential home.
    if (id === 'anthropic' && this.dir === authDirectory() && existsSync(credentialPath()))
      return { type: 'api_key', key: loadApiKey(credentialPath(), '') };
    return undefined;
  }
  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    const result: CredentialInfo[] = [];
    for (const p of builtinModels().getProviders()) {
      const value = await this.read(p.id, options);
      if (value) result.push({ providerId: p.id, type: value.type });
    }
    return result;
  }
  private async locked<T>(
    id: string,
    fn: () => Promise<T>,
    options?: AuthOperationOptions,
  ): Promise<T> {
    secureDirectory(this.dir);
    const path = join(this.dir, providerId(id) + '.lock.sqlite');
    if (existsSync(path)) privateRead(path);
    const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    closeSync(fd);
    const db = new DatabaseSync(path);
    const deadline = Date.now() + 120000;
    try {
      db.exec('PRAGMA busy_timeout=0');
      while (true) {
        options?.signal?.throwIfAborted();
        try {
          db.exec('BEGIN EXCLUSIVE');
          break;
        } catch (error) {
          if (!String(error).includes('locked') || Date.now() > deadline)
            throw new Error('Provider credential lock unavailable', { cause: error });
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      try {
        return await fn();
      } finally {
        db.exec('ROLLBACK');
      }
    } finally {
      db.close();
    }
  }
  async modify(
    id: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ) {
    return this.locked(
      id,
      async () => {
        const current = await this.read(id, options),
          value = await fn(current);
        options?.signal?.throwIfAborted();
        if (value !== undefined) {
          const temp = join(this.dir, '.' + id + '-' + randomUUID()),
            fd = openSync(temp, 'wx', 0o600);
          try {
            writeFileSync(fd, JSON.stringify(value));
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
          renameSync(temp, this.path(id));
          const directory = openSync(this.dir, 'r');
          try {
            fsyncSync(directory);
          } finally {
            closeSync(directory);
          }
        }
        return value ?? current;
      },
      options,
    );
  }
  async delete(id: string, options?: AuthOperationOptions) {
    await this.locked(
      id,
      async () => {
        for (const path of [
          this.path(id),
          ...(id === 'anthropic' && this.dir === authDirectory() ? [credentialPath()] : []),
        ])
          try {
            unlinkSync(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
      },
      options,
    );
  }
}
export function providerModels(store: CredentialStore = new ProviderCredentialStore()) {
  return builtinModels({ credentials: store });
}
export function providerDeviceId(dir = authDirectory()): string {
  secureDirectory(dir);
  const path = join(dir, '.device-id');
  let value = privateRead(path);
  if (value === undefined) {
    const id = randomUUID();
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(fd, id);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    value = privateRead(path);
  }
  if (!value || !/^[a-f0-9-]{36}$/.test(value)) throw new Error('Invalid provider device identity');
  return value;
}
export async function loginProvider(
  id: string,
  type: 'api_key' | 'oauth',
  interaction: AuthInteraction,
) {
  providerId(id);
  try {
    return await providerModels().login(id, type, interaction, {
      agentName: 'Salaam',
      getDeviceId: () => providerDeviceId(),
    });
  } catch {
    throw new Error('Provider login failed or was cancelled; retry salaam auth login ' + id);
  }
}
// These are SDK configuration fields, never a general process environment inheritance.
const sdkEnvironment: Record<string, string[]> = {
  'amazon-bedrock': [
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'AWS_PROFILE',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_BEARER_TOKEN_BEDROCK',
    'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_CONFIG_FILE',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_ROLE_ARN',
    'AWS_ROLE_SESSION_NAME',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_CONTAINER_AUTHORIZATION_TOKEN',
    'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  ],
  'google-vertex': [
    'GOOGLE_CLOUD_PROJECT',
    'GCLOUD_PROJECT',
    'GOOGLE_CLOUD_LOCATION',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_API_KEY',
  ],
  azure: [
    'AZURE_OPENAI_BASE_URL',
    'AZURE_OPENAI_RESOURCE_NAME',
    'AZURE_OPENAI_API_VERSION',
    'AZURE_OPENAI_DEPLOYMENT_NAME_MAP',
  ],
};
export async function resolveProviderAuth(
  route: ProviderRoute,
  store?: CredentialStore,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AuthResult> {
  if (!store && route.provider === 'anthropic' && environment.ANTHROPIC_API_KEY)
    return { auth: { apiKey: validateApiKey(environment.ANTHROPIC_API_KEY) }, env: {} };
  const model = getProviderModel(route);
  if (!model) throw new Error('Pinned provider model missing');
  const baseContext = defaultProviderAuthContext();
  const ambient = {
    ...baseContext,
    env: async (name: string) => environment[name]?.trim() || undefined,
  };
  const context = {
      ...ambient,
      env: async (name: string) =>
        (await ambient.env(name)) ?? route.connection?.configuration[name],
    },
    captured: Record<string, string> = {};
  const models = builtinModels({
    credentials: store ?? new ProviderCredentialStore(),
    authContext: {
      ...context,
      async env(name) {
        const value = await context.env(name);
        if (value !== undefined) captured[name] = value;
        return value;
      },
    },
  });
  let result: AuthResult | undefined;
  try {
    result = await models.getAuth(model);
  } catch {
    throw new Error('Provider authentication failed; run salaam auth login ' + route.provider);
  }
  if (!result)
    throw new Error('Provider credentials missing. Run: salaam auth login ' + route.provider);
  for (const name of sdkEnvironment[route.provider] ?? [])
    if (
      !(
        route.provider === 'amazon-bedrock' &&
        result.auth.apiKey &&
        ![
          'AWS_REGION',
          'AWS_DEFAULT_REGION',
          'AWS_PROFILE',
          'AWS_CONFIG_FILE',
          'AWS_SHARED_CREDENTIALS_FILE',
        ].includes(name)
      ) &&
      (await context.env(name))
    )
      captured[name] = (await context.env(name))!;
  if (route.provider === 'amazon-bedrock') {
    captured.AWS_MAX_ATTEMPTS = '1';
    captured.AWS_SHARED_CREDENTIALS_FILE ??= join(homedir(), '.aws', 'credentials');
    captured.AWS_CONFIG_FILE ??= join(homedir(), '.aws', 'config');
    const configured = { ...captured, ...result.env };
    if (!configured.AWS_REGION && !configured.AWS_DEFAULT_REGION) {
      const files = await loadSharedConfigFiles({
        filepath: configured.AWS_SHARED_CREDENTIALS_FILE,
        configFilepath: configured.AWS_CONFIG_FILE,
      });
      const profile = configured.AWS_PROFILE ?? 'default';
      captured.AWS_REGION =
        files.configFile[profile]?.region ?? files.credentialsFile[profile]?.region ?? 'us-east-1';
    }
  }
  if (route.provider === 'google-vertex' && !result.auth.apiKey)
    captured.GOOGLE_APPLICATION_CREDENTIALS ??= join(
      homedir(),
      '.config/gcloud/application_default_credentials.json',
    );
  const allowed = new Set([
    ...Object.keys(captured),
    ...(sdkEnvironment[route.provider] ?? []),
    ...(route.provider.startsWith('cloudflare-')
      ? ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_GATEWAY_ID']
      : []),
  ]);
  const env = Object.fromEntries(
    Object.entries({ ...captured, ...result.env }).filter(([key]) => allowed.has(key)),
  );
  return { ...result, env };
}
