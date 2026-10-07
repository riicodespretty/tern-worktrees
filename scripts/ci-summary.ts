/// <reference types="node" />
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { InferOutput } from 'valibot';
import { array, looseObject, number, object, optional, parse, record, string } from 'valibot';

const USAGE = [
  'Usage:',
  '  node --experimental-strip-types scripts/ci-summary.ts coverage [--summary <coverage-summary.json>] [--out <file>]',
  '  node --experimental-strip-types scripts/ci-summary.ts mutation [--report <mutation.json>[,<mutation.json>...]] [--base <mutation.json>[,<mutation.json>...]] [--marker] [--out <file>]',
].join('\n');

const DETECTED = new Set(['Killed', 'Timeout']);
const UNDETECTED = new Set(['Survived', 'NoCoverage']);

const Metric = object({ covered: number(), pct: number(), skipped: number(), total: number() });
const CoverageEntry = object({ branches: Metric, functions: Metric, lines: Metric, statements: Metric });
const CoverageSummarySchema = record(string(), CoverageEntry);
const MutantSchema = looseObject({
  location: looseObject({ start: looseObject({ line: number() }) }),
  mutatorName: string(),
  status: string(),
});
const MutationReportSchema = looseObject({
  files: optional(record(string(), looseObject({ mutants: optional(array(MutantSchema)) }))),
  projectRoot: optional(string()),
});

interface Survivor {
  file: string;
  line: number;
  mutator: string;
  status: string;
}

interface StatusCounts {
  killed: number;
  timeout: number;
  survived: number;
  noCoverage: number;
  other: number;
}

interface MutationSummary {
  score: number;
  detected: number;
  total: number;
  survivors: Survivor[];
  counts: StatusCounts;
}

const renderCoverage = (summaryPath: string): string => {
  const summary = parse(CoverageSummarySchema, JSON.parse(readFileSync(summaryPath, 'utf-8')));
  if (!Object.hasOwn(summary, 'total')) {
    throw new Error(`Missing "total" entry in ${summaryPath}`);
  }
  const { total, ...files } = summary;
  const lines = ['## Coverage Report', '', '| Metric | Covered | Total | Percent |', '| --- | --- | --- | --- |'];
  const metrics: [string, { total: number; covered: number; skipped: number; pct: number }][] = [
    ['Statements', total.statements],
    ['Branches', total.branches],
    ['Functions', total.functions],
    ['Lines', total.lines],
  ];
  for (const [label, metric] of metrics) {
    lines.push(`| ${label} | ${metric.covered} | ${metric.total} | ${metric.pct.toFixed(2)}% |`);
  }
  lines.push('');
  const below = Object.entries(files).filter(([, entry]) => [entry.statements, entry.branches, entry.functions, entry.lines].some(metric => metric.pct < 100));
  if (below.length === 0) {
    lines.push('Every file is at 100%.');
    return lines.join('\n');
  }
  lines.push('<details><summary>Files below 100%</summary>', '', '| File | Stmts | Branch | Funcs | Lines |', '| --- | --- | --- | --- | --- |');
  for (const [file, entry] of below) {
    lines.push(
      `| \`${path.relative(process.cwd(), file)}\` | ${entry.statements.pct.toFixed(2)}% | ${entry.branches.pct.toFixed(2)}% | ${entry.functions.pct.toFixed(2)}% | ${entry.lines.pct.toFixed(2)}% |`,
    );
  }
  lines.push('', '</details>');
  return lines.join('\n');
};

const countStatus = (counts: StatusCounts, status: string): void => {
  switch (status) {
    case 'Killed': {
      counts.killed += 1;
      break;
    }
    case 'Timeout': {
      counts.timeout += 1;
      break;
    }
    case 'Survived': {
      counts.survived += 1;
      break;
    }
    case 'NoCoverage': {
      counts.noCoverage += 1;
      break;
    }
    default: {
      counts.other += 1;
    }
  }
};

const toSurvivor = (file: string, root: string, mutant: { status: string; mutatorName: string; location: { start: { line: number } } }): Survivor => ({
  file: file.startsWith(root) ? file.slice(root.length) : file,
  line: mutant.location.start.line,
  mutator: mutant.mutatorName,
  status: mutant.status,
});

type MutationFiles = NonNullable<InferOutput<typeof MutationReportSchema>['files']>;

