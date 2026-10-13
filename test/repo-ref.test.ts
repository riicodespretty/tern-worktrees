import { describe, expect, it } from 'vite-plus/test';
import { nameWithOwner, parseGithubUrl, repoKey } from '../src/repo-ref.ts';

describe(nameWithOwner, () => {
  it('joins the owner and the name', () => {
    expect(nameWithOwner({ name: 'name', owner: 'owner' })).toBe('owner/name');
  });
});

describe(repoKey, () => {
  it('gives the name with owner in lowercase letters', () => {
    expect(repoKey({ name: 'Hello-World', owner: 'OctoCat' })).toBe('octocat/hello-world');
  });
});

describe(parseGithubUrl, () => {
  it.each([
    ['git@github.com:riicodespretty/tern-worktrees.git', 'riicodespretty', 'tern-worktrees'],
    ['git@github.com:owner/name', 'owner', 'name'],
    ['https://github.com/owner/name.git', 'owner', 'name'],
    ['https://github.com/owner/some.repo', 'owner', 'some.repo'],
  ])('parses %s', (url, owner, name) => {
    expect(parseGithubUrl(url)).toStrictEqual({ name, owner });
  });

  it.each(['https://gitlab.com/owner/name.git', 'https://github.com/owner/name/extra', 'xgit@github.com:owner/name', 'git@github.com:owner/name.git.bak/x', ''])(
    'gives null for %s',
    url => {
      expect(parseGithubUrl(url)).toBeNull();
    },
  );
});
