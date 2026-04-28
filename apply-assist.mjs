#!/usr/bin/env node

import { existsSync, readFileSync } from 'fs';
import { chromium } from 'playwright';
import yaml from 'js-yaml';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  printHelp();
  process.exit(0);
}

const url = getArgValue('--url', '');
const headless = args.includes('--headless');
const dryRun = args.includes('--dry-run');
const profilePath = getArgValue('--profile', 'config/profile.yml');
const whyThisRole = getArgValue('--why-role', 'I am excited by this role because it aligns with my technical background and lets me deliver measurable impact quickly.');
const whyThisCompany = getArgValue('--why-company', 'I am interested in this company because of its mission, technical rigor, and the opportunity to solve meaningful problems with strong teams.');

if (!url) {
  console.error('❌ Missing required --url argument.');
  printHelp();
  process.exit(1);
}

if (!existsSync(profilePath)) {
  console.error(`❌ Profile not found: ${profilePath}`);
  process.exit(1);
}

const profile = yaml.load(readFileSync(profilePath, 'utf-8')) || {};
const candidate = profile?.candidate || {};

const fieldValues = {
  full_name: candidate.full_name || '',
  first_name: splitName(candidate.full_name).first,
  last_name: splitName(candidate.full_name).last,
  email: candidate.email || '',
  phone: candidate.phone || '',
  linkedin: normalizeLinkedIn(candidate.linkedin || ''),
  portfolio: candidate.portfolio_url || '',
  github: candidate.github || '',
  location: candidate.location || '',
  why_role: whyThisRole,
  why_company: whyThisCompany,
  additional_info: `I prepare tailored applications with role-specific proof points and measurable outcomes.`,
};

main().catch((err) => {
  console.error(`❌ apply-assist failed: ${err.message}`);
  process.exit(1);
});

async function main() {
  const browser = await chromium.launch({ headless });
  const page = await browser.newPage();

  console.log(`🌐 Opening: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });

  await page.waitForTimeout(1200);

  const fillReport = [];
  fillReport.push(...await fillByLabel(page, ['full name', 'name'], fieldValues.full_name));
  fillReport.push(...await fillByLabel(page, ['first name', 'given name'], fieldValues.first_name));
  fillReport.push(...await fillByLabel(page, ['last name', 'family name', 'surname'], fieldValues.last_name));
  fillReport.push(...await fillByLabel(page, ['email', 'email address'], fieldValues.email));
  fillReport.push(...await fillByLabel(page, ['phone', 'mobile', 'phone number'], fieldValues.phone));
  fillReport.push(...await fillByLabel(page, ['linkedin'], fieldValues.linkedin));
  fillReport.push(...await fillByLabel(page, ['portfolio', 'website', 'personal website'], fieldValues.portfolio));
  fillReport.push(...await fillByLabel(page, ['github'], fieldValues.github));
  fillReport.push(...await fillByLabel(page, ['location', 'city'], fieldValues.location));
  fillReport.push(...await fillByLabel(page, ['why this role', 'why are you interested', 'why do you want this job'], fieldValues.why_role));
  fillReport.push(...await fillByLabel(page, ['why this company', 'why us', 'why do you want to work'], fieldValues.why_company));
  fillReport.push(...await fillByLabel(page, ['additional information', 'anything else', 'cover letter'], fieldValues.additional_info));

  if (!dryRun) {
    await markSubmitButtons(page);
  }

  const successful = fillReport.filter((x) => x.filled).length;
  console.log(`✅ Autofill attempted. Filled ${successful} field(s).`);

  if (fillReport.length > 0) {
    console.log('--- Field report ---');
    for (const item of fillReport) {
      console.log(`- ${item.filled ? 'FILLED' : 'SKIPPED'}: ${item.label}`);
    }
  }

  console.log('🛑 Stopping before submission. Review fields manually, then click submit yourself.');

  if (headless) {
    await browser.close();
  } else {
    console.log('👀 Browser left open for manual review. Press Ctrl+C when done.');
  }
}

async function fillByLabel(page, labelPatterns, value) {
  if (!value) return [];

  return await page.evaluate(({ labelPatterns, value }) => {
    const normalize = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const patterns = labelPatterns.map(normalize);

    const records = [];

    const labels = Array.from(document.querySelectorAll('label'));
    for (const label of labels) {
      const labelText = normalize(label.textContent || '');
      if (!patterns.some((p) => labelText.includes(p))) continue;

      let input = null;
      const htmlFor = label.getAttribute('for');
      if (htmlFor) {
        input = document.getElementById(htmlFor);
      }
      if (!input) {
        input = label.querySelector('input,textarea');
      }
      if (!input) {
        const parent = label.closest('div,fieldset,section,form') || label.parentElement;
        if (parent) {
          input = parent.querySelector('input,textarea');
        }
      }
      if (!input) {
        records.push({ label: labelText, filled: false });
        continue;
      }

      const tag = input.tagName.toLowerCase();
      const type = (input.getAttribute('type') || '').toLowerCase();
      if (tag === 'input' && ['checkbox', 'radio', 'file', 'submit', 'button'].includes(type)) {
        records.push({ label: labelText, filled: false });
        continue;
      }

      input.focus();
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      records.push({ label: labelText, filled: true });
    }

    return records;
  }, { labelPatterns, value });
}

async function markSubmitButtons(page) {
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button,input[type="submit"]'));
    for (const button of buttons) {
      const text = (button.textContent || button.getAttribute('value') || '').toLowerCase();
      if (text.includes('submit') || text.includes('apply') || text.includes('send')) {
        button.style.outline = '3px solid #ff3b30';
        button.style.boxShadow = '0 0 0 4px rgba(255,59,48,0.25)';
        button.setAttribute('title', 'Manual review required. Do not auto-submit.');
      }
    }
  });
}

function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

function normalizeLinkedIn(value) {
  if (!value) return '';
  if (value.startsWith('http://') || value.startsWith('https://')) return value;
  return `https://${value}`;
}

function getArgValue(flag, fallback = '') {
  const pref = `${flag}=`;
  const hit = args.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : fallback;
}

function printHelp() {
  console.log(`Usage:
  node apply-assist.mjs --url=<job application url> [--headless] [--dry-run]

Options:
  --url=...          Required. Application form URL.
  --profile=...      Optional profile path (default: config/profile.yml).
  --why-role=...     Optional custom response for "why this role".
  --why-company=...  Optional custom response for "why this company".
  --headless         Run without visible browser.
  --dry-run          Fill fields but skip submit-button highlighting.
`);
}
