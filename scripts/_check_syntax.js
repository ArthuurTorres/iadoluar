const fs = require('fs');
const content = fs.readFileSync('src/utils/context.js', 'utf8');
const lines = content.split('\n');

// Check backtick balance line by line
let inTemplate = false;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  for (let j = 0; j < line.length; j++) {
    if (line[j] === '`' && (j === 0 || line[j-1] !== '\\')) {
      inTemplate = !inTemplate;
    }
  }
}
console.log('inTemplate_final=' + inTemplate);

// Check brace depth ignoring strings/templates/comments
let depth = 0;
let inSingleQuote = false;
let inDoubleQuote = false;
let inTpl = false;
let inLineComment = false;
let inBlockComment = false;

for (let i = 0; i < content.length; i++) {
  const ch = content[i];
  const next = content[i+1] || '';
  
  if (inLineComment) {
    if (ch === '\n') inLineComment = false;
    continue;
  }
  if (inBlockComment) {
    if (ch === '*' && next === '/') { inBlockComment = false; i++; }
    continue;
  }
  if (inSingleQuote) {
    if (ch === "'" && content[i-1] !== '\\') inSingleQuote = false;
    continue;
  }
  if (inDoubleQuote) {
    if (ch === '"' && content[i-1] !== '\\') inDoubleQuote = false;
    continue;
  }
  if (inTpl) {
    if (ch === '`' && content[i-1] !== '\\') inTpl = false;
    continue;
  }
  
  if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
  if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
  if (ch === "'") { inSingleQuote = true; continue; }
  if (ch === '"') { inDoubleQuote = true; continue; }
  if (ch === '`') { inTpl = true; continue; }
  
  if (ch === '{') depth++;
  if (ch === '}') depth--;
}

console.log('final_depth=' + depth);
console.log('inSingleQuote=' + inSingleQuote);
console.log('inDoubleQuote=' + inDoubleQuote);
console.log('inTpl=' + inTpl);
console.log('inBlockComment=' + inBlockComment);