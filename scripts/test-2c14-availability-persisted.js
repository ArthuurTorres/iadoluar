#!/usr/bin/env node
// 2C.14 — Todo caminho que consulta a HospedInn e ENTREGA a lista de suítes precisa registrar
// os parâmetros em lastAvailability. Caso real (10/11/2026, 22:29): a lista saiu pelo caminho
// "LLM promised a check", nada foi persistido, e a mensagem seguinte ("gostei do foguete") caiu
// na LLM em vez de cotar. O mesmo valia para a confirmação após promessa.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'orchestrator.js'), 'utf8');
const lines = src.split('\n');

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`); }
}

console.log('=== 2C.14: disponibilidade entregue sempre persistida ===\n');

// 1) Todo `await checkAvailability(` seguido de entrega precisa de persistResult de availability
//    antes do encerramento daquele ramo (próximo `return { type:` do mesmo nível de indentação).
// Linha comentada não conta: sem isso o teste passaria com a gravação desligada.
const isCode = (l) => !/^\s*\/\//.test(l);
const callLines = [];
lines.forEach((l, i) => { if (isCode(l) && /await\s+checkAvailability\s*\(/.test(l)) callLines.push(i); });
check('há chamadas de checkAvailability no arquivo', callLines.length > 0, `${callLines.length}`);

for (const idx of callLines) {
  const indent = lines[idx].search(/\S/);
  let persisted = false;
  for (let j = idx + 1; j < lines.length; j++) {
    const l = lines[j];
    if (new RegExp(`^\\s{0,${indent}}return\\s`).test(l) && j > idx + 1) break;
    if (isCode(l) && /persistResult\s*\(\s*phoneNumber\s*,\s*'availability'/.test(l)) { persisted = true; break; }
    // saiu do bloco (indentação menor sem ser fechamento) — não conta mais
    const cur = l.search(/\S/);
    if (cur !== -1 && cur < indent && !/^\s*[})]/.test(l)) break;
  }
  check(`linha ${idx + 1}: consulta seguida de persistResult('availability')`, persisted,
    persisted ? undefined : 'a lista sairia sem lastAvailability e a cotação seguinte não a encontraria');
}

// 2) A disponibilidade persistida precisa ir com o formato que a cotação lê (checkIn/checkOut).
//    A chamada pode ser multilinha: junta a partir do início até o fechamento do objeto.
const availabilityStart = [];
lines.forEach((l, i) => { if (isCode(l) && /persistResult\s*\(\s*phoneNumber\s*,\s*'availability'/.test(l)) availabilityStart.push(i); });
const availabilityPersistsOk = availabilityStart.map(i => {
  let acc = lines[i];
  for (let j = i + 1; j < Math.min(i + 8, lines.length) && !/\)\s*;?\s*$/.test(acc); j++) acc += ' ' + lines[j];
  return { line: i + 1, ok: (/checkIn\s*:/.test(acc) && /checkOut\s*:/.test(acc)) || /'availability',\s*currentParams/.test(acc) };
});
const badPersists = availabilityPersistsOk.filter(p => !p.ok).map(p => p.line);
check('todas as gravações levam checkIn/checkOut', badPersists.length === 0,
  badPersists.length ? `sem datas nas linhas ${badPersists.join(', ')}` : `${availabilityPersistsOk.length} chamadas`);

// 3) A cotação lê os parâmetros de state.lastAvailability.params.
check('cotação lê lastAvailability.params',
  /state\.lastAvailability\s*\?\s*state\.lastAvailability\.params/.test(src));

// 4) Caminho da confirmação pós-promessa: a gravação vem ANTES de entregar a lista.
const promisePersist = lines.findIndex(l => isCode(l) && /promisedValidation\.checkIn/.test(l) && /persistResult/.test(l));
const promiseReply = lines.findIndex(l => /const promisedReply\s*=/.test(l));
check('promessa: persistResult antes de montar a resposta',
  promisePersist !== -1 && promiseReply !== -1 && promisePersist < promiseReply,
  `persist=${promisePersist + 1} reply=${promiseReply + 1}`);

console.log(`\nResultados: ${pass} passaram, ${fail} falharam`);
console.log(fail === 0 ? '\nTUDO OK' : '\nFALHOU');
process.exit(fail === 0 ? 0 : 1);
