import { ProjectXEvidenceReplayService } from "../replay/projectx-evidence-replay.js";

interface CliOptions {
  database: string;
  throughSequence?: number;
  maxEvents?: number;
  batchSize?: number;
}

function parseArguments(argumentsList: string[]): CliOptions {
  const options: CliOptions = {
    database: "./data/projectx-evidence.sqlite",
  };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]!;
    const value = argumentsList[index + 1];
    switch (argument) {
      case "--database":
        options.database = requiredValue(argument, value);
        index += 1;
        break;
      case "--through-sequence":
        options.throughSequence = integerValue(argument, value);
        index += 1;
        break;
      case "--max-events":
        options.maxEvents = integerValue(argument, value);
        index += 1;
        break;
      case "--batch-size":
        options.batchSize = integerValue(argument, value);
        index += 1;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`unknown_argument:${argument}`);
    }
  }
  return options;
}

function requiredValue(name: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`missing_argument_value:${name}`);
  }
  return value;
}

function integerValue(name: string, value: string | undefined): number {
  const raw = requiredValue(name, value);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`argument_not_integer:${name}`);
  }
  return parsed;
}

function printHelp(): void {
  process.stdout.write(`Glitch Topstep ProjectX evidence replay\n\n`);
  process.stdout.write(`Usage:\n`);
  process.stdout.write(`  npm run replay:evidence -- [options]\n\n`);
  process.stdout.write(`Options:\n`);
  process.stdout.write(`  --database <path>          Evidence SQLite path (default: ./data/projectx-evidence.sqlite)\n`);
  process.stdout.write(`  --through-sequence <n>     Replay only through local evidence sequence n\n`);
  process.stdout.write(`  --max-events <n>           Maximum events to read before reporting truncated\n`);
  process.stdout.write(`  --batch-size <n>           SQLite scan batch size\n`);
}

function main(): void {
  let replay: ProjectXEvidenceReplayService | null = null;
  try {
    const options = parseArguments(process.argv.slice(2));
    replay = new ProjectXEvidenceReplayService(options.database);
    const result = replay.replay({
      throughSequence: options.throughSequence,
      maxEvents: options.maxEvents,
      batchSize: options.batchSize,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
    process.stderr.write(`${detail}\n`);
    process.exitCode = 1;
  } finally {
    replay?.close();
  }
}

main();
