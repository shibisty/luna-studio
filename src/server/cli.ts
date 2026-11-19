import { main } from './commands';

main(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`lunastudio: ${(e as Error).message}\n`);
  process.exit(1);
});
