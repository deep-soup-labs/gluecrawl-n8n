/**
 * Copies non-TypeScript node assets (icons and *.node.json codex files) into
 * dist, preserving their path relative to the repo root.
 *
 * n8n resolves `icon: 'file:gluecrawl.svg'` relative to the compiled .js, so
 * the asset has to sit next to it in dist. tsc will not emit non-TS files and
 * we cannot pull in a copy plugin: the package must ship with zero runtime
 * dependencies for n8n Cloud verification, and we keep devDependencies lean
 * for the same review.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const SOURCE_DIRS = ['credentials', 'nodes'];
const ASSET_EXTENSIONS = new Set(['.svg', '.png', '.json']);

function copyAssets(relativeDir) {
	const absoluteDir = path.join(ROOT, relativeDir);
	if (!fs.existsSync(absoluteDir)) return 0;

	let copied = 0;
	for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
		const relativePath = path.join(relativeDir, entry.name);
		if (entry.isDirectory()) {
			copied += copyAssets(relativePath);
			continue;
		}
		if (!ASSET_EXTENSIONS.has(path.extname(entry.name))) continue;

		const destination = path.join(DIST, relativePath);
		fs.mkdirSync(path.dirname(destination), { recursive: true });
		fs.copyFileSync(path.join(ROOT, relativePath), destination);
		copied += 1;
	}
	return copied;
}

let total = 0;
for (const dir of SOURCE_DIRS) total += copyAssets(dir);
console.log(`copy-assets: copied ${total} file(s) into dist`);
