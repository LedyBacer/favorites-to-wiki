import { existsSync } from "node:fs";

const exportPath = process.argv[2];

if (!exportPath) {
  console.error("Usage: npm run import:telegram -- /path/to/result.json");
  process.exitCode = 1;
} else if (!existsSync(exportPath)) {
  console.error(`Telegram export file does not exist: ${exportPath}`);
  process.exitCode = 1;
} else {
  console.log(
    [
      "Telegram export importer scaffold is ready.",
      `Input: ${exportPath}`,
      "Full JSON mapping will be implemented after the live inbox model stabilizes.",
    ].join("\n"),
  );
}
