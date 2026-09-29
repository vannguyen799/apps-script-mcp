import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist/admin-ui", { recursive: true });
cpSync("src/admin-ui", "dist/admin-ui", { recursive: true });