const tallyMutants = (files: MutationFiles, root: string): MutationSummary => {
  const counts: StatusCounts = { killed: 0, noCoverage: 0, other: 0, survived: 0, timeout: 0 };
  let detected = 0;
  const survivors: Survivor[] = [];
  for (const [file, data] of Object.entries(files)) {
    for (const mutant of data.mutants ?? []) {
      countStatus(counts, mutant.status);
      if (DETECTED.has(mutant.status)) {
        detected += 1;
      }
      if (UNDETECTED.has(mutant.status)) {
        survivors.push(toSurvivor(file, root, mutant));
      }
    }
  }
  const total = detected + survivors.length;
  return { counts, detected, score: total ? (detected / total) * 100 : 100, survivors, total };
};

const summariseMutation = (reportPaths: string[]): MutationSummary | null => {
  if (reportPaths.length === 0 || !reportPaths.every(reportPath => existsSync(reportPath))) {
    return null;
  }
  const reports = reportPaths.map(reportPath => parse(MutationReportSchema, JSON.parse(readFileSync(reportPath, 'utf-8'))));
  const projectRoot = reports.find(report => report.projectRoot !== undefined && report.projectRoot !== '')?.projectRoot;
  const root = projectRoot === undefined ? '' : `${projectRoot}/`;
  const files = Object.fromEntries(reports.flatMap(report => Object.entries(report.files ?? {})));
  return tallyMutants(files, root);
};

const renderMutation = (reportPaths: string[], basePaths: string[], marker: boolean): string => {
  const head = summariseMutation(reportPaths);
  const base = summariseMutation(basePaths);
  const lines = marker ? ['<!-- mutation-report -->'] : [];
  lines.push('## Mutation Test Report', '');
  if (!head) {
    lines.push('No mutation report was produced. The mutation job did not reach the reporting step.');
    return lines.join('\n');
  }
  let delta = 'no base run to compare';
  if (base) {
    const diff = head.score - base.score;
    const sign = diff > 0 ? '+' : '';
    delta = diff === 0 ? 'unchanged' : `${sign}${diff.toFixed(2)} points vs ${base.score.toFixed(2)}%`;
  }
  const { counts } = head;
  lines.push(
    '| Metric | Value |',
    '| --- | --- |',
    `| Score | ${head.score.toFixed(2)}% (${delta}) |`,
    `| Detected | ${head.detected} / ${head.total} |`,
    `| Survivors | ${head.survivors.length} |`,
    `| Mutants | ${counts.killed} killed, ${counts.timeout} timed out, ${counts.survived} survived, ${counts.noCoverage} no coverage, ${counts.other} other |`,
    '',
  );
  if (head.survivors.length === 0) {
    lines.push('Every mutant was detected.');
    return lines.join('\n');
  }
  const shown = head.survivors.slice(0, 20);
  lines.push('<details><summary>Surviving mutants</summary>', '', '| Site | Mutator | Status |', '| --- | --- | --- |');
  for (const s of shown) {
    lines.push(`| \`${s.file}:${s.line}\` | ${s.mutator} | ${s.status} |`);
  }
  if (head.survivors.length > shown.length) {
    lines.push('', `Showing ${shown.length} of ${head.survivors.length}. The full report is in the mutation-report artifact.`);
  }
  lines.push('', '</details>');
  return lines.join('\n');
};

const emit = (markdown: string, out: string | undefined): void => {
  if (out !== undefined && out !== '') {
    appendFileSync(out, `${markdown}\n`, 'utf-8');
    return;
  }
  process.stdout.write(`${markdown}\n`);
};

const resolvePaths = (values: string[] | undefined, cwd: string): string[] =>
  (values ?? [])
    .flatMap(value => value.split(','))
    .map(value => value.trim())
    .filter(value => value !== '')
    .map(value => path.resolve(cwd, value));

const main = (): void => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    args: process.argv.slice(2),
    options: {
      base: { multiple: true, type: 'string' },
      marker: { default: false, type: 'boolean' },
      out: { type: 'string' },
      report: { default: ['reports/mutation/mutation.json'], multiple: true, type: 'string' },
      summary: { default: 'coverage/coverage-summary.json', type: 'string' },
    },
  });
  const out = values.out ?? process.env.GITHUB_STEP_SUMMARY;
  const cwd = process.cwd();
  switch (positionals[0]) {
    case 'coverage': {
      emit(renderCoverage(path.resolve(cwd, values.summary)), out);
      break;
    }
    case 'mutation': {
      emit(renderMutation(resolvePaths(values.report, cwd), resolvePaths(values.base, cwd), values.marker), out);
      break;
    }
    default: {
      console.error(USAGE);
    }
  }
};

try {
  main();
} catch (error) {
  console.error(error);
}
process.exitCode = 0;
