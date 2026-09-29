import { cpSync, mkdirSync } from "node:fs";

for (const dir of ["admin-ui", "account-ui"]) {
  mkdirSync(`dist/${dir}`, { recursive: true });
  cpSync(`src/${dir}`, `dist/${dir}`, { recursive: true });
}
