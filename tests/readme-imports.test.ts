// @vitest-environment node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const repoRoot = new URL('..', import.meta.url).pathname;

function markdownFilesUnder(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...markdownFilesUnder(path));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path);
  }
  return files;
}

function markdownFiles(): string[] {
  const files = [join(repoRoot, 'README.md')];
  const docsDir = join(repoRoot, 'docs');
  if (existsSync(docsDir)) files.push(...markdownFilesUnder(docsDir));
  return files.filter(existsSync);
}

function fencedImportSpecifiers(markdown: string): string[] {
  const specifiers: string[] = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) continue;
    for (const match of line.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (specifier !== undefined && !/\s/.test(specifier)) specifiers.push(specifier);
    }
  }
  return specifiers;
}

function packageNameOf(specifier: string): string {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : (segments[0] ?? specifier);
}

test('everyFencedImportInReadmeAndDocsResolvesToADeclaredDependency', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const allowed = new Set<string>([
    pkg.name,
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...builtinModules,
    ...builtinModules.map((name) => `node:${name}`),
  ]);

  const offenders = markdownFiles().flatMap((file) =>
    fencedImportSpecifiers(readFileSync(file, 'utf8'))
      .filter((specifier) => !specifier.startsWith('.'))
      .filter((specifier) => !allowed.has(packageNameOf(specifier)))
      .map((specifier) => `${file}: ${specifier}`),
  );

  expect(offenders).toEqual([]);
});
