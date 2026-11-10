const fs = require('fs');
const path = require('path');

// HTML completo do painel admin horizontal
const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Casarão do Luar — Central de Gestão IA</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root {
  --bg: #050508;
  --bg-subtle: #0c0c14;
  --surface: rgba(255,255,255,0.03);
  --surface-hover: rgba(255,255,255,0.06);
  --card: rgba(16,16,24,0.7);
  --card-fallback: #101018;
  --card-border: rgba(255,255,255,0.06);
  --card-border-top: rgba(255,255,255,0.1);
  --border: rgba(255,255,255,0.08);
  --text: #ece9e4;
  --text-secondary: #9a97a0;
  --muted: #5a586a;
  --accent: #d4a053;
  --accent-hover: #e4b063;
  --accent-glow: rgba(212,160,83,0.15);
  --accent-glow-strong: rgba(212,160,83,0.3);
  --accent-subtle-bg: rgba(212,160,83,0.08);
  --accent-subtle-border: rgba(212,160,83,0.18);
  --green: #4ade80;
  --green-glow: rgba(74,222,128,0.2);
  --red: #f87171;
  --red-glow: rgba(248,113,113,0.2);
  --yellow: #fbbf24;
  --yellow-glow: rgba(251,191,36,0.15);
  --font-display: 'Playfair Display', Georgia, serif;
  --font-body: 'Inter', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
  --radius: 16px;
  --radius-sm: 10px;
  --shadow-card: 0 1px 2px rgba(0,0,0,0.5), 0 12px 40px rgba(0,0,0,0.4);
  --shadow-input-focus: 0 0 0 3px var(--accent-glow);
  --blur-card: blur(28px) saturate(1.3);
  --transition: 200ms cubic-bezier(0.4, 0, 0.2, 1);
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: var(--font-body);
  background: var(--bg);
  color: var(--text);
  min-height: 100vh;
  -webkit-font-smoothing: antialiased;
  overflow: hidden;
}
body::before {
  content: '';
  position: fixed;
  top: -20%;
  left: -10%;
  width: 60%;
  height: 60%;
  background: radial-gradient(circle, rgba(212,160,83,0.04) 0%, transparent 70%);
  pointer-events: none;
  z-index: 0;
}
body::after {
  content: '';
  position: fixed;
  bottom: -20%;
  right: -10%;
  width: 50%;
  height: 50%;
  background: radial-gradient(circle, rgba(100,80,160,0.03) 0%, transparent 70%);
  pointer-events: none;
  z-index: 0;
}
.login-wrapper {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 20px;
}
.login-wrapper .card {
  width: 100%;
  max-width: 460px;
  text-align: center;
}
.login-wrapper h1 {
  font-family: var(--font-display);
  font-size: 1.6rem;
  margin-bottom: 8px;
}
.login-wrapper p {
  color: var(--text-secondary);
  font-size: 0.85rem;
  margin-bottom: 28px;
}
.dashboard {
  display: none;
  position: relative;
  z-index: 1;
  height: 100vh;
}
.dashboard.active {
  display: flex;
}
.sidebar {
  width: 260px;
  flex-shrink: 0;
  background: var(--card);
  backdrop-filter: var(--blur-card);
  -webkit-backdrop-filter: var(--blur-card);
  border-right: 1px solid var(--card-border);
  display: flex;
  flex-direction: column;
  padding: 28px 16px;
}
.sidebar-brand {
  font-family: var(--font-display);
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 36px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 10px;
}
.sidebar-nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
}
.nav-item {
  padding: 12px 16px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--text-secondary);
  transition: all var(--transition);
  display: flex;
  align-items: center;
  gap: 12px;
  border: 1px solid transparent;
  user-select: none;
}
.nav-item:hover {
  background: var(--surface-hover);
  color: var(--text);
}
.nav-item.active {
  background: var(--accent-subtle-bg);
  color: var(--accent);
  border-color: var(--accent-subtle-border);
  font-weight: 600;
}
.nav-icon {
  font-size: 1.15em;
  width: 26px;
  text-align: center;
  flex-shrink: 0;
}
.sidebar-footer {
  margin-top: auto;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}
.main-content {
  flex: 1;
  padding: 36px 44px;
  overflow-y: auto;
  height: 100vh;
  scrollbar-width: thin;
  scrollbar-color: rgba(255,255,255,0.08) transparent;
}
.main-content::-webkit-scrollbar { width: 5px; }
.main-content::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 4px; }
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 32px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--border);
}
.page-header h1 {
  font-family: var(--font-display);
  font-size: 1.5rem;
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 14px;
}
.panel-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: 20px;
  margin-bottom: 24px;
}
.card-full { grid-column: 1 / -1; }
.card {
  background: var(--card);
  backdrop-filter: var(--blur-card);
  -webkit-backdrop-filter: var(--blur-card);
  border: 1px solid var(--card-border);
  border-top: 1px solid var(--card-border-top);
  border-radius: var(--radius);
  padding: 28px;
  box-shadow: var(--shadow-card);
  transition: border-color var(--transition);
}
@supports not (backdrop-filter: blur(1px)) { .card { background: var(--card-fallback); } }
.card:hover { border-color: rgba(255,255,255,0.1); }
.card h2 {
  font-family: var(--font-display);
  font-size: 1rem;
  font-weight: 700;
  margin-bottom: 20px;
  display: flex;
  align-items: center;
  gap: 10px;
}
.status-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 18px 22px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  margin-bottom: 20px;
}
.dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  flex-shrink: 0;
  position: relative;
  transition: all 300ms ease;
}
.dot.on { background: var(--green); box-shadow: 0 0 12px var(--green-glow), 0 0 4px var(--green); }
.dot.on::after {
  content: '';
  position: absolute;
  inset: -4px;
  border-radius: 50%;
  border: 1px solid rgba(74,222,128,0.3);
  animation: pulse-ring 2s ease-out infinite;
}
.dot.off { background: var(--red); box-shadow: 0 0 12px var(--red-glow); }
.dot.unknown { background: var(--yellow); box-shadow: 0 0 8px var(--yellow-glow); animation: blink 1.5s ease-in-out infinite; }
@keyframes pulse-ring { 0% { transform: scale(1); opacity: 1; } 100% { transform: scale(1.8); opacity: 0; } }
@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
.status-text { font-size: 0.9rem; font-weight: 600; }
.status-sub { font-size: 0.72rem; color: var(--muted); margin-top: 3px; }
button {
  padding: 12px 22px;
  border: none;