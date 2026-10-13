import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { CliError } from '../src/proc.ts';
import { guardWorkToLose } from '../src/work-to-lose.ts';
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
 * a file that only the worktree holds, a symbolic link to the file at the same path in the main checkout, a file that is a directory in the main
 * checkout, and a file with a different last chunk.
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
  writeFiles(main, { '.env': 'SECRET=1\n', 'full.bin': full, 'key.pem': 'KEY-A\n', 'link.pem': 'KEY-A\n', 'ragged.bin': ragged, 'secrets/a': 'x\n' });
  writeFiles(dir, { '.env': 'SECRET=2\n', 'full.bin': full, 'key.pem': 'KEY-A\n', 'only.pem': 'KEY-B\n', 'ragged.bin': changed, 'secrets': '' });
  symlinkSync(path.join(main, 'link.pem'), path.join(dir, 'link.pem'));
  return { dir, main };
};

const rejection = async (promise: Promise<unknown>): Promise<CliError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CliError) {
      return error;
    }
    throw error;
  }
  throw new Error('the promise resolved');
};

describe('work to lose', () => {
  beforeEach(() => {
    useSandbox();
  });

  describe(guardWorkToLose, () => {
    it('resolves no files for either operation in a clean worktree with pushed submodules', async () => {
      const dir = await nestedSubmodules();
      await expect(guardWorkToLose(dir, 'recreating')).resolves.toStrictEqual([]);
      await expect(guardWorkToLose(dir, { removing: tempDir('main') })).resolves.toStrictEqual([]);
    });

    it('stops both operations on unpushed commits and changes at each submodule depth, and stops teardown also on an ignored file', async () => {
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
      const changes = [' M outer', 'outer: ?? new.txt', `outer/inner: unpushed ${local.trim()}`];
      const recreating = await rejection(guardWorkToLose(dir, 'recreating'));
      expect([recreating.code, recreating.message]).toStrictEqual(['dirty_worktree', `${dir} has work that recreating it would lose`]);
      expect(recreating.extra).toStrictEqual({ changes, existing: dir, files: changes, hardToRebuild: [] });
      const removing = await rejection(guardWorkToLose(dir, { removing: tempDir('main') }));
      expect([removing.code, removing.message]).toStrictEqual(['dirty_worktree', `${dir} has work that removing it would lose`]);
      expect(removing.extra).toStrictEqual({ changes, existing: dir, files: [...changes, '!! outer/secret.env'], hardToRebuild: ['outer/secret.env'] });
    });

    it('stops on the commit of a detached submodule HEAD that no remote holds', async () => {
      const dir = await nestedSubmodules();
      const outer = path.join(dir, 'outer');
      await git(outer, 'commit', '--quiet', '--allow-empty', '-m', 'detached work');
      const head = await git(outer, 'rev-parse', '--short', 'HEAD');
      const error = await rejection(guardWorkToLose(dir, 'recreating'));
      expect(error.extra).toStrictEqual({
        changes: [' M outer', `outer: unpushed ${head.trim()}`],
        existing: dir,
        files: [' M outer', `outer: unpushed ${head.trim()}`],
        hardToRebuild: [],
      });
    });

    it('lists the submodules once', async () => {
      const dir = await nestedSubmodules();
      const log = await logGitCalls();
      await guardWorkToLose(dir, { removing: dir });
      expect(readLog(log).filter(call => call.includes(' submodule foreach '))).toHaveLength(1);
    });

    it('raises git_failed when it cannot list the submodules', async () => {
      const dir = await nestedSubmodules();
      writeFileSync(path.join(dir, '.gitmodules'), '[submodule "outer"\n');
      const failure = guardWorkToLose(dir, 'recreating');
      await expect(failure).rejects.toMatchObject({ code: 'git_failed' });
      await expect(failure).rejects.toThrow(/bad config line/u);
    });

    it('raises git_failed when it cannot read the commits of a submodule', async () => {
      const dir = await nestedSubmodules();
      await git(path.join(dir, 'outer'), 'symbolic-ref', 'HEAD', 'refs/heads/unborn');
      const failure = guardWorkToLose(dir, 'recreating');
      await expect(failure).rejects.toMatchObject({ code: 'git_failed' });
      await expect(failure).rejects.toThrow(/unknown revision/u);
    });

    it('raises git_failed outside a repo', async () => {
      await expect(guardWorkToLose(tempDir('plain'), 'recreating')).rejects.toMatchObject({ code: 'git_failed' });
      await expect(guardWorkToLose(tempDir('plain'), { removing: tempDir('main') })).rejects.toMatchObject({ code: 'git_failed' });
    });

    it('gives relocate each ignored file outside the rebuildable dirs to carry, in submodules at each depth too', async () => {
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
      const carried = await guardWorkToLose(dir, 'recreating');
      expect(carried.toSorted()).toStrictEqual(['.env', '.env.link', 'outer/.env.local', 'outer/inner/local.settings.json', 'secrets/a.pem', 'secrets/deep/b.txt']);
    });

    it('does not stop teardown on a copy with the same bytes as the file at the same path in the main checkout', async () => {
      const { dir, main } = await copiesOfMain();
      const error = await rejection(guardWorkToLose(dir, { removing: main }));
      // SAFETY: guardWorkToLose sets `hardToRebuild` to the string[] of blocking files.
      const hardToRebuild = error.extra.hardToRebuild as string[];
      expect(hardToRebuild.toSorted()).toStrictEqual(['.env', 'link.pem', 'only.pem', 'ragged.bin', 'secrets']);
      expect(error.extra).toStrictEqual({ changes: [], existing: dir, files: hardToRebuild.map(file => `!! ${file}`), hardToRebuild });
    });

    it('does not stop teardown on a copy with the same bytes as the file at the same path in the main checkout, in submodules at each depth too', async () => {
      const dir = await nestedSubmodules();
      await ignoreGlobally('.env.local');
      const main = tempDir('main');
      writeFiles(main, { 'outer/.env.local': 'SECRET=1\n', 'outer/inner/.env.local': 'SECRET=1\n' });
      writeFiles(dir, { 'outer/.env.local': 'SECRET=1\n', 'outer/inner/.env.local': 'SECRET=2\n' });
      const error = await rejection(guardWorkToLose(dir, { removing: main }));
      expect(error.extra).toStrictEqual({ changes: [], existing: dir, files: ['!! outer/inner/.env.local'], hardToRebuild: ['outer/inner/.env.local'] });
    });

    it('gives relocate each copy to carry', async () => {
      const { dir } = await copiesOfMain();
      const carried = await guardWorkToLose(dir, 'recreating');
      expect(carried.toSorted()).toStrictEqual(['.env', 'full.bin', 'key.pem', 'link.pem', 'only.pem', 'ragged.bin', 'secrets']);
    });

    it('stops relocate on changes alone, and teardown on a hard-to-rebuild file alone', async () => {
      const repo = await tmpRepo();
      writeFileSync(path.join(repo.dir, 'a'), 'x\n');
      const changesOnly = await rejection(guardWorkToLose(repo.dir, 'recreating'));
      expect(changesOnly.extra).toStrictEqual({ changes: ['?? a'], existing: repo.dir, files: ['?? a'], hardToRebuild: [] });
      const other = await tmpRepo('other');
      await ignoreGlobally('.env');
      writeFileSync(path.join(other.dir, '.env'), 'SECRET=1\n');
      const hardToRebuildOnly = await rejection(guardWorkToLose(other.dir, { removing: tempDir('main') }));
      expect(hardToRebuildOnly.extra).toStrictEqual({ changes: [], existing: other.dir, files: ['!! .env'], hardToRebuild: ['.env'] });
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
      await expect(guardWorkToLose(repo.dir, { removing: mainCheckout })).resolves.toStrictEqual([]);
      expect(readdirSync('/dev/fd').length - openBefore).toBeLessThan(names.length / 2);
    });
  });
});
