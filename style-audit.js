#!/usr/bin/env node
/**
 * style-audit.js — Auditoría de estilos computados del dashboard admin @393px.
 * Detecta: colores legacy (magenta #b300ff / rgba(179,0,255)) vs tema (#9d4edd),
 * tamaños de fuente, espaciados, alturas de tarjetas, estructura del header.
 */
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = 'http://localhost:8080';
const SUPABASE_URL = 'https://dfcfimipkfhitlsyixqu.supabase.co';
const KEY = fs.readFileSync('/tmp/agendapro-key-clean.txt', 'utf8').trim();

async function loginREST(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error('login fail ' + res.status);
  return res.json();
}

(async () => {
  const s = await loginREST('admin@demo.com', 'demo123');
  const u = s.user, meta = u.user_metadata || {};
  const ud = JSON.stringify({ id: u.id, nombre: meta.nombre || 'Admin', email: u.email, rol: meta.rol || 'admin', tenant_id: meta.tenant_id, whatsapp: meta.whatsapp || '' });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 13; 22111317G Build/TKQ1.220829.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' });
  await ctx.addInitScript(([at, rt, ud]) => {
    localStorage.setItem('agendapro_access_token', at);
    localStorage.setItem('agendapro_refresh_token', rt);
    localStorage.setItem('agendapro_user_data', ud);
  }, [s.access_token, s.refresh_token, ud]);
  const page = await ctx.newPage();
  let enAdmin = false;
  for (let i = 1; i <= 4 && !enAdmin; i++) {
    await page.goto(`${BASE}/admin.html`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);
    enAdmin = await page.evaluate(() => !!document.querySelector('.admin-screen'));
    if (!enAdmin) {
      await page.evaluate(([at, rt, ud]) => { localStorage.setItem('agendapro_access_token', at); localStorage.setItem('agendapro_refresh_token', rt); localStorage.setItem('agendapro_user_data', ud); location.reload(); }, [s.access_token, s.refresh_token, ud]);
      await page.waitForTimeout(5000);
      enAdmin = await page.evaluate(() => !!document.querySelector('.admin-screen'));
    }
  }
  if (!enAdmin) { console.log('no admin'); await browser.close(); process.exit(1); }
  await page.waitForTimeout(4000);

  const report = await page.evaluate(() => {
    const cs = (el) => el ? getComputedStyle(el) : null;
    const info = (el) => {
      if (!el) return null;
      const st = cs(el);
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(), id: el.id || '', cls: (el.className || '').toString().slice(0, 40),
        w: Math.round(r.width), h: Math.round(r.height),
        fontSize: st.fontSize, color: st.color, bg: st.backgroundColor,
        bgImage: (st.backgroundImage || '').slice(0, 80),
        border: st.borderTopColor + ' ' + st.borderTopWidth + ' ' + st.borderTopStyle,
        radius: st.borderRadius, padding: st.padding, margin: st.margin, gap: st.gap,
        display: st.display, flexDir: st.flexDirection,
        fontW: st.fontWeight, lineH: st.lineHeight,
        textAlign: st.textAlign,
      };
    };
    const out = {};

    // Header
    out.header = info(document.querySelector('.admin-header'));
    out.headerLeft = info(document.querySelector('.admin-header .header-left'));
    out.headerH1 = info(document.querySelector('.admin-header h1'));
    out.headerRight = info(document.querySelector('.admin-header .header-right'));
    out.verCliente = info(document.querySelector('.admin-header .header-right > .btn-grad'));
    out.userInfo = info(document.querySelector('.admin-header .user-info'));
    out.sidebarToggle = info(document.querySelector('#sidebar-toggle'));
    out.notifBtn = info(document.querySelector('.notif-bell-btn'));

    // Stats
    out.statsContainer = info(document.querySelector('.stats-container'));
    const statBox = document.querySelector('.stat-box');
    out.statBox = info(statBox);
    out.statBoxIcon = info(statBox ? statBox.querySelector('.stat-icon') : null);
    out.statBoxH2 = info(statBox ? statBox.querySelector('h2') : null);
    out.statBoxSpan = info(statBox ? statBox.querySelector('span') : null);

    // Triple stats
    out.tripleStats = info(document.querySelector('.triple-stats'));
    const triple = document.querySelector('.triple-stats .stat-card, .triple-stats > div');
    out.tripleCard = info(triple);

    // Secciones principales
    out.main = info(document.querySelector('.admin-main'));
    out.sectionTitles = Array.from(document.querySelectorAll('.admin-screen h3, .admin-screen .section-title, .admin-screen h2')).slice(0, 3).map(el => ({
      txt: el.textContent.trim().slice(0, 40), ...info(el),
    }));

    // Botones principales
    out.btnGrad = info(document.querySelector('.btn-grad'));
    out.btnSecondary = info(document.querySelector('.btn-secondary'));

    // Legado magenta en estilos computados visibles
    const magenta = [];
    document.querySelectorAll('.admin-screen *').forEach((el) => {
      const st = cs(el);
      const vals = [st.color, st.backgroundColor, st.borderTopColor, st.boxShadow || ''];
      if (vals.some(v => /b300ff|179\s*,\s*0\s*,\s*255|rgba?\(179/i.test(v || ''))) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && el.offsetParent !== null) {
          magenta.push({ cls: (el.className || '').toString().slice(0, 40), id: el.id || '', prop: vals.find(v => /b300ff|179/.test(v || '')).slice(0, 60) });
        }
      }
    });
    out.magentaLegacy = magenta.slice(0, 15);

    // Root vars
    const root = getComputedStyle(document.documentElement);
    out.rootVars = {
      primary: root.getPropertyValue('--primary-color').trim(),
      primaryDark: root.getPropertyValue('--primary-dark').trim(),
      success: root.getPropertyValue('--success-color').trim(),
      danger: root.getPropertyValue('--danger-color').trim(),
    };
    return out;
  });

  console.log(JSON.stringify(report, null, 1));
  await browser.close();
})();
