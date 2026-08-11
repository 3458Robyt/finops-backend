import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';

const sourceRoot = resolve(process.cwd(), 'src');
const maxLines = 400;
const exceptions = new Map([
  ['infrastructure/repositories/PrismaCloudConnectionRepository.ts', 900],
  ['infrastructure/ingestion/PrismaCloudIngestionJobRepository.ts', 850],
  ['infrastructure/repositories/PrismaResourceMetricRepository.ts', 670],
  ['infrastructure/repositories/queries/recommendationSavingsMeasurementQueries.ts', 650],
  ['presentation/controllers/CloudConnectionController.ts', 600],
  ['application/services/ai/evaluation/qualityRubric.ts', 550],
  ['application/services/FinOpsAiService.ts', 540],
  ['application/services/ai/evaluation/goldenScenarios.ts', 500],
  ['presentation/controllers/RecommendationController.ts', 500],
  ['infrastructure/repositories/PrismaAgentLearningRepository.ts', 500],
  ['infrastructure/repositories/PrismaRecommendationRepository.ts', 490],
  ['infrastructure/repositories/PrismaValueRealizationRepository.ts', 480],
  ['application/services/RecommendationAnalysisService.ts', 480],
  ['domain/interfaces/IRecommendationRepository.ts', 470],
  ['domain/interfaces/ICloudConnectionRepository.ts', 450],
  ['infrastructure/repositories/PrismaCostAllocationRepository.ts', 420],
]);

const files = await collectSourceFiles(sourceRoot);
const violations = [];
for (const file of files) {
  const relativePath = relative(sourceRoot, file).replaceAll('\\', '/');
  const lineCount = countLines(await readFile(file, 'utf8'));
  const allowedLines = exceptions.get(relativePath);
  if (lineCount > maxLines && (allowedLines === undefined || lineCount > allowedLines)) {
    violations.push(`${relativePath}: ${lineCount} lines (limit ${allowedLines ?? maxLines})`);
  }
}

if (violations.length > 0) {
  console.error('Architecture fitness check failed:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`Architecture fitness check passed for ${files.length} production source files.`);
if (exceptions.size > 0) {
  console.log(`Documented exceptions: ${exceptions.size}. Review them as MOD-001 is reduced.`);
}

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'generated' && entry.name !== 'testing') result.push(...await collectSourceFiles(path));
      continue;
    }
    if (['.ts', '.tsx'].includes(extname(entry.name)) && !entry.name.endsWith('.test.ts')) result.push(path);
  }
  return result;
}

function countLines(source) {
  return source.replace(/\r?\n$/, '').split(/\r?\n/).length;
}
