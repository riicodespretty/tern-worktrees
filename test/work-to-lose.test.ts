import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { CliError } from '../src/proc.ts';
import { findWorkToLose, stopOnWorkToLose } from '../src/work-to-lose.ts';
import type { WorkToLose } from '../src/work-to-lose.ts';
import { git, ignoreGlobally, logGitCalls, readLog, tempDir, tmpRepo, useSandbox } from './helpers.ts';

const nestedSubmodules = async (): Promise<string> => {
  const inner = await tmpRepo('inner');
  const outer = await tmpRepo('outer');
  await git(outer.dir, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', inner.dir, 'inner');
  await git(outer.dir, 'commit', '--quiet', '-m', 'add inner');
  await git(outer.dir, 'push', '--quiet', 'origin', 'main');
  const repo = await tmpRepo();
  await git(repo.dir, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', outer.origin, 'outer');
  await git(repo.dir, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'update', '--init', '--recursive');
  await git(repo.dir, 'commit', '--quiet', '-m', 'add outer');
  return repo.dir;
};

const writeFiles = (dir: string, files: Record<string, Buffer | string>): void => {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }
};

/**
 * A worktree and a main checkout with ignored files: a copy with the same bytes (`key.pem`, and `full.bin` of two full chunks), a changed `.env`,
 * a file that only the worktree holds, a symbolic link, a file that is a directory in the main checkout, and a file with a different last chunk.
 */
const copiesOfMain = async (): Promise<{ dir: string; main: string }> => {
  await ignoreGlobally('.env', '*.pem', '*.bin', 'secrets');
  const chunk = 64 * 1024;
  const full = Buffer.alloc(chunk * 2, 7);
  const ragged = Buffer.alloc(chunk * 3 + 5, 9);
  const changed = Buffer.from(ragged);
  changed[changed.length - 1] = 0;
  const { dir } = await tmpRepo();
  const main = tempDir('main');
  writeFiles(main, { '.env': 'SECRET=1\n', 'full.bin': full, 'key.pem': 'KEY-A\n', 'ragged.bin': ragged, 'secrets/a': 'x\n' });
  writeFiles(dir, { '.env': 'SECRET=2\n', 'full.bin': full, 'key.pem': 'KEY-A\n', 'only.pem': 'KEY-B\n', 'ragged.bin': changed, 'secrets': '' });
  symlinkSync(path.join(main, 'key.pem'), path.join(dir, 'link.pem'));
  return { dir, main };
};

const thrown = (action: () => void): CliError | undefined => {
  try {
    action();
  } catch (error) {
    if (error instanceof CliError) {
      return error;
    }
    throw error;
  }
  return undefined;
};

describe('work to lose', () => {
  beforeEach(() => {
    useSandbox();
  });

  describe(findWorkToLose, () => {
    it('finds nothing in a clean worktree with pushed submodules', async () => {
      const dir = await nestedSubmodules();
      await expect(findWorkToLose(dir, null)).resolves.toStrictEqual({ changes: [], hardToRebuild: [] });
    });

    it('lists unpushed commits and changes at each submodule depth, and an ignored file as hard to rebuild', async () => {
      const dir = await nestedSubmodules();
      const outer = path.join(dir, 'outer');
      const nested = path.join(outer, 'inner');
      await git(nested, 'switch', '--quiet', '-c', 'work');
      await git(nested, 'commit', '--quiet', '--allow-empty', '-m', 'local only');
      const local = await git(nested, 'rev-parse', '--short', 'work');
      await git(nested, 'switch', '--quiet', '--detach', 'HEAD~1');
      writeFileSync(path.join(outer, 'new.txt'), 'x\n');
      await ignoreGlobally('secret.env');
      writeFileSync(path.join(outer, 'secret.env'), 'x\n');
      await expect(findWorkToLose(dir, null)).resolves.toStrictEqual({
        changes: [' M outer', 'outer: ?? new.txt', `outer/inner: unpushed ${local.trim()}`],
        hardToRebuild: ['outer/secret.env'],
      });
    });

    it('lists the commit of a detached submodule HEAD that no remote holds', async () => {
      const dir = await nestedSubmodules();
      const outer = path.join(dir, 'outer');
      await git(outer, 'commit', '--quiet', '--allow-empty', '-m', 'detached work');
      const head = await git(outer, 'rev-parse', '--short', 'HEAD');
      await expect(findWorkToLose(dir, null)).resolves.toStrictEqual({ changes: [' M outer', `outer: unpushed ${head.trim()}`], hardToRebuild: [] });
    });

    it('lists the submodules once', async () => {
      const dir = await nestedSubmodules();
      const log = await logGitCalls();
      await findWorkToLose(dir, dir);
      expect(readLog(log).filter(call => call.includes(' submodule foreach '))).toHaveLength(1);
    });

    it('raises git_failed when it cannot list the submodules', async () => {
      const dir = await nestedSubmodules();
      writeFileSync(path.join(dir, '.gitmodules'), '[submodule "outer"\n');
      const failure = findWorkToLose(dir, null);
      await expect(failure).rejects.toMatchObject({ code: 'git_failed' });
      await expect(failure).rejects.toThrow(/bad config line/u);
    });

    it('raises git_failed when it cannot read the commits of a submodule', async () => {
      const dir = await nestedSubmodules();
      await git(path.join(dir, 'outer'), 'symbolic-ref', 'HEAD', 'refs/heads/unborn');
      const failure = findWorkToLose(dir, null);
      await expect(failure).rejects.toMatchObject({ code: 'git_failed' });
      await expect(failure).rejects.toThrow(/unknown revision/u);
    });

    it('raises git_failed outside a repo', async () => {
      await expect(findWorkToLose(tempDir('plain'), null)).rejects.toMatchObject({ code: 'git_failed' });
      await expect(findWorkToLose(tempDir('plain'), tempDir('main'))).rejects.toMatchObject({ code: 'git_failed' });
    });

    it('lists each ignored file outside the rebuildable dirs as hard to rebuild, in submodules at each depth too', async () => {
      const dir = await nestedSubmodules();
      await ignoreGlobally(
        '.env*',
        '*.pem',
        'local.settings.json',
        'secrets/',
        'node_modules',
        'dist',
        'build',
        'coverage',
        '.DS_Store',
        '.cache',
        '.next',
        '.nuxt',
        '.output',
        '.turbo',
      );
      const rebuildable = [
        'node_modules/x/index.js',
        'dist/app.js',
        'build/a',
        'coverage/lcov.info',
        'src/.DS_Store',
        '.cache/c',
        '.next/n',
        '.nuxt/n',
        '.output/o',
        '.turbo/t',
        'outer/build/out.o',
        'outer/inner/.cache/c',
      ];
      const files = ['.env', 'secrets/a.pem', 'secrets/deep/b.txt', 'outer/.env.local', 'outer/inner/local.settings.json', ...rebuildable];
      writeFiles(dir, Object.fromEntries(files.map(file => [file, 'x\n'])));
      symlinkSync('missing', path.join(dir, '.env.link'));
      const work = await findWorkToLose(dir, null);
      expect(work.changes).toStrictEqual([]);
      expect(work.hardToRebuild.toSorted()).toStrictEqual(['.env', '.env.link', 'outer/.env.local', 'outer/inner/local.settings.json', 'secrets/a.pem', 'secrets/deep/b.txt']);
    });

    it('drops each copy with the bytes of the file at the same path in the main checkout', async () => {
      const { dir, main } = await copiesOfMain();
      const work = await findWorkToLose(dir, main);
      expect(work.changes).toStrictEqual([]);
      expect(work.hardToRebuild.toSorted()).toStrictEqual(['.env', 'link.pem', 'only.pem', 'ragged.bin', 'secrets']);
    });

    it('keeps each copy without a main checkout, because relocate carries them', async () => {
      const { dir } = await copiesOfMain();
      const work = await findWorkToLose(dir, null);
      expect(work.hardToRebuild.toSorted()).toStrictEqual(['.env', 'full.bin', 'key.pem', 'link.pem', 'only.pem', 'ragged.bin', 'secrets']);
    });

    it('closes each file it compares', async () => {
      const repo = await tmpRepo();
      const mainCheckout = tempDir('main');
      await ignoreGlobally('*.env');
      const names = Array.from({ length: 200 }, (_, index) => `${index}.env`);
      for (const name of names) {
        writeFileSync(path.join(repo.dir, name), `${name}\n`);
        writeFileSync(path.join(mainCheckout, name), `${name}\n`);
      }
      const openBefore = readdirSync('/dev/fd').length;
      await expect(findWorkToLose(repo.dir, mainCheckout)).resolves.toStrictEqual({ changes: [], hardToRebuild: [] });
      expect(readdirSync('/dev/fd').length - openBefore).toBeLessThan(names.length / 2);
    });
  });

  describe(stopOnWorkToLose, () => {
    const mixed: WorkToLose = { changes: [' M sub', 'sub: unpushed abc1234'], hardToRebuild: ['.env', 'sub/key.pem'] };

    it('does not throw when there is no work to lose', () => {
      expect(
        thrown(() => {
          stopOnWorkToLose('/wt/app/x', 'removing', { changes: [], hardToRebuild: [] });
        }),
      ).toBeUndefined();
    });

    it.each([
      ['removing', '/wt/app/x has work that removing it would lose'],
      ['recreating', '/wt/app/x has work that recreating it would lose'],
    ] as const)('throws dirty_worktree while %s, with the changes first and then the hard-to-rebuild files', (doing, message) => {
      const error = thrown(() => {
        stopOnWorkToLose('/wt/app/x', doing, mixed);
      });
      expect([error?.code, error?.message]).toStrictEqual(['dirty_worktree', message]);
      expect(error?.extra).toStrictEqual({
        changes: [' M sub', 'sub: unpushed abc1234'],
        existing: '/wt/app/x',
        files: [' M sub', 'sub: unpushed abc1234', '!! .env', '!! sub/key.pem'],
        hardToRebuild: ['.env', 'sub/key.pem'],
      });
    });

    it('throws on changes alone, and on hard-to-rebuild files alone', () => {
      const changesOnly = thrown(() => {
        stopOnWorkToLose('/wt/app/x', 'recreating', { changes: ['?? a'], hardToRebuild: [] });
      });
      const hardToRebuildOnly = thrown(() => {
        stopOnWorkToLose('/wt/app/x', 'removing', { changes: [], hardToRebuild: ['.env'] });
      });
      expect(changesOnly?.extra).toStrictEqual({ changes: ['?? a'], existing: '/wt/app/x', files: ['?? a'], hardToRebuild: [] });
      expect(hardToRebuildOnly?.extra).toStrictEqual({ changes: [], existing: '/wt/app/x', files: ['!! .env'], hardToRebuild: ['.env'] });
    });
  });
});
