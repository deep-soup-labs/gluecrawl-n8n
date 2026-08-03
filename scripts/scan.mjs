/**
 * Runs the n8n community-package verification scan against the working tree.
 *
 * The published CLI (`npx @n8n/scan-community-package <name>`) resolves its
 * argument as an npm package name and requires a provenance attestation, so it
 * can only ever scan an already-released version. That is too late to be useful
 * during development, and it is the gate that decides whether the package can
 * be installed on n8n Cloud at all.
 *
 * The scanner's library entry point takes a directory, so this drives both legs
 * the real scan performs:
 *
 *   1. the attested SOURCE checkout, linted with the full rule set on `.ts`
 *   2. the published TARBALL, linted as compiled `.js` + package.json
 *
 * Leg 2 matters because provenance pins the source commit, not the build
 * output. `npm pack` here stands in for the tarball npm would publish.
 *
 * The scanner is intentionally NOT a dependency of this package: it pulls in
 * its own eslint and typescript, and `dependencies` must stay empty for
 * verification. It is fetched on demand instead.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const SCANNER = '@n8n/scan-community-package';

function run(command, args, options = {}) {
	return execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe', ...options });
}

/** Resolves the scanner into the npx cache without adding it to package.json. */
function locateScanner() {
	// `npx --yes <pkg> --help` fails by design (the CLI wants a package name),
	// but it populates the cache, after which the module is importable by path.
	try {
		run('npx', ['--yes', SCANNER, '--n8n-scan-warmup'], { stdio: 'ignore' });
	} catch {
		// Expected: the CLI exits non-zero on an unresolvable package name.
	}

	const npxCache = join(process.env.npm_config_cache ?? join(process.env.HOME, '.npm'), '_npx');
	for (const entry of readdirSync(npxCache)) {
		const candidate = join(npxCache, entry, 'node_modules', SCANNER, 'scanner', 'scanner.mjs');
		try {
			readdirSync(join(npxCache, entry, 'node_modules', SCANNER, 'scanner'));
			return candidate;
		} catch {
			continue;
		}
	}

	throw new Error(
		`Could not locate ${SCANNER} in the npx cache. Run "npx ${SCANNER} n8n-nodes-gluecrawl" once with network access.`,
	);
}

function report(label, result) {
	if (result.passed) {
		console.log(`PASS  ${label}`);
		return true;
	}

	console.log(`FAIL  ${label}: ${result.message}`);
	if (result.details) console.log(result.details);
	return false;
}

const scannerPath = locateScanner();
const { analyzePackage, SOURCE_FILE_PATTERNS } = await import(scannerPath);

const sourceResult = await analyzePackage(ROOT, SOURCE_FILE_PATTERNS);
let passed = report('source', sourceResult);

const packDir = mkdtempSync(join(tmpdir(), 'gluecrawl-scan-'));
try {
	run('npm', ['run', 'build'], { cwd: ROOT });
	const packed = run('npm', ['pack', '--silent', '--pack-destination', packDir], { cwd: ROOT })
		.trim()
		.split('\n')
		.pop();
	run('tar', ['-xzf', join(packDir, packed), '-C', packDir]);

	const distResult = await analyzePackage(join(packDir, 'package'), ['**/*.js', 'package.json']);
	passed = report('tarball', distResult) && passed;
} finally {
	rmSync(packDir, { recursive: true, force: true });
}

if (!passed) process.exit(1);
console.log('\nCommunity-package scan clean.');
