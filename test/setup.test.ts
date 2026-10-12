import type { PathLike } from 'node:fs';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { run as setup } from '../src/commands/setup.ts';
import { CliError } from '../src/proc.ts';
import type { Sandbox } from './helpers.ts';
import { REPO_DIR, tempDir, ternLog, useSandbox } from './helpers.ts';

type RaceCall = 'accessSync' | 'symlinkSync';

/** A hook that runs in `accessSync` and `symlinkSync` before the call, where a second `setup` that runs at the same time can change a link. */
const race = vi.hoisted(() => ({ before: (_call: string, _path: string): void => {} }));

vi.mock(import('node:fs'), async importOriginal => {
  const fs = await importOriginal();
  return {
    ...fs,
    accessSync: (target: PathLike, mode?: number): void => {
      race.before('accessSync', String(target));
      fs.accessSync(target, mode);
    },
    symlinkSync: (target: PathLike, link: PathLike): void => {
      race.before('symlinkSync', String(link));
      fs.symlinkSync(target, link);
    },
  };
});

const PKG = realpathSync(REPO_DIR);

let sandbox: Sandbox;
let home: string;
let binLink: string;
let skillLink: string;

const binTarget = path.join(PKG, 'bin', 'tern-wt');
const skillTarget = path.join(PKG, 'skills', 'tern-worktrees');

const isAbsent = (target: string): boolean => {
  try {
    lstatSync(target);
    return false;
  } catch {
    return true;
  }
};

const expectedLinks = (binAction: string, skillAction: string = binAction): object[] => [
  { action: binAction, path: binLink, target: binTarget },
  { action: skillAction, path: skillLink, target: skillTarget },
];

/** Runs `setup`, and expects a `path_conflict` for `blocked` with a message that holds `message`. */
const expectPathConflict = (blocked: string, message: string): void => {
  let failure: CliError | null = null;
  try {
    setup([]);
  } catch (error) {
    if (!(error instanceof CliError)) {
      throw error;
    }
    failure = error;
  }
  expect(failure).toMatchObject({ code: 'path_conflict', extra: { path: blocked } });
  expect(failure?.message).toContain(message);
};

const PARENT_BLOCKERS: [string, () => string, string][] = [
  [
    'a dangling symbolic link at ~/.omp',
    (): string => {
      const omp = path.join(home, '.omp');
      symlinkSync(path.join(home, 'missing-omp'), omp);
      return omp;
    },
    'cannot be used: Error: ENOENT',
  ],
  [
    'a symbolic link loop at ~/.omp',
    (): string => {
      const omp = path.join(home, '.omp');
      symlinkSync(omp, omp);
      return omp;
    },
    'cannot be used: Error: ELOOP',
  ],
  [
    'a regular file at ~/.omp/agent/skills',
    (): string => {
      const skills = path.dirname(skillLink);
      mkdirSync(path.dirname(skills), { recursive: true });
      writeFileSync(skills, 'mine');
      return skills;
    },
    'is not a directory',
  ],
  [
    'a read-only ~/.local/bin',
    (): string => {
      const bin = path.dirname(binLink);
      mkdirSync(bin, { recursive: true });
      chmodSync(bin, 0o500);
      return bin;
    },
    'cannot be used: Error: EACCES',
  ],
];

const linkToOther = (link: string): void => {
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(tempDir('other'), link);
};

const noRace = (): void => {};

/** Runs `act` one time, at the first `call` in `setup`: `accessSync` runs after the plan of the CLI link, and `symlinkSync` runs right before `setup` makes it. */
const raceOnce = (call: RaceCall, act: () => void): void => {
  race.before = (made): void => {
    if (made === call) {
      race.before = noRace;
      act();
    }
  };
};

/** Removes what is at the CLI link, then puts what `make` makes there, as a second `setup` or the user can do. */
const occupyBinLink =
  (make: (link: string) => void): (() => void) =>
  (): void => {
    mkdirSync(path.dirname(binLink), { recursive: true });
    rmSync(binLink, { force: true });
    make(binLink);
  };

const OTHER_TARGET = '/elsewhere/tern-wt';

const linkBinToTarget = occupyBinLink(link => {
  symlinkSync(binTarget, link);
});

const linkBinToOther = occupyBinLink(link => {
  symlinkSync(OTHER_TARGET, link);
});

const writeFileAtBin = occupyBinLink(link => {
  writeFileSync(link, 'mine');
});

const lockBinDir = (): void => {
  chmodSync(path.dirname(binLink), 0o500);
};

const failOnSymlink = (): void => {
  throw new Error('setup made a link that it planned to keep');
};

/** The target of the CLI link, or the text of the file at its path. */
const binLinkContent = (): string => (lstatSync(binLink).isSymbolicLink() ? readlinkSync(binLink) : readFileSync(binLink, 'utf-8'));

const SAME_TARGET_RACES: [string, string, () => void, RaceCall][] = [
  ['created', 'the end of the plan', noRace, 'accessSync'],
  ['replaced', 'the end of the plan', linkBinToOther, 'accessSync'],
  ['created', 'its symlinkSync', noRace, 'symlinkSync'],
  ['replaced', 'its symlinkSync', linkBinToOther, 'symlinkSync'],
];

const NOT_A_SYMLINK = 'exists and is not a symbolic link';
const SYMLINK_EEXIST = 'cannot be used: Error: EEXIST';

