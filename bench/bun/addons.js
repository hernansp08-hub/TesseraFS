const a = require("./napirs_addon.node");
console.log("napi-rs addon exports:", Object.keys(a).slice(0, 8).join(","), "... total", Object.keys(a).length);
const b = require("./naa_addon.node");
console.log("node-addon-api (keytar) exports:", Object.keys(b).join(","));
console.log("runtime:", typeof Bun !== "undefined" ? "Bun " + Bun.version + (Bun.isStandaloneExecutable ? " (standalone exe)" : "") : "Node " + process.version);
