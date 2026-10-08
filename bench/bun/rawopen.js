const fs = require("fs");
const rt = typeof Bun !== "undefined" ? "Bun " + Bun.version : "Node " + process.version;
for (const p of ["\\\\.\\C:", "\\\\?\\C:", "\\\\.\\PhysicalDrive0", "\\\\.\\C:\\$MFT", "C:\\$MFT"]) {
  try {
    const fd = fs.openSync(p, "r");
    console.log(rt, JSON.stringify(p), "-> fd", fd);
    fs.closeSync(fd);
  } catch (e) {
    console.log(rt, JSON.stringify(p), "->", e.code, e.message);
  }
}
