/** The GitHub owner and name of a repository. */
export interface GithubRepoRef {
  owner: string;
  name: string;
}

const NAME_WITH_OWNER = /^(?<owner>[A-Za-z0-9][A-Za-z0-9._-]*)\/(?<name>(?!\.\.?$)[A-Za-z0-9._][A-Za-z0-9._-]*)$/u;

/** The `<owner>/<name>` form of `repoRef`, the name that `gh` uses for a repository. */
export const nameWithOwner = (repoRef: GithubRepoRef): string => `${repoRef.owner}/${repoRef.name}`;

/** Reads `<owner>/<name>` from `text`, or gives null when `text` is not a valid `<owner>/<name>`. */
export const parseRepoRef = (text: string): GithubRepoRef | null => {
  const groups = NAME_WITH_OWNER.exec(text)?.groups;
  return groups ? { name: groups.name, owner: groups.owner } : null;
};
