const fs = require('fs');
const c = fs.readFileSync('src/utils/context.js', 'utf8');
const lines = c.split('\n');

// Track brace depth line by line, ignoring strings/templates/comments
let d = 0;
let inSQ = false, inDQ = false, inTpl = false, inLC = false, inBC = false;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const prevD = d;
  
  for (let j = 0; j < line.length; j++) {
    const ch = line[j];
    const nx = line[j + 1] || '';
    const prev = j > 0 ? line[j - 1] : '';
    
    if (inLC) { if (ch === '\n' || j === line.length - 1) inLC = false; continue; }
    if (inBC) { if (ch === '*' && nx === '/') { inBC = false; j++; } continue; }
    if (inSQ) { if (ch === "'" && prev !== '\\') inSQ = false; continue; }
    if (inDQ) { if (ch === '"' && prev !== '\\') inDQ = false; continue; }
    if (inTpl) { if (ch === '`' && prev !== '\\') inTpl = false; continue; }
    
    if (ch === '/' && nx === '/') { inLC = true; j++; continue; }
    if (ch === '/' && nx === '*') { inBC = true; j++; continue; }
    if (ch === "'") inSQ = true;
    if (ch === '"') inDQ = true;
    if (ch === '`') inTpl = true;
    
    if (!inSQ && !inDQ && !inTpl && !inLC && !inBC) {
      if (ch === '{') d++;
      if (ch === '}') d--;
    }
  }
  
  // Print lines where depth changes, focusing on transitions
  if (d !== prevD || (i >= 75 && i <= 95)) {
    console.log((i+1) + '\tdepth=' + d + '\t(prev=' + prevD + ')\t' + line.substring(0, 80));
  }
}

console.log('\nFINAL_DEPTH=' + d);
if (d !== 0) {
  console.log('ERROR: Unmatched braces detected. Depth should be 0 at end of file.');
}