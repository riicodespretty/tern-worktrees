import { loadConfig } from './config.ts';
import { CliError } from './proc.ts';

/** What the process prints and how it exits. */
export interface CliResult {
  code: 0 | 1;
  stdout: string;
  stderr: string;
}

/** A command module: `run(args)` returns the JSON result of the command. */
export interface CommandModule {
  run: (args: string[]) => Promise<object>;
}

/** Finds the command module for a command name. */
export type CommandLoader = (name: string) => Promise<CommandModule>;

const COMMAND_NAME = /^[a-z-]+$/u;

/** Returns `name` when it can name a command module, a lowercase word with dashes, else throws `bad_args`. */
export const checkCommandName = (name: string): string => {
  if (!COMMAND_NAME.test(name)) {
    throw new CliError('bad_args', `unknown command ${name}`);
  }
  return name;
};

/** Makes a {@link CommandLoader} that checks the name, then imports the module with `importCommand`. A module that fails to load gives `bad_args`. */
export const commandLoader =
  (importCommand: CommandLoader): CommandLoader =>
  async name => {
    const command = checkCommandName(name);
    try {
      return await importCommand(command);
    } catch {
      throw new CliError('bad_args', `unknown command ${name}`);
    }
  };

const loadCommand = commandLoader(
  async name =>
    // SAFETY: each module in `commands/` exports `run(args)`.
    (await import(`./commands/${name}.ts`)) as CommandModule,
);

const toCliError = (cause: unknown): CliError => {
  if (cause instanceof CliError) {
    return cause;
  }
  if (!(cause instanceof Error)) {
    return new CliError('git_failed', String(cause));
  }
  // SAFETY: a Node error carries an optional string `code`, and other errors have no `code`.
  const { code } = cause as NodeJS.ErrnoException;
  return new CliError(code?.startsWith('ERR_PARSE_ARGS_') === true ? 'bad_args' : 'git_failed', cause.message);
};

/** Runs one `tern-wt` command and returns its JSON output and exit code. A failure gives the error envelope. */
export const main = async (argv: string[], load: CommandLoader = loadCommand): Promise<CliResult> => {
  const [name = '', ...args] = argv;
  try {
    loadConfig();
    const command = await load(name);
    const result = await command.run(args);
    return { code: 0, stderr: '', stdout: `${JSON.stringify(result)}\n` };
  } catch (error) {
    const failure = toCliError(error);
    const envelope = { error: { code: failure.code, message: failure.message, ...failure.extra } };
    return { code: 1, stderr: `${failure.message}\n`, stdout: `${JSON.stringify(envelope)}\n` };
  }
};
