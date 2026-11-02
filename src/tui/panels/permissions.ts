import type { PermissionMode } from '../../local/index.js';
import { nextMode } from '../../local/index.js';
import { TextModal } from '../modals.js';
import { approvalRules } from './approvals.js';
import type { PanelContext } from './context.js';

// The session's permissions: the mode on the status line, Shift+Tab's cycle, full access, YOLO,
// and /permissions.

/** Phase 2b: the session's mode and full access, for the status line. */
export async function loadMode(ctx: PanelContext): Promise<void> {
  if (!ctx.client.snapshot) {
    ctx.view.mode = undefined;
    return;
  }
  const current = await ctx.client.permissions();
  ctx.view.mode =
    current.configurable && current.coding
      ? {
          mode: current.policy.mode,
          ...(current.policy.access ? { access: current.policy.access } : {}),
          ...(current.command_sandbox ? { sandbox: current.command_sandbox } : {}),
        }
      : undefined;
  ctx.tui.requestRender();
}
/** Shift+Tab: review → accept edits → auto. Full access and YOLO are kept as they are; each has
 * its own command. */
export async function cycleMode(ctx: PanelContext): Promise<void> {
  const session = ctx.client.snapshot?.id;
  if (!session) throw new Error('Open a session first.');
  const current = await ctx.client.permissions();
  if (!current.configurable || !current.coding)
    throw new Error('Modes are for local coding sessions. No session or files were changed.');
  await ctx.client.setPermissions(session, current.policy.revision, {
    mode: nextMode(current.policy.mode),
    paths: [],
    ...(current.policy.access ? { access: current.policy.access } : {}),
  });
  await loadMode(ctx);
}
async function setAccess(ctx: PanelContext, access: 'full' | 'yolo' | undefined): Promise<void> {
  const session = ctx.client.snapshot!.id;
  const current = await ctx.client.permissions();
  await ctx.client.setPermissions(session, current.policy.revision, {
    mode: current.policy.mode,
    paths: current.policy.paths,
    ...(access ? { access } : {}),
  });
  await loadMode(ctx);
}
/** Full access on (with a warning and a confirm) or off (at once). From YOLO it steps down at once. */
export async function fullAccess(ctx: PanelContext): Promise<void> {
  const session = ctx.client.snapshot?.id;
  if (!session) throw new Error('Open a session first.');
  const current = await ctx.client.permissions();
  if (!current.configurable || !current.coding)
    throw new Error('Full access is for local coding sessions. Nothing was changed.');
  if (current.policy.access === 'full') return setAccess(ctx, undefined);
  if (current.full_access_allowed === false)
    throw new Error(
      'The operator does not allow full access on this host. Commands stay in the OS sandbox.',
    );
  if (current.policy.access === 'yolo') return setAccess(ctx, 'full');
  ctx.confirm(
    'Turn on full access?',
    'Later commands in this session run WITHOUT the OS sandbox: they can read and change any file your user can, and reach the network directly. They run without asking, except commands the danger check calls dangerous (force pushes, deletes, publishing, credentials, anything it cannot read), which still ask and say why. Run /full-access again to turn it off.',
    'turn on full access',
    () => setAccess(ctx, 'full'),
  );
}
/** YOLO on only after the person types "yolo"; off at once. Never in the Shift+Tab cycle. */
export async function yolo(ctx: PanelContext): Promise<void> {
  const session = ctx.client.snapshot?.id;
  if (!session) throw new Error('Open a session first.');
  const current = await ctx.client.permissions();
  if (!current.configurable || !current.coding)
    throw new Error('YOLO is for local coding sessions. Nothing was changed.');
  if (current.policy.access === 'yolo') return setAccess(ctx, undefined);
  if (current.yolo_allowed === false)
    throw new Error(
      'YOLO is not allowed for this session: it is only for your own desk sessions on a host whose operator allows it.',
    );
  ctx.taskInput(
    'Turn on YOLO? Type yolo to confirm',
    '',
    'Type yolo',
    'NO approvals at all: every edit and command runs at once, without the OS sandbox, including force pushes, deletes and publishing. Each one is recorded. /yolo again turns it off.',
    (value) => {
      if (value.trim() !== 'yolo') {
        ctx.client.report('YOLO stays off: the confirmation was not "yolo".');
        return;
      }
      void ctx.execute(() => setAccess(ctx, 'yolo'));
    },
  );
}
export async function permissionControls(ctx: PanelContext): Promise<void> {
  const session = ctx.client.snapshot!.id;
  const current = await ctx.client.permissions();
  if (!current.configurable) {
    ctx.showText(
      'Managed permissions',
      'This session uses host-managed authority. Local permission presets cannot change station or specialist grants.',
    );
    return;
  }
  ctx.choice(
    'Permissions · ' + current.policy.mode + ' · revision ' + current.policy.revision,
    [
      {
        value: 'inspect-current',
        label: 'Inspect current policy',
        description: current.policy.paths.join(', ') || 'No automatic edit scopes',
      },
      {
        value: 'inspect',
        label: 'Inspect only',
        description: 'Deny future local mutations, including manually approved operations',
      },
      ...(current.coding
        ? [
            {
              value: 'rules',
              label: 'Approval rules',
              description: 'Allow, ask or deny by command words and path globs',
            },
            {
              value: 'review',
              label: 'Review every mutation',
              description: 'Explicit approval for each edit and shell command',
            },
            {
              value: 'scoped-edit',
              label: 'Auto-approve scoped edits',
              description: 'Exact files or directory prefixes; shell commands still ask',
            },
          ]
        : []),
    ],
    (mode) => {
      if (mode === 'rules') {
        void ctx.execute(() => approvalRules(ctx));
        return;
      }
      if (mode === 'inspect-current') {
        ctx.showText('Permissions and execution boundary', JSON.stringify(current, null, 2));
        return;
      }
      const apply = (paths: string[]) =>
        ctx.showModal(
          new TextModal(
            'Review permission policy',
            `Session ${session}\nWorkspace ${current.policy.root}\nMode ${mode}\nAuto-edit paths: ${paths.join(', ') || '(none)'}\nCommands ask unless an approval rule or the session mode allows them (auto allows only sandboxed commands; full access allows all but dangerous ones; YOLO allows everything). Commands run in the host OS sandbox unless full access or YOLO is on. Progression and budgets remain unchanged. Already-running commands are not stopped.`,
            ctx.view.theme,
            () => ctx.terminal.rows,
            () => ctx.tui.requestRender(),
            () => ctx.closeModal(),
            undefined,
            () => {
              ctx.closeModal();
              void ctx.execute(() =>
                ctx.client.setPermissions(session, current.policy.revision, {
                  mode: mode as PermissionMode,
                  paths,
                }),
              );
            },
            'save permissions',
          ),
        );
      if (mode === 'scoped-edit')
        ctx.taskInput(
          'Auto-edit scopes',
          current.policy.paths.join(', '),
          'Comma-separated files or directories ending in /',
          'Example: src/, test/, README.md. No glob patterns or private paths. Other files still require review.',
          (text) =>
            apply(
              text
                .split(',')
                .map((p) => p.trim())
                .filter(Boolean),
            ),
        );
      else apply([]);
    },
  );
}
