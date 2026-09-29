import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist/account-ui", { recursive: true });
cpSync("src/account-ui", "dist/account-ui", { recursive: true });
