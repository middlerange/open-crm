import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";

await mkdir("dist", { recursive: true });
const migrations = await Promise.all(
  (await readdir("migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map(async (version) => ({
      version,
      sql: await readFile(`migrations/${version}`, "utf8"),
    })),
);
await writeFile("worker/migrations.generated.json", JSON.stringify(migrations));

for (const name of ["argon2", "blake2b"]) {
  const bundle = await readFile(`node_modules/hash-wasm/dist/${name}.umd.min.js`, "utf8");
  const wasmBase64 = bundle.match(/data:"([^"]+)"/)?.[1];
  if (!wasmBase64) throw new Error(`Could not locate the hash-wasm ${name} module.`);
  await writeFile(`worker/${name}.wasm`, Buffer.from(wasmBase64, "base64"));
}
