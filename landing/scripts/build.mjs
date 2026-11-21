// Gera landing/dist a partir de landing/src. Sem dependências: só copia os arquivos estáticos.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");
const dist = join(root, "dist");

if (!existsSync(join(src, "index.html"))) {
  console.error("landing/src/index.html não encontrado.");
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
cpSync(src, dist, { recursive: true });

// O instalador de um comando e o compose que ele usa, servidos em /install e /install/docker-compose.yml
// (as regras ficam em src/_redirects e src/_headers). Vêm da raiz do repositório, que é a fonte deles.
const repo = join(root, "..");
for (const name of ["install.sh", "docker-compose.yml"]) {
  if (!existsSync(join(repo, name))) {
    console.error(`${name} não encontrado na raiz do repositório.`);
    process.exit(1);
  }
}
cpSync(join(repo, "install.sh"), join(dist, "install.sh"));
mkdirSync(join(dist, "install"), { recursive: true });
cpSync(join(repo, "docker-compose.yml"), join(dist, "install", "docker-compose.yml"));

let files = 0;
let bytes = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p);
    else {
      files += 1;
      bytes += s.size;
    }
  }
};
walk(dist);
console.log(`landing: ${files} arquivos (${(bytes / 1024).toFixed(0)} KB) em ${relative(process.cwd(), dist) || "dist"}`);
