import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { run as clone } from '../src/commands/clone.ts';
import { run as newRepo } from '../src/commands/new-repo.ts';
import { run as repos } from '../src/commands/repos.ts';
import type { Sandbox } from './helpers.ts';
import { ghFixture, ghLog, git, logGitCalls, readLog, tempDir, useSandbox } from './helpers.ts';

const LIST_ARGS = ['--limit', '200', '--json', 'nameWithOwner,isPrivate,description'];

let sandbox: Sandbox;
let cloneRoot: string;

const initRepo = async (dir: string, origin?: string): Promise<void> => {
  mkdirSync(dir, { recursive: true });
  await git(dir, 'init', '--quiet');
  if (origin !== undefined) {
    await git(dir, 'remote', 'add', 'origin', origin);
  }
};

const useLinkedCloneRoot = (): string => {
  const linked = path.join(tempDir('link'), 'clones');
  symlinkSync(cloneRoot, linked);
  writeFileSync(path.join(sandbox.pluginData, 'config.json'), JSON.stringify({ cloneRoot: linked }));
  return linked;
};

describe('GitHub repo commands', () => {
  beforeEach(() => {
    sandbox = useSandbox();
    cloneRoot = tempDir('clones');
    writeFileSync(path.join(sandbox.pluginData, 'config.json'), JSON.stringify({ cloneRoot }));
  });

  describe(repos, () => {
    const meRepos = [
      { description: 'Main app', isPrivate: true, nameWithOwner: 'me/aoyama' },
      { description: '', isPrivate: false, nameWithOwner: 'me/other' },
    ];
    const acmeRepos = [{ description: 'Tool', isPrivate: false, nameWithOwner: 'acme/tool' }];

    beforeEach(() => {
      ghFixture(['api', 'user', '--jq', '.login'], 'me\n');
      ghFixture(['org', 'list'], 'acme\n\n');
      ghFixture(['repo', 'list', 'me', ...LIST_ARGS], JSON.stringify(meRepos));
    });

    it('lists the repos of the user and each org, and marks local clones', async () => {
      ghFixture(['repo', 'list', 'acme', ...LIST_ARGS], JSON.stringify(acmeRepos));
      await initRepo(path.join(cloneRoot, 'me', 'aoyama'));
      await initRepo(path.join(cloneRoot, 'acme'));
      mkdirSync(path.join(cloneRoot, 'acme', 'tool'));
      await expect(repos([])).resolves.toStrictEqual({
        owners: ['me', 'acme'],
        repos: [
          { description: 'Main app', isPrivate: true, local: path.join(cloneRoot, 'me', 'aoyama'), nameWithOwner: 'me/aoyama' },
          { description: '', isPrivate: false, local: null, nameWithOwner: 'me/other' },
          { description: 'Tool', isPrivate: false, local: null, nameWithOwner: 'acme/tool' },
        ],
        warnings: [],
      });
    });

    it('marks a local clone when the clone root is a symbolic link', async () => {
      const linked = useLinkedCloneRoot();
      await initRepo(path.join(cloneRoot, 'me', 'aoyama'));
      const result = await repos([]);
      expect(result.repos.map(repo => repo.local)).toStrictEqual([path.join(linked, 'me', 'aoyama'), null]);
    });

    it('drops an org whose repo list fails', async () => {
      await expect(repos([])).resolves.toStrictEqual({
        owners: ['me'],
        repos: meRepos.map(repo => ({ ...repo, local: null })),
        warnings: ['repo list acme failed: fake gh: no fixture'],
      });
    });

    it('lists only the user when the user has no orgs', async () => {
      ghFixture(['org', 'list'], '');
      await expect(repos([])).resolves.toStrictEqual({
        owners: ['me'],
        repos: meRepos.map(repo => ({ ...repo, local: null })),
        warnings: [],
      });
    });

    it('warns when gh cannot list the orgs', async () => {
      rmSync(path.join(sandbox.ghDir, 'org_list.json'));
      await expect(repos([])).resolves.toStrictEqual({
        owners: ['me'],
        repos: meRepos.map(repo => ({ ...repo, local: null })),
        warnings: ['org list failed: fake gh: no fixture'],
      });
    });

    it('raises gh_failed when gh cannot read the user login', async () => {
      rmSync(path.join(sandbox.ghDir, 'api_user_--jq_.login.json'));
      await expect(repos([])).rejects.toMatchObject({ code: 'gh_failed', message: 'fake gh: no fixture' });
    });

    it('runs git only for dirs present under the clone root', async () => {
      await initRepo(path.join(cloneRoot, 'me', 'aoyama'));
      const log = await logGitCalls();
      await repos([]);
      expect(readLog(log)).toHaveLength(1);
    });

    it('rejects positional arguments', async () => {
      await expect(repos(['extra'])).rejects.toMatchObject({ code: 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL' });
    });
  });

  describe(clone, () => {
    it('reuses a clone whose origin matches and runs no gh', async () => {
      const dest = path.join(cloneRoot, 'me', 'x');
      await initRepo(dest, 'git@github.com:me/x.git');
      await expect(clone(['me/x'])).resolves.toStrictEqual({ cloned: false, root: dest });
      expect(ghLog()).toStrictEqual([]);
    });

    it('reuses a matching clone when the clone root is a symbolic link', async () => {
      const linked = useLinkedCloneRoot();
      await initRepo(path.join(cloneRoot, 'me', 'x'), 'git@github.com:me/x.git');
      await expect(clone(['me/x'])).resolves.toStrictEqual({ cloned: false, root: path.join(linked, 'me', 'x') });
      expect(ghLog()).toStrictEqual([]);
    });

    it.each([
      ['a repo with another origin', 'git@github.com:me/y.git'],
      ['a repo without an origin', undefined],
    ])('raises path_conflict on %s', async (_label, origin) => {
      const dest = path.join(cloneRoot, 'me', 'x');
      await initRepo(dest, origin);
      await expect(clone(['me/x'])).rejects.toMatchObject({ code: 'path_conflict', extra: { path: dest } });
      expect(ghLog()).toStrictEqual([]);
    });

    it('raises path_conflict on a plain dir and on a dir inside another repo', async () => {
      const plain = path.join(cloneRoot, 'me', 'x');
      mkdirSync(plain, { recursive: true });
      await expect(clone(['me/x'])).rejects.toMatchObject({ code: 'path_conflict', extra: { path: plain } });
      await initRepo(path.join(cloneRoot, 'acme'), 'git@github.com:acme/tool.git');
      const nested = path.join(cloneRoot, 'acme', 'tool');
      mkdirSync(nested);
      await expect(clone(['acme/tool'])).rejects.toMatchObject({ code: 'path_conflict', message: `${nested} exists and is not a clone of acme/tool` });
    });

    it('clones a missing repo into the clone root', async () => {
      const dest = path.join(cloneRoot, 'me', 'x');
      ghFixture(['repo', 'clone', 'me/x', dest], '');
      await expect(clone(['me/x'])).resolves.toStrictEqual({ cloned: true, root: dest });
      expect(ghLog()).toStrictEqual([`repo clone me/x ${dest}`]);
      expect(existsSync(path.dirname(dest))).toBeTruthy();
    });

    it('raises gh_failed when the clone fails', async () => {
      await expect(clone(['me/x'])).rejects.toMatchObject({ code: 'gh_failed', message: 'fake gh: no fixture' });
    });

    it('makes the clone root and the owner dir when they are missing', async () => {
      const nestedRoot = path.join(cloneRoot, 'deep', 'clones');
      writeFileSync(path.join(sandbox.pluginData, 'config.json'), JSON.stringify({ cloneRoot: nestedRoot }));
      const dest = path.join(nestedRoot, 'me', 'x');
      ghFixture(['repo', 'clone', 'me/x', dest], '');
      await expect(clone(['me/x'])).resolves.toStrictEqual({ cloned: true, root: dest });
      expect(existsSync(path.dirname(dest))).toBeTruthy();
    });

    it.each([
      [[]],
      [['me']],
      [['me/x/y']],
      [['/x']],
      [['me/']],
      [['me/x', 'me/y']],
      [['../x']],
      [['x/..']],
      [['../..']],
      [['./x']],
      [['me/.']],
      [['me/..']],
      [['.me/x']],
      [['--', '-me/x']],
      [['me/-x']],
      [['--', '--depth=1/x']],
      [['me/x y']],
    ])('raises bad_args on %j and runs no gh', async args => {
      await expect(clone(args)).rejects.toMatchObject({ code: 'bad_args', message: 'clone needs one <owner/name>' });
      expect(ghLog()).toStrictEqual([]);
    });

    it.each([
      ['my-org.1/repo_name.js', 'my-org.1', 'repo_name.js'],
      ['me/.github', 'me', '.github'],
      ['me/_x', 'me', '_x'],
    ])('accepts %s', async (nameWithOwner, owner, name) => {
      const dest = path.join(cloneRoot, owner, name);
      ghFixture(['repo', 'clone', nameWithOwner, dest], '');
      await expect(clone([nameWithOwner])).resolves.toStrictEqual({ cloned: true, root: dest });
    });
  });

  describe(newRepo, () => {
    it.each(['private', 'public'])('creates a %s repo and clones it', async visibility => {
      const dest = path.join(cloneRoot, 'me', 'x');
      ghFixture(['repo', 'create', 'me/x', `--${visibility}`, '--add-readme'], '');
      ghFixture(['repo', 'clone', 'me/x', dest], '');
      await expect(newRepo(['me/x', '--visibility', visibility])).resolves.toStrictEqual({ nameWithOwner: 'me/x', root: dest });
      expect(ghLog()).toStrictEqual([`repo create me/x --${visibility} --add-readme`, `repo clone me/x ${dest}`]);
    });

    it('raises gh_failed with the gh message when the create fails', async () => {
      await expect(newRepo(['me/x', '--visibility', 'private'])).rejects.toMatchObject({ code: 'gh_failed', message: 'fake gh: no fixture' });
      expect(ghLog()).toHaveLength(1);
    });

    it.each([
      [['me/x', '--visibility', 'secret'], 'new-repo needs --visibility private or public'],
      [['me/x'], 'new-repo needs --visibility private or public'],
      [['mex', '--visibility', 'private'], 'new-repo needs one <owner/name>'],
      [['--visibility', 'private'], 'new-repo needs one <owner/name>'],
      [['../evil', '--visibility', 'private'], 'new-repo needs one <owner/name>'],
      [['--visibility', 'private', '--', '--template=evil/x'], 'new-repo needs one <owner/name>'],
    ])('raises bad_args on %j', async (args, message) => {
      await expect(newRepo(args)).rejects.toMatchObject({ code: 'bad_args', message });
      expect(ghLog()).toStrictEqual([]);
    });

    it('raises path_conflict before it creates the GitHub repo when the clone path is taken', async () => {
      const dest = path.join(cloneRoot, 'me', 'x');
      mkdirSync(dest, { recursive: true });
      ghFixture(['repo', 'create', 'me/x', '--private', '--add-readme'], '');
      await expect(newRepo(['me/x', '--visibility', 'private'])).rejects.toMatchObject({ code: 'path_conflict', extra: { path: dest } });
      expect(ghLog()).toStrictEqual([]);
    });
  });
});
