import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ROOT } from '../../core/index.js';
import { credentialPath, providerRoute } from '../../providers/index.js';
import type { CodeStart } from '../session-pick.js';
import { FormModal } from '../modals.js';
import { shortId } from '../theme.js';
import type { SessionContext } from './context.js';

// Starting the service, and Ctrl+N and Ctrl+P: the form for a new session and the list of your
// sessions; `salaam code` opens this folder's session directly.

const SERVICE_START_TIMEOUT_MS = 20_000;
const SERVICE_START_OUTPUT = 65_536;

export async function startService(ctx: SessionContext): Promise<void> {
  await ctx.client.list();
  if (ctx.client.connection === 'connected') return;
  if (
    !ctx.selectedRoute &&
    (existsSync(credentialPath()) || existsSync(credentialPath() + '.json'))
  )
    ctx.selectedRoute = providerRoute('anthropic');
  const provider = 'offline';
  await promisify(execFile)(
    process.execPath,
    [
      join(ROOT, 'bin/salaam.mjs'),
      'service',
      'start',
      '--state',
      ctx.options.state,
      '--provider',
      provider,
      ...(ctx.options.codingRoot ? ['--coding-root', resolve(ctx.options.codingRoot)] : []),
      ...(ctx.options.codingSocket ? ['--coding-socket', resolve(ctx.options.codingSocket)] : []),
    ],
    { timeout: SERVICE_START_TIMEOUT_MS, maxBuffer: SERVICE_START_OUTPUT },
  );
  await ctx.client.list();
  if (ctx.client.connection === 'offline')
    throw new Error('Service did not become available. Inspect sal service status.');
}

/** The new-session form: a folder, and for a plain session whether it gets a coding workspace. */
export async function newSessionForm(ctx: SessionContext, localCoding = false): Promise<void> {
  await ctx.startService();
  ctx.showModal(
    new FormModal(
      (localCoding ? 'New coding session · reviewed edits and commands · ' : 'New session · ') +
        (ctx.selectedRoute?.model ?? ctx.client.health?.provider_route.model ?? 'default'),
      ctx.options.cwd ?? ctx.client.snapshot?.cwd ?? process.cwd(),
      ctx.view.theme,
      !localCoding && !!ctx.client.health?.coding_root,
      () => ctx.tui.requestRender(),
      () => ctx.closeModal(),
      (cwd, coding) => {
        ctx.closeModal();
        void ctx.execute(async () => {
          await ctx.client.create(resolve(cwd), coding, ctx.selectedRoute, localCoding);
          ctx.setTab('conversation');
        });
      },
    ),
  );
}
/** Your sessions, this folder's first, with a new session at the top. */
export async function sessionPicker(ctx: SessionContext): Promise<void> {
  const { pickerOrder, sessionDescription } = await import('../session-pick.js');
  await ctx.client.list();
  const now = Date.now();
  ctx.choice(
    'Your Salaam sessions',
    [
      { value: 'new', label: '+ New session', description: 'Start a fresh workspace' },
      ...pickerOrder(ctx.client.sessions, resolve(ctx.options.cwd ?? process.cwd())).map(
        (session) => ({
          value: session.id,
          label:
            (ctx.client.names[session.id] ?? basename(session.cwd)) + '  ' + shortId(session.id),
          description: sessionDescription(session, now),
        }),
      ),
    ],
    (value) => {
      if (value === 'transcript') {
        ctx.view.transcript = !ctx.view.transcript;
        ctx.setTab('conversation');
        return;
      }
      if (value === 'model') ctx.modelPicker();
      else if (value === 'help') void ctx.execute(() => ctx.runSlashCommand('help'));
      else if (value === 'coding') void ctx.execute(() => ctx.newSession(true));
      else if (value === 'new') void ctx.execute(() => ctx.newSession());
      else
        void ctx.execute(async () => {
          await ctx.client.open(value, {
            observe: ctx.options.observe,
            takeover: ctx.options.takeover,
          });
          ctx.setTab('conversation');
        });
    },
  );
}
/** One command for this folder: start the service if needed, then continue the folder's
 * latest session, start a new coding session in it, or show the session list. */
export async function openHere(ctx: SessionContext, start: CodeStart): Promise<void> {
  const { latestSessionFor, deskUsesAnthropic } = await import('../session-pick.js');
  await ctx.startService();
  if (
    deskUsesAnthropic(
      !!ctx.selectedRoute,
      ctx.client.health?.provider_route.provider,
      existsSync(credentialPath()) || existsSync(credentialPath() + '.json'),
    )
  )
    ctx.selectedRoute = providerRoute('anthropic');
  if (start === 'resume') return ctx.sessions();
  const cwd = resolve(ctx.options.cwd ?? process.cwd());
  const existing = start === 'continue' ? latestSessionFor(ctx.client.sessions, cwd) : undefined;
  if (existing)
    await ctx.client.open(existing, {
      observe: ctx.options.observe,
      takeover: ctx.options.takeover,
    });
  else {
    await ctx.client.create(cwd, false, ctx.selectedRoute, true);
    if (start === 'continue')
      ctx.client.notice = 'No earlier session in this folder, so this is a new one.';
  }
  ctx.setTab('conversation');
}
