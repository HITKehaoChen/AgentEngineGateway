import { readFile } from "node:fs/promises";
import process from "node:process";

const input = process.argv[2] ?? "docs/phase4-score-matrix.json";
const matrix = JSON.parse(await readFile(input, "utf8"));
if (!matrix || typeof matrix !== "object" || !Array.isArray(matrix.cases)) throw new Error("Matrix must contain a cases array");

const rows = matrix.cases.map((item) => {
  if (!item || typeof item.id !== "string" || !item.engines || typeof item.engines !== "object") throw new Error("Each case needs id and engines");
  const scores = Object.entries(item.engines).map(([engine, result]) => {
    const score = result && typeof result === "object" ? result.score : null;
    if (score !== null && (typeof score !== "number" || score < 0)) throw new Error(`Invalid score for ${item.id}/${engine}`);
    return { engine, score };
  });
  const available = scores.filter((x) => x.score !== null);
  const best = available.length ? available.reduce((a, b) => b.score > a.score ? b : a) : { engine: "pending", score: null };
  return { id: item.id, scores, best, weight: typeof item.weight === "number" ? item.weight : 1 };
});

const engines = [...new Set(rows.flatMap((row) => row.scores.map((score) => score.engine)))];
console.log("| 用例 | " + engines.join(" | ") + " | 计入引擎 | 最高分 |");
console.log("| --- | " + engines.map(() => "---:").join(" | ") + " | --- | ---: |");
for (const row of rows) {
  const values = engines.map((engine) => row.scores.find((score) => score.engine === engine)?.score ?? "待测");
  console.log(`| ${row.id} | ${values.join(" | ")} | ${row.best.engine} | ${row.best.score ?? "待测"} |`);
}
const total = rows.reduce((sum, row) => sum + (row.best.score === null ? 0 : row.best.score * row.weight), 0);
console.log(`\n当前可计入总分：${total}`);
