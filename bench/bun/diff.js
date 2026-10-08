const fs = require("fs");
const ROOT = process.argv[2];
const rt = typeof Bun !== "undefined" ? "Bun" : "Node";
const failed = [], kinds = {};
const stack = [ROOT];
while (stack.length) {
  const dir = stack.pop();
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { failed.push(dir + " :: " + e.code); continue; }
  for (const e of ents) {
    const k = e.isDirectory() ? "dir" : e.isSymbolicLink() ? "link" : e.isFile() ? "file" : "other";
    kinds[k] = (kinds[k] || 0) + 1;
    if (e.isDirectory()) stack.push(dir + "\\" + e.name);
  }
}
console.log(rt, JSON.stringify(kinds), "readdir failures:", failed.length);
for (const f of failed.slice(0, 8)) console.log("  ", f);
