// Verificação visual do painel admin (Playwright).
// Uso: node scripts/check-admin-ui.js
//   APP_URL=http://127.0.0.1:4000 APP_TOK=<token> node scripts/check-admin-ui.js

let chromium;
try {
  chromium = require('playwright').chromium;
} catch (e) {
  console.error('Playwright nao encontrado. Instale com: npm install (devDependencies) e depois npx playwright install chromium');
  process.exit(2);
}

const ok = [], bad = [];
const check = (name, cond, detail) => (cond ? ok : bad).push(`${name}${detail ? ' — ' + detail : ''}`);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1352, height: 850 } });
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto((process.env.APP_URL || 'http://127.0.0.1:4100') + '/admin', { waitUntil: 'networkidle' });

  // ---------- Estado inicial sem autenticação ----------
  const initialAuthState = await page.evaluate(() => {
    const login = document.getElementById('screen-login');
    const panel = document.getElementById('screen-panel');
    if (!login || !panel) return { loginExists: !!login, panelExists: !!panel };
    const loginStyle = getComputedStyle(login);
    const loginRect = login.getBoundingClientRect();
    const loginVisible = loginStyle.display !== 'none'
      && loginStyle.visibility !== 'hidden'
      && Number(loginStyle.opacity) > 0
      && loginRect.width > 0
      && loginRect.height > 0
      && loginRect.right > 0
      && loginRect.bottom > 0
      && loginRect.left < window.innerWidth
      && loginRect.top < window.innerHeight;
    return {
      loginExists: true,
      panelExists: true,
      loginDisplay: loginStyle.display,
      loginVisible,
      panelDisplay: getComputedStyle(panel).display,
      panelActive: panel.classList.contains('active'),
    };
  });
  check('Elementos de autenticação existem', initialAuthState.loginExists && initialAuthState.panelExists);
  check('Login visível sem autenticação', initialAuthState.loginVisible === true,
    'display=' + initialAuthState.loginDisplay + ' visible=' + initialAuthState.loginVisible);
  check('Painel oculto sem autenticação', initialAuthState.panelDisplay === 'none' && !initialAuthState.panelActive,
    'display=' + initialAuthState.panelDisplay + ' active=' + initialAuthState.panelActive);

  await page.fill('#login-token', process.env.APP_TOK || 'devtool');
  await page.click('#btn-login');
  await page.waitForSelector('.dashboard', { state: 'visible', timeout: 10000 });
  await page.waitForTimeout(1500);

  // ---------- Início: grids ----------
  const geo = await page.evaluate(() => {
    const r = (s) => { const e = document.querySelector(s); if (!e) return null; const rr = e.getBoundingClientRect(); return { x: Math.round(rr.x), y: Math.round(rr.y), w: Math.round(rr.width), h: Math.round(rr.height), top: Math.round(rr.top) }; };
    return {
      ai: r('#ai-card') || r('.ai-card'),
      rhythm: r('.rhythm-card'),
      system: r('.system-card'),
      danger: r('.danger-card'),
      g2: r('.home-grid-2'),
    };
  });

  check('Card IA visível', geo.ai !== null, geo.ai ? 'y=' + geo.ai.y + ' h=' + geo.ai.h : 'ausente');
  check('Card Ritmo visível', geo.rhythm !== null, geo.rhythm ? 'y=' + geo.rhythm.y : 'ausente');
  check('IA e Ritmo lado a lado', geo.ai && geo.rhythm && Math.abs(geo.ai.y - geo.rhythm.y) < 8,
    geo.ai && geo.rhythm ? 'ai.y=' + geo.ai.y + ' rhythm.y=' + geo.rhythm.y : '');
  check('Card Sistema visível', geo.system !== null, geo.system ? 'y=' + geo.system.y : 'ausente');
  check('Card Manutenção visível', geo.danger !== null, geo.danger ? 'y=' + geo.danger.y : 'ausente');
  check('Sistema e Manutenção na MESMA linha', geo.system && geo.danger && Math.abs(geo.system.y - geo.danger.y) < 8,
    geo.system && geo.danger ? 'system.y=' + geo.system.y + ' danger.y=' + geo.danger.y : '');
  check('Sistema à direita de Manutenção', geo.system && geo.danger && geo.system.x > geo.danger.x,
    geo.system && geo.danger ? 'danger.x=' + geo.danger.x + ' system.x=' + geo.system.x : '');
  check('Colunas alinhadas entre grids', geo.rhythm && geo.system && Math.abs(geo.rhythm.x - geo.system.x) < 8,
    geo.rhythm && geo.system ? 'rhythm.x=' + geo.rhythm.x + ' system.x=' + geo.system.x : '');
  check('Sem vão gigante entre seções', geo.ai && geo.g2 && (geo.g2.top - (geo.ai.y + geo.ai.h)) < 40,
    geo.ai && geo.g2 ? 'gap=' + (geo.g2.top - (geo.ai.y + geo.ai.h)) + 'px' : '');

  const overlayDisplay = await page.evaluate(() => {
    const e = document.getElementById('rebuild-overlay');
    return e ? getComputedStyle(e).display : 'ausente';
  });
  check('Overlay "Reconstruindo" oculto', overlayDisplay === 'none', 'display=' + overlayDisplay);

  // ---------- Prompt IA ----------
  await page.click('[data-screen="prompt"]');
  await page.waitForTimeout(800);
  const pt = await page.evaluate(() => {
    const main = document.querySelector('.prompt-main');
    const ta = document.getElementById('prompt-textarea');
    const lines = document.querySelector('.editor-lines');
    const m = main ? main.getBoundingClientRect() : null;
    return {
      mainH: m ? Math.round(m.height) : 0,
      mainBottom: m ? Math.round(m.bottom) : 0,
      vh: window.innerHeight,
      taScroll: ta ? ta.scrollHeight : 0,
      taVisible: ta ? Math.round(ta.getBoundingClientRect().height) : 0,
      linesH: lines ? Math.round(lines.getBoundingClientRect().height) : 0,
      abas: document.querySelectorAll('.prompt-tabs button, .seg button').length,
    };
  });
  check('Editor visível', pt.mainH > 100, 'h=' + pt.mainH);
  check('Editor não estoura a viewport', pt.mainBottom <= pt.vh + 2, 'bottom=' + pt.mainBottom + ' vh=' + pt.vh);
  check('Editor rola internamente', pt.taScroll > pt.taVisible * 1.5, 'conteudo=' + pt.taScroll + ' visivel=' + pt.taVisible);
  check('Números de linha não arrastam o card', Math.abs(pt.linesH - pt.taVisible) < 120, 'lines=' + pt.linesH + ' main=' + pt.mainH);
  check('Abas do prompt presentes', pt.abas >= 3, 'abas=' + pt.abas);
  check('Botão salvar prompt existe', (await page.$('#btn-save-prompt')) !== null);
  check('Botão restaurar versão existe', (await page.$('#btn-reset-prompt')) !== null);

  // ---------- Navegação ----------
  for (const par of [['panel', 'view-panel'], ['conversations', 'view-conversations'], ['functions', 'view-functions'], ['prompt', 'view-prompt'], ['llm-config', 'view-llm-config']]) {
    await page.click('[data-screen="' + par[0] + '"]');
    await page.waitForTimeout(600);
    const active = await page.evaluate((id) => {
      const el = document.getElementById(id);
      return el ? el.classList.contains('active') : false;
    }, par[1]);
    check('Tela ativa: ' + par[0], active === true);
  }

  // ---------- Mobile ----------
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  for (const nav of ['panel', 'conversations', 'functions', 'prompt', 'llm-config']) {
    await page.click('[data-screen="' + nav + '"]');
    await page.waitForTimeout(500);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('Sem overflow mobile: ' + nav, over <= 2, 'overflow=' + over + 'px');
  }

  check('Zero erros de console', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();

  console.log('=== OK (' + ok.length + ') ===');
  ok.forEach((o) => console.log('  OK ' + o));
  if (bad.length) {
    console.log('\n=== FALHAS (' + bad.length + ') ===');
    bad.forEach((b) => console.log('  XX ' + b));
  }
  console.log(bad.length === 0 ? '\nTUDO OK' : '\n' + bad.length + ' FALHA(S)');
  process.exit(bad.length === 0 ? 0 : 1);
})();