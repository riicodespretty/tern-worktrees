import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { CliError, must, run } from '../src/proc.ts';
import { tempDir, useSandbox } from './helpers.ts';

describe('proc', () => {
  beforeEach(() => {
    useSandbox();
  });

  describe(run, () => {
    it('collects the exit status and both streams', async () => {
      await expect(run(['sh', '-c', 'printf out; printf err >&2; exit 3'])).resolves.toStrictEqual({ status: 3, stderr: 'err', stdout: 'out' });
    });

    it('runs in cwd with extra env on top of process.env', async () => {
      const dir = tempDir('proc');
      await expect(run(['sh', '-c', 'printf "%s %s %s" "$PWD" "$EXTRA" "$GIT_AUTHOR_NAME"'], { cwd: dir, env: { EXTRA: 'yes' } })).resolves.toStrictEqual({
        status: 0,
        stderr: '',
        stdout: `${dir} yes Test`,
      });
    });

    it('reports a program that does not start as status 127', async () => {
      const result = await run(['/nonexistent/program']);
      expect(result).toStrictEqual({ status: 127, stderr: 'Error: spawn /nonexistent/program ENOENT', stdout: '' });
    });

    it('gives the program no stdin, so a reader sees end of file', async () => {
      await expect(run(['cat'])).resolves.toStrictEqual({ status: 0, stderr: '', stdout: '' });
    });

    it('keeps multibyte text whole', async () => {
      await expect(run(['sh', '-c', 'printf "\\303"; sleep 0.05; printf "\\251 ok"'])).resolves.toStrictEqual({ status: 0, stderr: '', stdout: 'é ok' });
    });

    it('reports a process killed by a signal as status 1', async () => {
      await expect(run(['sh', '-c', 'printf partial; kill -9 $$'])).resolves.toStrictEqual({ status: 1, stderr: '', stdout: 'partial' });
    });
  });

  describe(must, () => {
    it('returns stdout on success', async () => {
      await expect(must(['sh', '-c', 'printf "$EXTRA"'], 'git_failed', { env: { EXTRA: 'ok' } })).resolves.toBe('ok');
    });

    it('runs in opts.cwd', async () => {
      const dir = tempDir('must');
      await expect(must(['pwd'], 'git_failed', { cwd: dir })).resolves.toBe(`${dir}\n`);
    });

    it('throws the code with the trimmed stderr', async () => {
      const failing = must(['sh', '-c', 'echo "  bad thing  " >&2; exit 2'], 'gh_failed');
      await expect(failing).rejects.toThrow(CliError);
      await expect(failing).rejects.toMatchObject({ code: 'gh_failed', extra: {}, message: 'bad thing', name: 'CliError' });
    });

    it('names the program and status without stderr', async () => {
      await expect(must(['sh', '-c', 'exit 4'], 'tern_failed')).rejects.toMatchObject({ code: 'tern_failed', message: 'sh exited 4' });
    });
  });

  describe(CliError, () => {
    it('carries extra fields', () => {
      const error = new CliError('path_conflict', 'taken', { path: '/x' });
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ code: 'path_conflict', extra: { path: '/x' }, message: 'taken' });
    });
  });
});
