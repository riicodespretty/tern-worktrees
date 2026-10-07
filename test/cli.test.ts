import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { CommandModule } from '../src/cli.ts';
import { checkCommandName, commandLoader, main } from '../src/cli.ts';
import { CliError, must } from '../src/proc.ts';
import type { Sandbox } from './helpers.ts';
import { REPO_DIR, spawnCli, tempDir, tmpRepo, useSandbox } from './helpers.ts';

interface Envelope {
  error: { code: string; message: string };
}

const envelope = (code: string, message: string): string => `${JSON.stringify({ error: { code, message } })}\n`;

const parseEnvelope = (stdout: string): Envelope =>
  // SAFETY: main prints the error envelope as one JSON line.
  JSON.parse(stdout) as Envelope;

const fixtures = commandLoader(
  async name =>
    // SAFETY: each module in `fixtures/commands/` exports `run(args)`.
    (await import(`./fixtures/commands/${name}.ts`)) as CommandModule,
);

const COMMANDS = readdirSync(path.join(REPO_DIR, 'src', 'commands')).map(file => path.basename(file, '.ts'));

let sandbox: Sandbox;

describe('cli', () => {
  beforeEach(() => {
    sandbox = useSandbox();
  });

  describe(checkCommandName, () => {
    it.each(['resolve', 'new-repo', 'x'])('accepts %s', name => {
      expect(checkCommandName(name)).toBe(name);
    });

    it.each(['Resolve', '../cli', 'nope1', '1nope', 'new_repo', ''])('rejects %j', name => {
      expect(() => checkCommandName(name)).toThrow(new CliError('bad_args', `unknown command ${name}`));
    });
  });

  describe(commandLoader, () => {
    it.each(['Resolve', '../cli', 'resolve.ts'])('never imports the name %j', async name => {
      const imported: string[] = [];
      const load = commandLoader(async moduleName => {
        imported.push(moduleName);
        return await fixtures('throw-error');
      });
      await expect(load(name)).rejects.toThrow(new CliError('bad_args', `unknown command ${name}`));
      expect(imported).toStrictEqual([]);
    });
  });

  describe(main, () => {
    it('prints the result of a command as one JSON line', async () => {
      const repo = await tmpRepo('demo');
      await expect(main(['resolve', repo.dir])).resolves.toStrictEqual({
        code: 0,
        stderr: '',
        stdout: `${JSON.stringify({ repos: [{ dir: repo.dir, name: 'demo', owner: null, root: repo.dir }] })}\n`,
      });
    });

    it.each(['nope', 'Resolve', '../cli', 'resolve.ts', ''])('rejects the command %j as unknown', async name => {
      const message = `unknown command ${name}`;
      await expect(main([name])).resolves.toStrictEqual({ code: 1, stderr: `${message}\n`, stdout: envelope('bad_args', message) });
    });

    it('rejects an empty argv as an unknown command', async () => {
      await expect(main([])).resolves.toStrictEqual({ code: 1, stderr: 'unknown command \n', stdout: envelope('bad_args', 'unknown command ') });
    });

    it.each(COMMANDS)('loads %s and turns an unknown option into bad_args', async name => {
      const result = await main([name, '--nope']);
      const { error } = parseEnvelope(result.stdout);
      expect([result.code, error.code]).toStrictEqual([1, 'bad_args']);
      expect(error.message).toContain("'--nope'");
    });

    it('fails every command with config_invalid on an invalid options file', async () => {
      writeFileSync(path.join(sandbox.pluginData, 'config.json'), JSON.stringify({ teardown: 'all' }));
      const results = await Promise.all([main(['resolve', '/tmp']), main(['nope'])]);
      expect(results.map(result => [result.code, parseEnvelope(result.stdout).error.code])).toStrictEqual([
        [1, 'config_invalid'],
        [1, 'config_invalid'],
      ]);
      expect(parseEnvelope(results[0]?.stdout ?? '').error.message).toContain('teardown: expected one of');
    });

    it('reports a command module that fails to load as unknown', async () => {
      await expect(main(['broken'], fixtures)).resolves.toStrictEqual({ code: 1, stderr: 'unknown command broken\n', stdout: envelope('bad_args', 'unknown command broken') });
    });

    it('puts the extra fields of a CliError into the envelope', async () => {
      await expect(main(['throw-cli-error'], fixtures)).resolves.toStrictEqual({
        code: 1,
        stderr: 'taken\n',
        stdout: `${JSON.stringify({ error: { code: 'path_conflict', message: 'taken', path: '/x' } })}\n`,
      });
    });

    it('reports any other error as git_failed', async () => {
      await expect(main(['throw-error'], fixtures)).resolves.toStrictEqual({ code: 1, stderr: 'boom\n', stdout: envelope('git_failed', 'boom') });
    });

    it('reports a thrown non-error as git_failed', async () => {
      await expect(main(['throw-non-error'], fixtures)).resolves.toStrictEqual({ code: 1, stderr: 'plain\n', stdout: envelope('git_failed', 'plain') });
    });

    it('keeps a TypeError that is not from parseArgs as git_failed', async () => {
      await expect(main(['throw-type-error'], fixtures)).resolves.toStrictEqual({ code: 1, stderr: 'odd\n', stdout: envelope('git_failed', 'odd') });
    });

    it('runs the bin/tern-wt shim end to end', () => {
      expect([spawnCli(['resolve', '/tmp']), spawnCli(['nope'])]).toStrictEqual([
        { status: 0, stderr: '', stdout: `${JSON.stringify({ repos: [{ dir: '/tmp', name: null, owner: null, root: null }] })}\n` },
        { status: 1, stderr: 'unknown command nope\n', stdout: envelope('bad_args', 'unknown command nope') },
      ]);
    });

    it('keeps the PATH of the caller ahead of the fallback dirs of the shim', async () => {
      const gitPath = await must(['sh', '-c', 'command -v git'], 'git_failed');
      const realGit = gitPath.trim();
      const home = tempDir('home');
      const fallbackBin = path.join(home, '.local', 'bin');
      mkdirSync(fallbackBin, { recursive: true });
      writeFileSync(path.join(fallbackBin, 'git'), `#!/bin/sh\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
      const callerBin = tempDir('caller-bin');
      const marker = path.join(callerBin, 'ran');
      writeFileSync(path.join(callerBin, 'git'), `#!/bin/sh\n: > '${marker}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
      vi.stubEnv('HOME', home);
      vi.stubEnv('PATH', `${callerBin}:${process.env.PATH ?? ''}`);
      expect(spawnCli(['resolve', '/tmp']).status).toBe(0);
      expect(existsSync(marker)).toBeTruthy();
    });
  });
});
