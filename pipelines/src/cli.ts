import { runEtl } from "./etl.js";

const writeMode = process.argv.includes("--write");

runEtl(writeMode)
  .then(({ summary }) => {
    console.log(JSON.stringify(summary, null, 2));
    if (summary.errors.length > 0) process.exitCode = 2;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
