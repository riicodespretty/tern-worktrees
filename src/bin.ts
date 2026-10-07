import { main } from './cli.ts';

const r = await main(process.argv.slice(2));
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);
process.exitCode = r.code;
