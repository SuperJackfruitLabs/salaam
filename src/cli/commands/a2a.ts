import { resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { digest, object, call } from '../../core/index.js';
import {
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  fsyncSync,
} from 'node:fs';
import type { CliContext } from './context.js';

export const A2A_HELP = `salaam a2a credential PEER_ID --file NEW_OWNER_ONLY_FILE
salaam a2a discover --peer ID --endpoint URL --card-url URL --credential-file FILE --addresses IP[,IP] [--local]
salaam a2a pin --peer ID --endpoint URL --card-url URL --card-file REVIEWED_JSON --credential-file FILE --addresses IP[,IP] --skill SKILL [--tenant TENANT --files PATH[,PATH] --local]
salaam a2a peers
salaam a2a grant --assignment ID --peer ID --credential-file OWNER_ONLY_JSON [--tenant TENANT --skill SKILL] [--peer-client openclaw-2026.10.5]
salaam a2a inspect CHILD_ID
salaam a2a reconcile CHILD_ID --run-id EXACT_RUN_ID

Use --a2a-config FILE for outbound peers and --a2a-listen-config FILE for private
inbound one-use analysis grants. Peer credentials grant no human/operator powers.
Remote internal model usage and execution remain unobserved.`;

/** salaam a2a credential, discover, pin, grant and peers. */
export async function a2aCommand(ctx: CliContext): Promise<boolean> {
  const { args, option, socket, group, verb, id } = ctx;
  if (group === 'a2a' && verb === 'credential') {
    const file = option('--file');
    if (!id || !file) throw Error('Supply PEER_ID and --file NEW_OWNER_ONLY_FILE');
    const { a2aIdentity } = await import('../../a2a/peer.js');
    a2aIdentity(id);
    const path = resolve(file),
      value = { peer: id, token: randomBytes(32).toString('base64url') };
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(value) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    console.log(
      JSON.stringify(
        { peer: id, file: realpathSync(path), credential_digest: digest(value) },
        null,
        2,
      ),
    );
    return true;
  }
  if (group === 'a2a' && verb === 'discover') {
    const peer = option('--peer'),
      endpoint = option('--endpoint'),
      card_url = option('--card-url'),
      credential = option('--credential-file'),
      addresses = option('--addresses');
    if (!peer || !endpoint || !card_url || !credential || !addresses)
      throw Error('Supply --peer, --endpoint, --card-url, --credential-file and --addresses');
    const { privateJSON, validatePeer, A2AHttp } = await import('../../a2a/peer.js');
    const credential_file = realpathSync(resolve(credential)),
      value = privateJSON(credential_file);
    const pin = validatePeer({
      id: peer,
      endpoint,
      card_url,
      card_digest: digest(null),
      tenant: option('--tenant') ?? '',
      skill: 'pending-review',
      addresses: addresses.split(','),
      local: args.includes('--local'),
      credential_file,
      credential_digest: digest(value),
      files: [],
      retention: 'unknown',
      cancel: false,
      streaming: false,
    });
    console.log(JSON.stringify(await new A2AHttp(pin).request(card_url), null, 2));
    return true;
  }
  if (group === 'a2a' && verb === 'pin') {
    const peer = option('--peer'),
      endpoint = option('--endpoint'),
      cardFile = option('--card-file'),
      credential = option('--credential-file'),
      addresses = option('--addresses'),
      skill = option('--skill');
    if (!peer || !endpoint || !cardFile || !credential || !addresses || !skill)
      throw Error(
        'Supply --peer, --endpoint, --card-file, --credential-file, --addresses and --skill',
      );
    const { privateJSON, validatePeer, A2AHttp } = await import('../../a2a/peer.js');
    const card = JSON.parse(readFileSync(resolve(cardFile), 'utf8')),
      credential_file = realpathSync(resolve(credential)),
      value = privateJSON(credential_file),
      card_url = option('--card-url');
    if (!card_url) throw Error('Supply the exact --card-url that was reviewed');
    const pin = validatePeer({
      id: peer,
      endpoint,
      card_url,
      card_digest: digest(card),
      tenant: option('--tenant') ?? '',
      skill,
      addresses: addresses.split(','),
      local: args.includes('--local'),
      credential_file,
      credential_digest: digest(value),
      files: option('--files')?.split(',').filter(Boolean) ?? [],
      retention: option('--retention') ?? 'unknown',
      cancel: args.includes('--supports-cancel'),
      streaming: args.includes('--supports-streaming'),
    });
    new A2AHttp(pin).assertCard(card);
    console.log(JSON.stringify(pin, null, 2));
    return true;
  }
  if (group === 'a2a' && verb === 'grant') {
    const assignment = option('--assignment'),
      peer = option('--peer'),
      credential = option('--credential-file');
    if (!assignment || !peer || !credential)
      throw Error('Supply --assignment, --peer and --credential-file');
    const { privateJSON } = await import('../../a2a/peer.js');
    const credential_file = realpathSync(resolve(credential)),
      value = object(privateJSON(credential_file));
    if (
      value.peer !== peer ||
      Object.keys(value).sort().join(',') !== 'peer,token' ||
      typeof value.token !== 'string' ||
      !/^[A-Za-z0-9._~-]{32,512}$/.test(value.token)
    )
      throw Error('Use a dedicated peer credential JSON {peer,token}');
    const peerClient = option('--peer-client');
    if (peerClient && peerClient !== 'openclaw-2026.10.5')
      throw Error('Only the explicitly pinned OpenClaw client adapter is available');
    const binding = await call(socket, `/v1/a2a/grants/${encodeURIComponent(assignment)}`);
    console.log(
      JSON.stringify(
        {
          peer,
          tenant: option('--tenant') ?? '',
          skill: option('--skill') ?? 'review',
          assignment_id: assignment,
          binding_digest: digest(binding),
          credential_file,
          credential_digest: digest(value),
          ...(peerClient ? { client: peerClient } : {}),
        },
        null,
        2,
      ),
    );
    return true;
  }
  if (group === 'a2a' && verb === 'peers') {
    console.log(
      JSON.stringify(
        (await call<any[]>(socket, '/v1/harnesses')).filter((r) => r.kind === 'a2a'),
        null,
        2,
      ),
    );
    return true;
  }
  return false;
}
