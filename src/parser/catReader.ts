import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { parseLine } from "./recordParser";
import type { CatRecord, ParseStats } from "./types";

export interface ReadResult {
  stats: ParseStats;
  elapsedMs: number;
}

export type RecordHandler = (record: CatRecord) => void;

export async function readCatFile(
  filePath: string,
  onRecord: RecordHandler,
  onProgress?: (stats: ParseStats) => void,
  progressEvery = 100_000,
): Promise<ReadResult> {
  const stats: ParseStats = {
    linesRead: 0,
    type01: 0,
    type11: 0,
    type13: 0,
    type14: 0,
    type15: 0,
    type16: 0,
    type17: 0,
    type90: 0,
    otros: 0,
    errors: 0,
  };

  const startedAt = Date.now();

  const stream = createReadStream(filePath, {
    encoding: "latin1",
    highWaterMark: 1024 * 1024,
  });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    stats.linesRead++;
    if (line.length < 2) {
      stats.otros++;
      continue;
    }
    const tipo = line.substring(0, 2);
    try {
      const record = parseLine(line);
      if (record) {
        switch (record.type) {
          case "01":
            stats.type01++;
            break;
          case "11":
            stats.type11++;
            break;
          case "13":
            stats.type13++;
            break;
          case "14":
            stats.type14++;
            break;
          case "15":
            stats.type15++;
            break;
        }
        onRecord(record);
      } else {
        switch (tipo) {
          case "16":
            stats.type16++;
            break;
          case "17":
            stats.type17++;
            break;
          case "90":
            stats.type90++;
            break;
          default:
            stats.otros++;
        }
      }
    } catch {
      stats.errors++;
    }

    if (onProgress && stats.linesRead % progressEvery === 0) {
      onProgress(stats);
    }
  }

  return { stats, elapsedMs: Date.now() - startedAt };
}
