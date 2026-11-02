import { expect, test, vi } from 'vitest';
import { StationSystemd } from '../../src/agentpod/station-systemd.js';
import type { StationConfig } from '../../src/agentpod/station-config.js';
const id = 'a'.repeat(64),
  context = 'b'.repeat(64),
  invocation = 'c'.repeat(32);
function show(fields: Record<string, string> = {}) {
  return (
    Object.entries({
      ExecMainPID: '1234',
      ExecMainCode: '1',
      ExecMainStatus: '0',
      ControlGroup: '',
      Id: 'salaam-station-' + id + '.service',
      Description: 'Salaam station ' + context,
      LoadState: 'loaded',
      ActiveState: 'active',
      SubState: 'exited',
      InvocationID: invocation,
      ...fields,
    })
      .map(([k, v]) => k + '=' + v)
      .join('\n') + '\n'
  );
}
function fixture(stdout: string) {
  const runtime = new StationSystemd({
    systemctl: { path: '/synthetic/systemctl' },
  } as StationConfig);
  const command = vi.spyOn(runtime as any, 'command').mockResolvedValue({ stdout });
  return { runtime, command };
}
test('systemd255 active/exited observation retains invocation ownership after its empty cgroup is collected', async () => {
  const f = fixture(show());
  expect(await f.runtime.inspect(id, context)).toMatchObject({
    invocation,
    active: 'active',
    sub: 'exited',
    code: 1,
    status: 0,
    cgroup: '/system.slice/salaam-station-' + id + '.service',
  });
  // This is observation-codec coverage. Actual stop still requires the separate
  // kernel cgroup check, exercised by the Linux protected-station acceptance.
});
test('empty running cgroup, missing/replaced identity and foreign group refuse cleanup ownership', async () => {
  const rejected: Record<string, string>[] = [
    { SubState: 'running', ExecMainCode: '0' },
    { InvocationID: '' },
    { Description: 'foreign' },
    { ControlGroup: '/system.slice/foreign.service' },
    { SubState: 'exited', ExecMainCode: '0' },
  ];
  for (const fields of rejected) {
    const f = fixture(show(fields));
    await expect(f.runtime.inspect(id, context)).rejects.toThrow();
  }
  const f = fixture(show());
  await expect(
    f.runtime.stop(id, context, {
      id: 'salaam-station-' + id + '.service',
      description: context,
      invocation: 'd'.repeat(32),
      cgroup: '/system.slice/salaam-station-' + id + '.service',
      pid: 1234,
      active: 'active',
      sub: 'running',
      code: 0,
      status: 0,
    }),
  ).rejects.toThrow();
  expect(f.command).toHaveBeenCalledTimes(1);
});
