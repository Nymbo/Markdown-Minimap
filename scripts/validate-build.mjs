import { readFile } from "node:fs/promises";

const requiredFiles = [
  "src/main.ts",
  "main.js",
  "manifest.json",
  "styles.css",
  "versions.json",
];

for (const file of requiredFiles) {
  await readFile(file, "utf8");
}

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const versions = JSON.parse(await readFile("versions.json", "utf8"));

const expected = {
  id: "markdown-minimap",
  name: "Markdown Minimap",
  packageName: "markdown-minimap",
};

if (manifest.id !== expected.id) {
  throw new Error(`manifest.json id must be ${expected.id}`);
}

if (manifest.name !== expected.name) {
  throw new Error(`manifest.json name must be ${expected.name}`);
}

if (packageJson.name !== expected.packageName) {
  throw new Error(`package.json name must be ${expected.packageName}`);
}

if (packageJson.version !== manifest.version) {
  throw new Error("package.json version must match manifest.json version");
}

if (!versions[manifest.version]) {
  throw new Error("versions.json must include the manifest version");
}

const mainJs = await readFile("main.js", "utf8");
if (mainJs.includes('disablePlugin("minimap")') || mainJs.includes('enablePlugin("minimap")')) {
  throw new Error("main.js still references the upstream minimap plugin id");
}

console.log("Markdown Minimap baseline plugin files are valid.");
