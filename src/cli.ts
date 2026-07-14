#!/usr/bin/env node
import { main } from "./server.js";

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
