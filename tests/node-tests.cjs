"use strict";

require("../scripts/templates.js");
require("../scripts/core.js");
require("../scripts/references.js");
require("../scripts/storage.js");
require("../scripts/generator.js");
require("../scripts/zip.js");
require("../scripts/export.js");

const suite = require("./test-suite.js");

suite
  .run((result) => {
    const label = result.ok ? "PASS" : "FAIL";
    process.stdout.write(`${label} ${result.name} (${result.durationMs} ms)\n`);
    if (!result.ok) process.stderr.write(`${result.error.stack || result.error.message}\n`);
  })
  .then((results) => {
    const failed = results.filter((item) => !item.ok);
    process.stdout.write(`\n${results.length - failed.length}/${results.length} tests passed.\n`);
    if (failed.length) process.exitCode = 1;
  })
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
