import { execFileSync } from 'node:child_process';

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const forbidden = tracked.filter((file) => {
  const normalized = file.replaceAll('\\', '/');
  if (normalized === '.env.example') return false;
  return /(^|\/)\.env(?:\.|$)/i.test(normalized)
    || /\.(?:pem|key|p12|pfx|jks|sqlite|sqlite3|db)$/i.test(normalized)
    || /(^|\/)(?:node_modules|dist|\.test-artifacts|test-results|playwright-report)(\/|$)/i.test(normalized)
    || /\.log$/i.test(normalized);
});

if (forbidden.length > 0) {
  console.error('Release hygiene check failed. Forbidden tracked artifacts:');
  forbidden.forEach((file) => console.error(`- ${file}`));
  process.exit(1);
}

console.log(`Release hygiene check passed for ${tracked.length} tracked files.`);
