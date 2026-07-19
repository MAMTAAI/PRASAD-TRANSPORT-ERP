// 🧪 normCompany/companyMatches test — the real DB variants must all match.
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const OUT = path.join(__dirname, '..', 'node_modules', '.cache', 'company.test.cjs');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
execSync(`npx esbuild src/lib/company.ts --bundle --platform=node --format=cjs --outfile="${OUT}"`, { cwd: path.join(__dirname, '..'), stdio: 'pipe' });
const C = require(OUT);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} = ${got}${ok ? '' : ` (want ${want})`}`);
  ok ? pass++ : fail++;
};

// Real variants from the DB audit (2026-07-19)
check('M/S == plain', C.sameCompany('M/S PRASAD TRANSPORT', 'PRASAD TRANSPORT'), true);
check('Pvt Ltd == plain', C.sameCompany('Prasad Transport Pvt Ltd', 'PRASAD TRANSPORT'), true);
check('trailing spaces', C.sameCompany('JAISWAL ENTERPRISE ', 'M/S JAISWAL ENTERPRISE  '), true);
check('different companies differ', C.sameCompany('M/S GAUTAM PRASAD', 'PRASAD TRANSPORT'), false);
check('filter ALL passes all', C.companyMatches('M/S GAUTAM PRASAD', 'ALL'), true);
check('blank record never hidden', C.companyMatches('', 'M/S PRASAD TRANSPORT'), true);
check('record ALL never hidden', C.companyMatches('ALL', 'JAISWAL ENTERPRISE'), true);
check('toll vs trip company', C.companyMatches('JAISWAL ENTERPRISE', 'M/S JAISWAL ENTERPRISE'), true);
check('mismatch still blocked', C.companyMatches('M/S GAUTAM PRASAD', 'M/S JAISWAL ENTERPRISE'), false);

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
