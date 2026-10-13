import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { run } from '../src/commands/create.ts';
import { git, ignoreGlobally, tempDir, tmpRepo, useOmp, useSandbox } from './helpers.ts';
import type { RepoFixture } from './helpers.ts';

const WITH_FILE = ['-c', 'protocol.file.allow=always'];

let repo: RepoFixture;
let mainSub: string;

/**
 * Gives the main checkout the submodule `lib/sub`, which holds the submodule `inner`, with an ignored `.env` in each. The branch
 * `feature/x` on `origin` records a newer commit of `lib/sub` than the main checkout has. Gives the commit of `lib/sub` in the main checkout.
 */
const addSubmodules = async (): Promise<string> => {
  const [sub, inner] = await Promise.all([tmpRepo('sub'), tmpRepo('inner')]);
  await git(sub.dir, ...WITH_FILE, 'submodule', '--quiet', 'add', inner.dir, 'inner');
  await git(sub.dir, 'commit', '--quiet', '-m', 'add inner');
  await git(repo.dir, ...WITH_FILE, 'submodule', '--quiet', 'add', sub.dir, 'lib/sub');
  await git(repo.dir, ...WITH_FILE, 'submodule', '--quiet', 'update', '--init', '--recursive');
  await git(repo.dir, 'commit', '--quiet', '-m', 'add sub');
  const cloned = await git(mainSub, 'rev-parse', 'HEAD');
  writeFileSync(path.join(mainSub, 'later.txt'), 'later\n');
  await git(mainSub, 'add', 'later.txt');
  await git(mainSub, 'commit', '--quiet', '-m', 'later');
  await git(repo.dir, 'commit', '--quiet', '-am', 'record later');
  await git(repo.dir, 'push', '--quiet', '--force', 'origin', 'HEAD:refs/heads/feature/x');
  await git(repo.dir, 'reset', '--quiet', '--hard', 'HEAD~1');
  await git(repo.dir, 'submodule', '--quiet', 'update', '--recursive');
  writeFileSync(path.join(mainSub, '.env'), 'BUILD=1\n');
  writeFileSync(path.join(mainSub, 'inner', '.env'), 'BUILD=2\n');
  return cloned;
};

describe('create command in omp clone mode with submodules', () => {
  beforeEach(async () => {
    useSandbox();
    repo = await tmpRepo('aoyama');
    mainSub = path.join(repo.dir, 'lib', 'sub');
    await ignoreGlobally('.env');
  });

  it('repairs the submodules that the clone copied: git works in them, at the recorded commits, with the cloned files kept', async () => {
    const base = tempDir('omp-wt');
    useOmp({ base, clone: true });
    const cloned = await addSubmodules();
    const target = path.join(base, 'aoyama', 'feature-x');
    const targetSub = path.join(target, 'lib', 'sub');
    await expect(run(['--repo', repo.dir, '--branch', 'feature/x', '--no-tab'])).resolves.toMatchObject({ path: target, status: 'created', warnings: [] });
    const [recorded, gitDir] = await Promise.all([git(target, 'rev-parse', 'HEAD:lib/sub'), git(target, 'rev-parse', '--absolute-git-dir')]);
    expect(recorded).not.toBe(cloned);
    await expect(
      Promise.all([
        git(target, 'status', '--porcelain'),
        git(targetSub, 'status', '--porcelain'),
        git(path.join(targetSub, 'inner'), 'status', '--porcelain'),
        git(targetSub, 'rev-parse', 'HEAD'),
        git(targetSub, 'rev-parse', '--absolute-git-dir'),
        git(mainSub, 'rev-parse', 'HEAD'),
      ]),
    ).resolves.toStrictEqual(['', '', '', recorded, `${path.join(gitDir.trim(), 'modules', 'lib', 'sub')}\n`, cloned]);
    expect([readFileSync(path.join(targetSub, '.env'), 'utf-8'), readFileSync(path.join(targetSub, 'inner', '.env'), 'utf-8')]).toStrictEqual(['BUILD=1\n', 'BUILD=2\n']);
  });
});
