const fs = require("fs");
const ROOT = process.argv[2] ?? "C:\\Windows\\System32";
function nodeWalk(root) {
  let files = 0, dirs = 0, bytes = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = dir + "\\" + e.name;
      if (e.isDirectory()) { dirs++; stack.push(p); }
      else if (e.isSymbolicLink()) { files++; }
      else { files++; try { bytes += fs.lstatSync(p).size; } catch {} }
    }
  }
  return { files, dirs, bytes };
}
function recursiveNames(root) {
  try { return { entries: fs.readdirSync(root, { recursive: true }).length }; } catch (e) { return { err: e.code }; }
}
console.log("Node", process.version, "root", ROOT);
for (let rep = 0; rep < 2; rep++) {
  for (const [label, fn] of [["node:fs readdir+lstat (names+sizes)", nodeWalk], ["fs.readdirSync recursive (names only)", recursiveNames]]) {
    const t = performance.now();
    const r = fn(ROOT);
    console.log(`rep${rep} ${label}: ${(performance.now() - t).toFixed(0)} ms`, JSON.stringify(r));
  }
}