const CONFLICT_RACES: [string, () => void, RaceCall, () => void, string, string][] = [
  ['a regular file replaces a link to another target after the plan', linkBinToOther, 'accessSync', writeFileAtBin, NOT_A_SYMLINK, 'mine'],
  ['a regular file appears at a new link after the plan', noRace, 'accessSync', writeFileAtBin, NOT_A_SYMLINK, 'mine'],
  ['a regular file appears right before symlinkSync', noRace, 'symlinkSync', writeFileAtBin, SYMLINK_EEXIST, 'mine'],
  ['a link to another target appears right before symlinkSync', noRace, 'symlinkSync', linkBinToOther, SYMLINK_EEXIST, OTHER_TARGET],
];

const LINK_BLOCKERS: [string, () => string, (link: string) => void, (link: string) => boolean][] = [
  [
    'a regular file at the CLI link',
    (): string => binLink,
    (link: string): void => {
      writeFileSync(link, 'mine');
    },
    (link: string): boolean => readFileSync(link, 'utf-8') === 'mine',
  ],
  [
    'a dir at the skill link',
    (): string => skillLink,
    (link: string): void => {
      mkdirSync(link);
    },
    (link: string): boolean => lstatSync(link).isDirectory(),
  ],
];

describe(setup, () => {
  beforeEach(() => {
    sandbox = useSandbox();
    home = tempDir('home');
    vi.stubEnv('HOME', home);
    binLink = path.join(home, '.local', 'bin', 'tern-wt');
    skillLink = path.join(home, '.omp', 'agent', 'skills', 'tern-worktrees');
    race.before = noRace;
  });

  it('makes both links, then keeps them on a second run, and does not call tern', () => {
    expect(setup([])).toStrictEqual({ links: expectedLinks('created') });
    expect([readlinkSync(binLink), readlinkSync(skillLink)]).toStrictEqual([binTarget, skillTarget]);
    raceOnce('symlinkSync', failOnSymlink);
    expect(setup([])).toStrictEqual({ links: expectedLinks('kept') });
    expect(ternLog()).toStrictEqual([]);
  });

  it('makes both links when Tern has a copied install of the plugin', () => {
    mkdirSync(path.join(sandbox.configDir, 'plugins', 'tern-worktrees'), { recursive: true });
    expect(setup([])).toStrictEqual({ links: expectedLinks('created') });
    expect([readlinkSync(binLink), readlinkSync(skillLink), ternLog()]).toStrictEqual([binTarget, skillTarget, []]);
  });

  it('replaces a link to another target', () => {
    linkToOther(binLink);
    linkToOther(skillLink);
    expect(setup([])).toStrictEqual({ links: expectedLinks('replaced') });
    expect([readlinkSync(binLink), readlinkSync(skillLink)]).toStrictEqual([binTarget, skillTarget]);
  });

  it.each(SAME_TARGET_RACES)('keeps a CLI link that it planned as %s when a second setup links it to the same target at %s', (_planned, _moment, before, call) => {
    before();
    raceOnce(call, linkBinToTarget);
    expect(setup([])).toStrictEqual({ links: expectedLinks('kept', 'created') });
    expect([readlinkSync(binLink), readlinkSync(skillLink)]).toStrictEqual([binTarget, skillTarget]);
  });

  it.each(CONFLICT_RACES)('raises path_conflict when %s, and leaves it as it was', (_label, before, call, occupy, reason, left) => {
    before();
    raceOnce(call, occupy);
    expectPathConflict(binLink, `${binLink} ${reason}`);
    expect([binLinkContent(), isAbsent(skillLink)]).toStrictEqual([left, true]);
  });

  it('raises path_conflict with the error of symlinkSync when it fails for a different cause', () => {
    raceOnce('symlinkSync', lockBinDir);
    try {
      expectPathConflict(binLink, `${binLink} cannot be used: Error: EACCES`);
    } finally {
      chmodSync(path.dirname(binLink), 0o700);
    }
    expect([isAbsent(binLink), isAbsent(skillLink)]).toStrictEqual([true, true]);
  });

  it.each(LINK_BLOCKERS)('raises path_conflict on %s and leaves it as it was', (_label, linkPath, occupy, isUnchanged) => {
    const link = linkPath();
    mkdirSync(path.dirname(link), { recursive: true });
    occupy(link);
    expectPathConflict(link, `${link} exists and is not a symbolic link`);
    expect([binLink, skillLink].map(target => lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink() === true)).toStrictEqual([false, false]);
    expect(isUnchanged(link)).toBeTruthy();
  });

  it.each(PARENT_BLOCKERS)('raises path_conflict on %s before it changes anything', (_label, occupy, reason) => {
    const blocked = occupy();
    expectPathConflict(blocked, `${blocked} ${reason}`);
    expect([isAbsent(binLink), isAbsent(skillLink)]).toStrictEqual([true, true]);
  });

  it('keeps both links on a second run when their parent dirs are read-only', () => {
    setup([]);
    const parents = [path.dirname(binLink), path.dirname(skillLink)];
    for (const parent of parents) {
      chmodSync(parent, 0o500);
    }
    try {
      expect(setup([])).toStrictEqual({ links: expectedLinks('kept') });
    } finally {
      for (const parent of parents) {
        chmodSync(parent, 0o700);
      }
    }
    expect([readlinkSync(binLink), readlinkSync(skillLink)]).toStrictEqual([binTarget, skillTarget]);
  });

  it('makes the links through a parent that is a symbolic link to a dir', () => {
    const realOmp = tempDir('omp');
    symlinkSync(realOmp, path.join(home, '.omp'));
    expect(setup([])).toStrictEqual({ links: expectedLinks('created') });
    expect(readlinkSync(path.join(realOmp, 'agent', 'skills', 'tern-worktrees'))).toBe(skillTarget);
  });
});
